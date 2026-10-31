import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { scratchpadInstructionContent } from "./context-management.js";
import { expandRemoteCompactionPayload, MAX_COMPACTION_ITEM_BYTES, MAX_SSE_BYTES } from "./protocol.js";
import { RecoveryOutput } from "./recovery-output.js";
import {
  abortError,
  assertPreparedInput,
  compactionReasoningEffort,
  isJsonObject,
  type RemoteCompactionRequest,
} from "./remote-types.js";
import { formatSummaryFilePaths } from "./summary-file-paths.js";

export const RECOVERY_INSTRUCTION =
  "Summarize the preceding conversation and encrypted checkpoint into a plaintext continuation checkpoint. Preserve user goals, constraints, decisions, completed work, pending tasks, and relevant file paths. Do not continue the task, call tools, or emit another encrypted checkpoint. Later retained messages are provided separately by the client.";

export function summaryPrefix(
  messages: AgentMessage[],
  kept: AgentMessage[],
  fingerprint: (message: AgentMessage) => string,
): AgentMessage[] {
  if (kept.length > messages.length) throw new Error("Checkpoint recovery cut point cannot be projected safely");
  const prefixLength = messages.length - kept.length;
  if (!kept.every((message, index) => fingerprint(message) === fingerprint(messages[prefixLength + index]))) {
    throw new Error("Checkpoint recovery retained tail does not match the active context");
  }
  return messages.slice(0, prefixLength);
}

