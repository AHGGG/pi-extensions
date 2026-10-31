import { normalizeContext } from "@earendil-works/pi-ai";
import { abortable } from "./abortable.js";
import {
  COMPACTION_MAINTENANCE_MESSAGE,
  CONTEXT_MANAGEMENT_THRESHOLD,
  createContextManagementCollector,
  scratchpadInstructionContent,
} from "./context-management.js";
import { PrematureCompactionEof, preparationFailureRetryable } from "./preparation-failure.js";
import { CodexCompactionProtocolError, expandRemoteCompactionPayload, MAX_SSE_BYTES } from "./protocol.js";
import { collectProviderUsage } from "./remote-shared.js";
import {
  abortError,
  assertPreparedInput,
  compactionReasoningEffort,
  type RemoteCompactionRequest,
  type RemoteCompactionResponse,
} from "./remote-types.js";

const EOF_RETRY_DELAY_MS = 250;

function isTerminal(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    typeof event.type === "string" &&
    ["response.completed", "response.done", "response.incomplete", "response.failed", "error"].includes(event.type)
  );
}

/** One retry may replace an incomplete stream; both attempts share the original deadline. */
export async function requestContextManagement(request: RemoteCompactionRequest): Promise<RemoteCompactionResponse> {
  if (request.signal.aborted) throw abortError();
  const timeoutMs = request.requestTimeoutMs ?? 300_000;
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timeout = setTimeout(() => {
    if (request.diagnostics) request.diagnostics.deadline = true;
    controller.abort(new Error("Context management request timed out"));
  }, timeoutMs);
  let retryAuth: Pick<RemoteCompactionRequest, "apiKey" | "headers" | "env"> | undefined;
  const assertBudget = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
    // Timers can run late after a busy event loop or an adapter callback. Never dispatch on expired budget.
    if (performance.now() >= deadline) {
      if (request.diagnostics) request.diagnostics.deadline = true;
      const error = new Error("Context management request timed out");
      controller.abort(error);
      throw error;
    }
  };
  try {
    for (let attempt = 0; ; attempt += 1) {
      assertBudget();
      try {
        return await requestAttempt({
          ...request,
          ...(retryAuth ? { apiKey: retryAuth.apiKey, headers: retryAuth.headers, env: retryAuth.env } : {}),
          signal,
          requestTimeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
        });
      } catch (error) {
        // Do not turn protocol rejection, cancellation, or a provider-declared failure into a retry.
        if (!(error instanceof PrematureCompactionEof) || attempt !== 0 || signal.aborted) throw error;
        if (deadline - performance.now() <= EOF_RETRY_DELAY_MS) throw error;
        request.diagnostics?.retryScheduled();
        await retryDelay(signal);
        assertBudget();
        if (request.beforeStreamRetry) retryAuth = (await abortable(request.beforeStreamRetry(), signal)) ?? undefined;
        assertBudget();
      }
    }
  } finally {
    if (request.diagnostics) {
      request.diagnostics.callerAbort = request.signal.aborted;
      request.diagnostics.seal();
    }
    clearTimeout(timeout);
    controller.abort();
  }
}

function retryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, EOF_RETRY_DELAY_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestAttempt(request: RemoteCompactionRequest): Promise<RemoteCompactionResponse> {
  if (request.signal.aborted) throw abortError();
  const diagnostics = request.diagnostics;
  if (diagnostics) diagnostics.phase = "request";
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const collector = createContextManagementCollector();
  let sentInput: ReturnType<typeof assertPreparedInput> | undefined;
  let successes = 0;
  let transportFailure: unknown;
  let cleanEof = false;
  let terminalSeen = false;
  let active = true;
  const baseFetch = request.fetch ?? globalThis.fetch;
  const cleanupSignals: (() => void)[] = [];
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const stream = request.provider.stream(request.model, normalizeContext(request.context), {
      apiKey: request.apiKey,
      reasoningEffort: compactionReasoningEffort(request),
      headers: request.headers,
      env: request.env,
      signal,
      transport: "sse",
      cacheRetention: "none",
      timeoutMs: request.requestTimeoutMs ?? 300_000,
      maxRetries: request.maxRetries ?? 2,
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
        cleanEof = false;
        transportFailure = undefined;
        const response = await baseFetch(input, {
          ...init,
          signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
        }).catch((error: unknown) => {
          if (preparationFailureRetryable(error)) transportFailure = error;
          throw error;
        });
        diagnostics?.headers(response, attempt);
        if (signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw abortError();
        }
        if (!response.body) return response;
        if (response.ok) successes += 1;
        let bytes = 0;
        // A single pipe owns both readers; abort/error cancels upstream without tee deadlocks.
        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, destination) {
            diagnostics?.chunk(chunk.byteLength, attempt);
            bytes += chunk.byteLength;
            if (bytes > MAX_SSE_BYTES)
              throw new CodexCompactionProtocolError("Context management stream exceeded the size limit");
            destination.enqueue(chunk);
          },
          flush() {
            cleanEof = true;
            diagnostics?.end(attempt);
          },
        });
        // One pipe, no tee or additional reader. Rejection may be upstream failure
        // or downstream parser cancellation, so do not mislabel it as a network error.
        void response.body.pipeTo(transform.writable, { signal }).catch((error: unknown) => {
          if (!signal.aborted && preparationFailureRetryable(error)) transportFailure = error;
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
        sentInput = assertPreparedInput(expanded);
        if (sentInput.some((item) => item.type === "compaction_trigger")) {
          throw new CodexCompactionProtocolError("Context management input already contains a compaction trigger");
        }
        const include = expanded.include ?? [];
        if (!Array.isArray(include) || !Array.from(include).every((field) => typeof field === "string")) {
          throw new CodexCompactionProtocolError("Context management provider payload has an invalid include list");
        }
        const prepared = {
          ...expanded,
          // Request stateless reasoning without changing the provider's thinking effort.
          include: include.includes("reasoning.encrypted_content")
            ? [...include]
            : [...include, "reasoning.encrypted_content"],
          input: [
            ...sentInput,
            ...(request.appendMaintenanceMessage === false
              ? []
              : [
                  {
                    role: "user",
                    content: scratchpadInstructionContent(
                      request.maintenanceMessage ?? COMPACTION_MAINTENANCE_MESSAGE,
                      request,
                    ),
                  },
                ]),
          ],
          context_management: [{ type: "compaction", compact_threshold: CONTEXT_MANAGEMENT_THRESHOLD }],
          store: false,
          stream: true,
          tool_choice: "none",
        };
        // Array replay never depends on server-side response state.
        delete (prepared as Record<string, unknown>).previous_response_id;
        diagnostics?.payload(prepared);
        return prepared;
      },
      onProviderStreamEvent: (event) => {
        if (!active || signal.aborted) return;
        if (isTerminal(event)) terminalSeen = true;
        diagnostics?.observe(event);
        request.onProviderStreamEvent?.(event);
        collector.observe(event);
      },
    });
    const usage = await Promise.race([collectProviderUsage(stream, signal), aborted]);
    if (signal.aborted) throw abortError();
    if (!sentInput || successes !== 1) {
      throw new CodexCompactionProtocolError(
        "Provider did not expose exactly one successful context management request",
      );
    }
    if (diagnostics) diagnostics.phase = "validation";
    const replacementHistory = diagnostics
      ? diagnostics.measure("validation", () => collector.finish())
      : collector.finish();
    return { item: replacementHistory[0], replacementHistory, promptInput: sentInput, usage };
  } catch (error) {
    if (!signal.aborted && !terminalSeen && transportFailure) throw transportFailure;
    if (
      !signal.aborted &&
      successes === 1 &&
      cleanEof &&
      !terminalSeen &&
      error instanceof Error &&
      error.message === "OpenAI Responses stream ended before a terminal response event"
    )
      throw new PrematureCompactionEof(error.message);
    throw error;
  } finally {
    active = false;
    for (const cleanup of cleanupSignals) cleanup();
    if (onAbort) signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
