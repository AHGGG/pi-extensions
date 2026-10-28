import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  estimateTokens,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { abortable } from "./abortable.js";
import { checkpointMarker, fingerprintMessage, hasActiveCheckpointClaim, latestCheckpoint } from "./checkpoint.js";
import { projectedKeptMessages } from "./checkpoint-projection.js";
import { recoverCheckpoint, summaryPrefix } from "./checkpoint-recovery.js";
import { resolveCompactionBinding } from "./compaction-binding.js";
import { activeTools, type CompactionOperationOptions, projectedCurrentMessages } from "./compaction-operation.js";
import { captureCompactionBranch } from "./compaction-ownership.js";
import { resolveCompactionRoute } from "./model-api.js";
import { preparationFailureDetail } from "./preparation-failure.js";
import { abortError } from "./remote-types.js";
import { RequestDiagnostics } from "./request-diagnostics.js";
import { captureScratchpadForCompaction } from "./scratchpad-compaction.js";
import type { CodexCompactSettings } from "./settings.js";
import { createTextSummaryDetails, matchedToolPairs, summaryFileOps, textSummaryReserve } from "./text-summary.js";

/** Direct text inference. Failure never falls through to a second compaction policy. */
export async function compactToText(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: CodexCompactSettings,
  ownerSignal: AbortSignal,
  isCurrent: () => boolean,
  ownsStatus: () => boolean,
  fetch?: typeof globalThis.fetch,
  options: CompactionOperationOptions = {},
) {
  const model = ctx.model;
  if (!settings.enabled) return undefined;
  const signal = AbortSignal.any([
    ownerSignal,
    event.signal,
    ...(options.deadlineSignal ? [options.deadlineSignal] : []),
  ]);
  if (signal.aborted) return { cancel: true };
  const route = resolveCompactionRoute(model, settings);
  if (!model || route.kind !== "remote") {
    if (ctx.hasUI) ctx.ui.notify("Text summary requires a supported Responses provider; history preserved.", "warning");
    return { cancel: true };
  }
  const sessionId = ctx.sessionManager.getSessionId();
  const systemPrompt = ctx.getSystemPrompt();
  const tools = activeTools(pi);
  const toolsKey = JSON.stringify([pi.getActiveTools(), tools]);
  const branchCurrent = options.preparation?.branchIsCurrent ?? captureCompactionBranch(event.branchEntries);
  const valid = () =>
    !signal.aborted &&
    isCurrent() &&
    ctx.sessionManager.getSessionId() === sessionId &&
    ctx.getSystemPrompt() === systemPrompt &&
    JSON.stringify([pi.getActiveTools(), activeTools(pi)]) === toolsKey &&
    branchCurrent(ctx.sessionManager.getBranch());
  const diagnostics = new RequestDiagnostics();
  diagnostics.configure(settings.protocol, undefined, false, "text-summary");
  options.onDiagnostics?.(diagnostics);
  let secrets: string[] = [];
  diagnostics.requestPolicy(settings.requestTimeoutMs, settings.maxRetries, () => secrets);
  const deadline = () => {
    diagnostics.deadline = true;
  };
  options.deadlineSignal?.addEventListener("abort", deadline, { once: true });
  let outcome: "failed" | "prepared" | "ready" = "failed";
  let failure = "none";
  let validationFailure: string | undefined;
  const invalid = (reason: string): never => {
    validationFailure = reason;
    throw new Error(reason);
  };
  try {
    if (!valid()) return { cancel: true };
    const prior = latestCheckpoint(event.branchEntries);
    if (hasActiveCheckpointClaim(event.branchEntries) && !prior)
      invalid("Existing provider checkpoint is invalid; history preserved");
    // Do not transmit an issuer's encrypted history to a different provider. The
    // existing context-transfer path can convert it before preparing this mode.
    if (prior && prior.details.provider !== model.provider)
      invalid(
        "Switch back to the checkpoint issuing provider before preparing a text summary; encrypted history was not sent",
      );
    const resolved = await abortable(
      diagnostics.wait("binding", () => resolveCompactionBinding(ctx, model, settings, valid, diagnostics)),
      signal,
    );
    if (!valid()) return { cancel: true };
    secrets = [
      resolved.auth.apiKey,
      ...Object.values(resolved.auth.headers ?? {}),
      ...Object.values(resolved.auth.env ?? {}),
    ].filter((value): value is string => typeof value === "string");
    if (options.preparation) options.preparation.attempt.binding = resolved.binding;
    const current = (() => {
      try {
        return projectedCurrentMessages(event, resolved.route);
      } catch {
        return invalid(
          "Existing checkpoint API/profile or history projection is incompatible; restore its issuing route or branch before it",
        );
      }
    })();
    const kept = projectedKeptMessages(
      event.branchEntries,
      event.branchEntries.at(-1)?.id ?? null,
      event.preparation.firstKeptEntryId,
    );
    const messages = summaryPrefix(current.messages, kept, fingerprintMessage);
    if (!messages.length || !matchedToolPairs(messages) || !matchedToolPairs(kept))
      invalid("Text summary cut point cannot preserve complete history and tool pairs; history preserved");
    let scratchpadSnapshot: string | undefined;
    let scratchpadOmittedForSize = false;
    if (settings.scratchpadEnabled && settings.appendMaintenanceMessage) {
      const captured = await abortable(captureScratchpadForCompaction(sessionId, { signal, isCurrent: valid }), signal);
      if (!valid()) return { cancel: true };
      if (captured.kind === "ready") {
        scratchpadSnapshot = captured.text;
        secrets.push(...captured.redactionValues);
        if (captured.mode === "summary-only" && ctx.hasUI && settings.notifyOnFallback)
          ctx.ui.notify(
            "[codex-compact] Normal scratchpad projection exceeded the size limit; text summary uses a summary-only snapshot with explicit markers for items without valid summaries.",
            "warning",
          );
      } else if (captured.kind === "omitted") scratchpadOmittedForSize = true;
      if (captured.kind !== "ready" && ctx.hasUI && settings.notifyOnFallback)
        ctx.ui.notify(
          "[codex-compact] Scratchpad content unavailable or oversized; text summary uses the available conversation and scratchpad notice only.",
          "warning",
        );
    }
    const preparation = {
      ...event.preparation,
      fileOps: summaryFileOps(messages, event.branchEntries),
      settings: {
        ...event.preparation.settings,
        reserveTokens: Math.min(
          textSummaryReserve(model.contextWindow, event.preparation.settings.reserveTokens),
          Math.floor(settings.replacementTokenBudget / 0.8),
        ),
      },
    };
    const outputBudget = Math.min(
      Math.floor(preparation.settings.reserveTokens * 0.8),
      model.maxTokens > 0 ? model.maxTokens : Infinity,
      Math.floor(model.contextWindow / 4),
    );
    if (outputBudget < 128)
      invalid("Model output/context limit is too small for a safe text summary; select a model with more capacity");
    if (ownsStatus()) ctx.ui.setStatus("codex-compact", "Preparing text summary…");
    const compaction = await abortable(
      recoverCheckpoint(
        {
          provider: resolved.provider,
          model,
          profile: resolved.route.profile,
          protocol: resolved.route.protocol,
          context: {
            systemPrompt,
            tools,
            messages: convertToLlm(JSON.parse(JSON.stringify(messages)) as AgentMessage[]),
          },
          apiKey: resolved.auth.apiKey,
          headers: resolved.auth.headers,
          env: resolved.auth.env,
          signal,
          sessionId,
          requestTimeoutMs: settings.requestTimeoutMs,
          maxRetries: settings.maxRetries,
          scratchpadSnapshot,
          scratchpadOmittedForSize,
          diagnostics,
          priorCheckpoint: current.prior
            ? {
                marker: checkpointMarker(current.prior.checkpointId),
                replacementHistory: current.prior.replacementHistory,
              }
            : undefined,
          fetch: async (input, init) => {
            if (!valid()) throw abortError();
            diagnostics.endpoint(input instanceof Request ? input.url : String(input));
            const response = await (fetch ?? globalThis.fetch)(input, init);
            if (!valid()) {
              void response.body?.cancel().catch(() => undefined);
              throw abortError();
            }
            return response;
          },
        },
        { ...event, preparation },
        true,
      ),
      signal,
    );
    if (!valid()) return { cancel: true };
    // Some OAuth adapters omit max_output_tokens. Enforce our local accepted-result
    // budget as well as requesting an output limit from compatible providers.
    const summaryTokens = Math.ceil(compaction.summary.length / 4);
    if (summaryTokens > settings.replacementTokenBudget)
      invalid("Text summary exceeded the configured replacement token budget; history preserved");
    const contextTokens =
      summaryTokens +
      kept.reduce((sum, message) => sum + estimateTokens(message), 0) +
      Math.ceil((systemPrompt.length + toolsKey.length) / 4);
    if (contextTokens >= model.contextWindow - preparation.settings.reserveTokens)
      invalid("Text summary plus retained messages exceeds the model context budget; history preserved");
    outcome = options.preparation ? "prepared" : "ready";
    return { compaction: { ...compaction, details: createTextSummaryDetails(compaction.details) } };
  } catch (error) {
    failure =
      validationFailure ??
      preparationFailureDetail(error, {
        timedOut: diagnostics.deadline,
        remoteAttempted: diagnostics.currentAttempt > 0,
      });
    if (!valid()) return { cancel: true };
    if (options.preparation)
      options.preparation.attempt.failure = {
        diagnostic: `Text summary failed; history preserved. ${failure} [${diagnostics.compact()}]`,
      };
    return { cancel: true };
  } finally {
    diagnostics.callerAbort ||= event.signal.aborted;
    diagnostics.finish(outcome, failure);
    diagnostics.seal();
    const consumerReportsFailure = options.preparation?.failureReportOwner === "consumer" && outcome === "failed";
    if (!consumerReportsFailure && ctx.hasUI && valid()) {
      ctx.ui.notify(
        `[codex-compact] Text summary outcome=${outcome}${outcome === "failed" ? "; compaction cancelled and history preserved" : ""}; ${diagnostics.summary()}${outcome === "failed" ? `\n${diagnostics.report()}` : ""}`,
        outcome === "failed" ? "warning" : "info",
      );
    }
    options.deadlineSignal?.removeEventListener("abort", deadline);
    if (ownsStatus()) ctx.ui.setStatus("codex-compact", undefined);
  }
}