// This is an inference request, not another remote compaction protocol. The caller
// owns the lossy native-fallback policy after this request releases its resources.
export async function summarizeCheckpoint(
  request: RemoteCompactionRequest,
  options: { maxTokens: number; customInstructions?: string; textSummary?: boolean },
) {
  if (!request.priorCheckpoint && !options.textSummary)
    throw new Error("Checkpoint recovery requires a compatible checkpoint");
  if (request.signal.aborted) throw abortError();
  const diagnostics = request.diagnostics;
  if (diagnostics) diagnostics.phase = "request";
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timer = setTimeout(() => {
    if (diagnostics) diagnostics.deadline = true;
    controller.abort(new Error("Checkpoint recovery timed out"));
  }, request.requestTimeoutMs ?? 300_000);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener("abort", abortListener, { once: true });
  });
  // Synchronous provider failures can occur before the collection race is installed.
  void aborted.catch(() => undefined);
  let stream: AssistantMessageEventStream | undefined;
  let payloadSeen = false;
  let successes = 0;
  const output = new RecoveryOutput();
  const baseFetch = request.fetch ?? globalThis.fetch;
  const cleanupSignals: (() => void)[] = [];
  try {
    stream = request.provider.stream(request.model, normalizeContext(request.context), {
      apiKey: request.apiKey,
      reasoningEffort: compactionReasoningEffort(request),
      ...(options.textSummary ? { sessionId: request.sessionId } : {}),
      headers: request.headers,
      env: request.env,
      signal,
      transport: "sse",
      ...(options.textSummary ? {} : { cacheRetention: "none" as const }),
      maxTokens: options.maxTokens,
      maxRetries: request.maxRetries,
      timeoutMs: request.requestTimeoutMs,
      fetch: async (input, init) => {
        const attempt = diagnostics?.beginAttempt() ?? 0;
        const providerSignals = [
          ...(init?.signal ? [init.signal] : []),
          ...(input instanceof Request ? [input.signal] : []),
        ];
        const providerSignal = providerSignals.length ? AbortSignal.any(providerSignals) : undefined;
        const markProviderAbort = () => {
          diagnostics?.providerAborted(attempt);
        };
        if (providerSignal?.aborted) markProviderAbort();
        providerSignal?.addEventListener("abort", markProviderAbort, { once: true });
        cleanupSignals.push(() => providerSignal?.removeEventListener("abort", markProviderAbort));
        const response = await baseFetch(input, {
          ...init,
          signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
        });
        diagnostics?.headers(response, attempt);
        if (signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw abortError();
        }
        if (!response.body) return response;
        if (response.ok) successes += 1;
        let bytes = 0;
        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, destination) {
            diagnostics?.chunk(chunk.byteLength, attempt);
            bytes += chunk.byteLength;
            if (bytes > MAX_SSE_BYTES) throw new Error("Checkpoint recovery stream exceeded the size limit");
            destination.enqueue(chunk);
          },
          flush() {
            diagnostics?.end(attempt);
          },
        });
        // One pipe, no tee or additional reader. Rejection may be upstream failure
        // or downstream parser cancellation, so do not mislabel it as a network error.
        void response.body.pipeTo(transform.writable, { signal }).catch(() => {
          diagnostics?.pipeError(attempt, signal.aborted);
        });
        return new Response(transform.readable, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      onPayload: (payload) => {
        if (signal.aborted) throw abortError();
        const expanded = expandRemoteCompactionPayload(payload, request.priorCheckpoint);
        const input = assertPreparedInput(expanded);
        if (input.some((item) => item.type === "compaction_trigger"))
          throw new Error("Recovery input contains a compaction trigger");
        const prepared: Record<string, unknown> = {
          ...expanded,
          input: [
            ...input,
            {
              role: "user",
              content: scratchpadInstructionContent(
                (options.textSummary
                  ? RECOVERY_INSTRUCTION.replace(" and encrypted checkpoint", "")
                  : RECOVERY_INSTRUCTION) +
                  (options.customInstructions ? `\nAdditional focus: ${options.customInstructions}` : ""),
                request,
              ),
            },
          ],
          ...(options.textSummary ? {} : { tools: [] }),
          tool_choice: "none",
          store: false,
          stream: true,
        };
        delete prepared.context_management;
        delete prepared.previous_response_id;
        // Image-heavy conversation inputs can exceed the response-stream budget.
        // Keep that bound on received bytes, not on the provider's outgoing payload.
        diagnostics?.payload(prepared);
        payloadSeen = true;
        return prepared;
      },
      onProviderStreamEvent: (raw) => {
        diagnostics?.observe(raw);
        if (!isJsonObject(raw)) return;
        output.observe(raw);
      },
    });
    const activeStream = stream;
    const collect = async () => {
      let completed: AssistantMessage | undefined;
      for await (const item of activeStream) {
        if (signal.aborted) throw abortError();
        if (item.type === "error") throw new Error(item.error.errorMessage ?? "Checkpoint recovery failed");
        if (item.type === "done") {
          if (
            completed ||
            item.reason !== "stop" ||
            item.message.stopReason !== "stop" ||
            item.message.content.some((block) => block.type !== "text" && block.type !== "thinking")
          )
            throw new Error("Unsafe checkpoint recovery completion");
          completed = item.message;
        }
      }
      if (!completed || !payloadSeen || successes !== 1 || !output.terminalSeen)
        throw new Error("Checkpoint recovery ended without validated completion");
      const summary = completed.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      if (diagnostics) diagnostics.phase = "validation";
      output.assertMatches(summary);
      if (!summary.trim() || Buffer.byteLength(summary) > MAX_COMPACTION_ITEM_BYTES)
        throw new Error("Checkpoint recovery returned an empty or oversized summary");
      return { summary, usage: completed.usage };
    };
    return await Promise.race([collect(), aborted]);
  } finally {
    if (diagnostics) {
      diagnostics.callerAbort = request.signal.aborted;
      diagnostics.seal();
    }
    for (const cleanup of cleanupSignals) cleanup();
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    controller.abort();
    // Unblock our consumer even if a custom provider ignores the abort signal.
    stream?.end();
  }
}

export async function recoverCheckpoint(
  request: RemoteCompactionRequest,
  event: SessionBeforeCompactEvent,
  textSummary = false,
  filePathRoot?: string,
) {
  const result = await summarizeCheckpoint(request, {
    maxTokens: Math.max(
      1,
      Math.min(
        Math.floor((event.preparation.settings.reserveTokens || (textSummary ? 16_000 : 0)) * 0.8),
        ...(textSummary ? [Math.floor(request.model.contextWindow / 4)] : []),
        request.model.maxTokens > 0 ? request.model.maxTokens : Number.POSITIVE_INFINITY,
      ),
    ),
    customInstructions: event.customInstructions,
    textSummary,
  });
  const modifiedFiles = [
    ...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited]),
  ].sort();
  const readFiles = [...event.preparation.fileOps.read].filter((path) => !modifiedFiles.includes(path)).sort();
  const summary =
    result.summary +
    (textSummary
      ? formatSummaryFilePaths(readFiles, modifiedFiles, filePathRoot)
      : (readFiles.length ? `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>` : "") +
        (modifiedFiles.length ? `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : ""));
  if (Buffer.byteLength(summary) > MAX_COMPACTION_ITEM_BYTES)
    throw new Error("Checkpoint recovery summary and file metadata exceeded the size limit");
  return {
    summary,
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    usage: result.usage,
    details: { readFiles, modifiedFiles },
  };
}
