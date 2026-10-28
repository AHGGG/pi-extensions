import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  buildSessionProjection,
  type CompactionEntryDraft,
  type ExtensionAPI,
  type ExtensionContext,
  estimateTokens,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { abortable } from "./abortable.js";
import type { AutoCompactionProtocols } from "./auto-protocol.js";
import { createCheckpointDetails, fallbackSummary, latestCheckpoint, parseCheckpointDetails } from "./checkpoint.js";
import { checkpointKeptMessages, projectSessionCheckpointContext } from "./checkpoint-projection.js";
import { compactionBindingChanges, resolveCompactionBinding, sameCompactionBinding } from "./compaction-binding.js";
import { activeTools, type CompactionAttempt, compactRemotely } from "./compaction-operation.js";
import {
  captureCompactionBranch,
  captureExactCompactionBranch,
  capturePrefixCompactionBranch,
} from "./compaction-ownership.js";
import type { CompactionTimings } from "./compaction-timing.js";
import { type RemoteCompactionProtocol, resolveCompactionRoute } from "./model-api.js";
import type { CheckpointPreparation, PreparedCheckpoint } from "./prepared-compaction-protocol.js";
import { type RejectedRoutes, rejectionRouteKey } from "./rejection-state.js";
import type { RequestDiagnostics } from "./request-diagnostics.js";
import { type CodexCompactSettingsRuntime, compactionSettingsKey } from "./settings.js";

type CompactionResult = Awaited<ReturnType<typeof compactRemotely>>;

function completeToolPairs(messages: AgentMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  return pending.size === 0;
}

/** Capture a provider-bound prefix for later preparation. This does not schedule or start work. */
export function captureCheckpointPreparation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: CodexCompactSettingsRuntime,
  ownerSignal: AbortSignal,
  rejected: RejectedRoutes,
  ownerIsCurrent: () => boolean,
  onRouteResolved: (protocol: RemoteCompactionProtocol) => void,
  fetch?: typeof globalThis.fetch,
  autoProtocols?: AutoCompactionProtocols,
): CheckpointPreparation | undefined {
  const settings = runtime.get().settings;
  const model = ctx.model;
  const route = resolveCompactionRoute(model, settings);
  if (
    !settings.enabled ||
    !model ||
    route.kind !== "remote" ||
    ownerSignal.aborted ||
    rejected.hasObserved(rejectionRouteKey(model, route))
  )
    return undefined;
  const usage = ctx.getContextUsage();
  if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens)) return undefined;
  // Borrow the ancestry for projection, not a second copy of all historical payloads.
  // Guards capture persisted-value digests before any await; compactRemotely isolates
  // only the active provider input. Prepared results retain no copied raw history or
  // serialized history prefix (Pi still owns the original session entries).
  let snapshot: SessionEntry[] | undefined = ctx.sessionManager.getBranch();
  // A provider transfer produces plaintext, not an adoptable opaque preparation.
  // Let the ordinary context/foreground path perform that explicitly instead.
  const checkpoint = latestCheckpoint(snapshot);
  if (checkpoint && checkpoint.details.provider !== model.provider) return undefined;
  // Pi recreates label entries with new IDs when forking. Persist a stable
  // non-label cutoff; guard the full ancestry, including trailing labels.
  const snapshotLeafId = [...snapshot].reverse().find((entry) => entry.type !== "label")?.id;
  let branchFailure: string | undefined;
  const branchIsCurrent = capturePrefixCompactionBranch(snapshot, (reason) => {
    branchFailure = reason;
  });
  if (!branchIsCurrent(snapshot)) return undefined;
  const projection = buildSessionProjection(snapshot, snapshotLeafId ?? null);
  const first = projection.entries.find(({ messages }) => messages.some((message) => message.role !== "system"));
  if (!snapshotLeafId || !first || !completeToolPairs(buildSessionContext(snapshot, snapshotLeafId).messages))
    return undefined;
  const firstKeptEntryId = first.sourceEntry.id;
  const settingsKey = compactionSettingsKey(settings);
  const modelKey = JSON.stringify(model);
  const systemPrompt = ctx.getSystemPrompt();
  const toolsKey = JSON.stringify([pi.getActiveTools(), activeTools(pi)]);
  const thinkingLevel = pi.getThinkingLevel();
  let reason: string | undefined;
  const isCurrent = () => {
    reason = ownerSignal.aborted
      ? "preparation owner was cancelled"
      : !ownerIsCurrent()
        ? "session ownership changed"
        : compactionSettingsKey(runtime.get().settings) !== settingsKey
          ? "compaction settings changed"
          : JSON.stringify(ctx.model) !== modelKey
            ? "model configuration changed"
            : ctx.getSystemPrompt() !== systemPrompt
              ? "system prompt changed"
              : JSON.stringify([pi.getActiveTools(), activeTools(pi)]) !== toolsKey
                ? "active tools or tool definitions changed"
                : pi.getThinkingLevel() !== thinkingLevel
                  ? "thinking level changed"
                  : !branchIsCurrent(ctx.sessionManager.getBranch())
                    ? (branchFailure ?? "session snapshot changed")
                    : undefined;
    return reason === undefined;
  };
  let diagnostics: RequestDiagnostics | undefined;
  return {
    diagnostics: () =>
      diagnostics?.snapshot() ?? { status: "Not started", report: "Checkpoint preparation has not started." },
    requestTimeoutMs: settings.requestTimeoutMs,
    get reason() {
      return reason;
    },
    isCurrent,
    async start(guard) {
      if (!snapshot) throw new Error("A checkpoint preparation may only be started once");
      const entries = snapshot;
      snapshot = undefined;
      const signal = AbortSignal.any([ownerSignal, guard.signal]);
      const valid = () => !signal.aborted && isCurrent() && guard.isCurrent();
      const attempt: CompactionAttempt = {};
      const event: SessionBeforeCompactEvent = {
        type: "session_before_compact",
        branchEntries: entries,
        reason: "threshold",
        willRetry: false,
        signal: guard.signal,
        preparation: {
          firstKeptEntryId,
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: usage.tokens ?? 0,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
        },
      };
      const preparationStarted = performance.now();
      const result = await compactRemotely(
        pi,
        event,
        ctx,
        settings,
        signal,
        rejected,
        valid,
        guard.ownsStatus,
        onRouteResolved,
        fetch,
        {
          autoProtocols,
          preparation: { attempt, branchIsCurrent, failureReportOwner: guard.failureReportOwner },
          deadlineSignal: guard.deadlineSignal,
          onDiagnostics: (value) => {
            diagnostics = value;
          },
        },
      );
      const prepared = createPreparedCheckpoint(
        result,
        performance.now() - preparationStarted,
        attempt,
        snapshotLeafId,
        Math.ceil((systemPrompt.length + toolsKey.length) / 4),
        isCurrent,
        runtime,
      );
      return prepared;
    },
  };
}

interface PreparedData {
  result: CompactionResult;
  preparationMs: number;
  attempt: CompactionAttempt;
  snapshotLeafId: string;
  promptAndToolsTokens: number;
  isCurrent(): boolean;
  validationFailure?: string;
  applicationFailure?: string;
}
function createPreparedCheckpoint(
  result: CompactionResult,
  preparationMs: number,
  attempt: CompactionAttempt,
  snapshotLeafId: string,
  promptAndToolsTokens: number,
  isCurrent: () => boolean,
  runtime: CodexCompactSettingsRuntime,
): PreparedCheckpoint {
  const data: PreparedData = { result, preparationMs, attempt, snapshotLeafId, promptAndToolsTokens, isCurrent };
  const details = result && "compaction" in result ? parseCheckpointDetails(result.compaction?.details) : undefined;
  return {
    checkpointId: details?.checkpointId,
    usable: !!details,
    failure: details ? undefined : (attempt.failure?.diagnostic ?? "checkpoint preparation failed"),
    async adopt(event, ctx, guard) {
      data.validationFailure = undefined;
      data.applicationFailure = undefined;
      const outcome = await adoptPreparedCheckpoint(data, event, ctx, runtime, guard.signal, guard.isCurrent, {
        timings: guard.timings,
      });
      if (outcome.kind === "stale")
        return {
          ...outcome,
          reason: data.validationFailure ?? "checkpoint no longer current",
          failure: !!data.applicationFailure,
        };
      if (outcome.kind === "ready" && outcome.result) return { kind: "ready", result: outcome.result };
      if (outcome.kind === "ready") return { kind: "stale", reason: "prepared result unavailable", failure: true };
      return outcome.kind === "failed" ? { kind: "failed" } : outcome;
    },
    async draft(ctx, guard) {
      const draft = await preparedCheckpointDraft(data, ctx, runtime, guard.signal, guard.isCurrent, {
        timings: guard.timings,
      });
      return {
        draft,
        checkpointId: details?.checkpointId,
        reason: data.validationFailure,
        failure: !!data.applicationFailure,
      };
    },
  };
}
type PreparedAdoption =
  | { kind: "stale" }
  | { kind: "cancel" }
  | { kind: "failed" }
  | { kind: "ready"; result: CompactionResult };

interface PreparedApplicationOptions {
  /** Exact ancestry and working-set guard shared by the boundary, never a cached verdict. */
  exactBranchIsCurrent?: (entries: SessionEntry[]) => boolean;
  timings?: CompactionTimings;
}

/** Validate and rebind an already-produced checkpoint; never perform inference. */
async function adoptPreparedCheckpoint(
  prepared: PreparedData,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  runtime: CodexCompactSettingsRuntime,
  operationSignal: AbortSignal,
  isCurrent: () => boolean,
  options: PreparedApplicationOptions = {},
): Promise<PreparedAdoption> {
  const applicationStarted = performance.now();
  const signal = AbortSignal.any([event.signal, operationSignal]);
  // Exact equality is stronger than the foreground guard (which allows harmless
  // bookkeeping descendants). Reuse its captured digest, not an earlier verdict.
  const adoptionBranchIsCurrent = options.exactBranchIsCurrent ?? captureCompactionBranch(event.branchEntries);
  const stale = (reason: string, failure = false): PreparedAdoption => {
    prepared.validationFailure = reason;
    if (failure) prepared.applicationFailure = reason;
    return { kind: "stale" };
  };
  const validate = () => {
    if (signal.aborted) return false;
    if (!isCurrent()) {
      prepared.validationFailure ??= "application ownership or boundary changed";
      return false;
    }
    if (!prepared.isCurrent()) return false;
    if (!adoptionBranchIsCurrent(ctx.sessionManager.getBranch())) {
      prepared.validationFailure = "session branch changed during application";
      return false;
    }
    return true;
  };
  const valid = () => (options.timings ? options.timings.measure("validation", validate) : validate());
  if (signal.aborted) return { kind: "cancel" };
  if (!valid()) return { kind: "stale" };
  try {
    // Wait for the bounded preparation before refreshing auth. A duplicate auth
    // lookup here could hide its deadline; validate once before using the result.
    let result: CompactionResult;
    try {
      const pending = abortable(Promise.resolve(prepared.result), signal);
      result = await pending;
    } catch {
      return signal.aborted ? { kind: "cancel" } : stale("prepared checkpoint promise failed", valid());
    }
    if (signal.aborted) return { kind: "cancel" };
    if (!valid()) return { kind: "stale" };
    if (!ctx.model) return stale("active model is unavailable");
    let binding: Awaited<ReturnType<typeof resolveCompactionBinding>>;
    try {
      binding = await abortable(
        resolveCompactionBinding(ctx, ctx.model, runtime.get().settings, valid, options.timings),
        signal,
      );
    } catch {
      return signal.aborted
        ? { kind: "cancel" }
        : stale(prepared.validationFailure ?? "authentication or provider lookup failed", valid());
    }
    if (signal.aborted) return { kind: "cancel" };
    if (!valid()) return { kind: "stale" };
    if (!sameCompactionBinding(prepared.attempt.binding, binding.binding))
      return stale(compactionBindingChanges(prepared.attempt.binding, binding.binding).join("; "), true);
    if (prepared.attempt.failure) return { kind: "failed" };
    if (!result || !("compaction" in result) || !result.compaction)
      return stale("prepared checkpoint result is unavailable", true);
    const rebindStarted = performance.now();
    try {
      const entries = event.branchEntries;
      if (!completeToolPairs(buildSessionContext(entries).messages))
        return stale("session contains an unmatched tool call");
      const cutoffIndex = entries.findIndex((entry) => entry.id === prepared.snapshotLeafId);
      if (cutoffIndex < 0) return stale("snapshot cutoff is absent from the session");
      const leafId = entries.at(-1)?.id ?? null;
      const projection = buildSessionProjection(entries, leafId);
      const suffixIds = new Set(entries.slice(cutoffIndex + 1).map((entry) => entry.id));
      const suffix = projection.entries.filter(({ sourceEntry }) => suffixIds.has(sourceEntry.id));
      const nativeCutIndex = entries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
      if (nativeCutIndex < 0) return stale("retained-message cut point is absent from the session");
      const firstSuffix = suffix.find(({ messages }) => messages.length > 0);
      const firstKeptEntryId =
        firstSuffix && entries.findIndex((entry) => entry.id === firstSuffix.sourceEntry.id) < nativeCutIndex
          ? firstSuffix.sourceEntry.id
          : event.preparation.firstKeptEntryId;
      const details = parseCheckpointDetails(result.compaction.details);
      if (!details) return stale("prepared checkpoint details are invalid", true);
      // A large untouched tail can erase the benefit. Use the current-history foreground
      // path instead of truncating it or immediately overflowing the adopted checkpoint.
      const replacementTokens = Math.ceil(JSON.stringify(details.replacementHistory).length / 4);
      const suffixTokens = suffix
        .flatMap(({ messages }) => messages)
        .reduce((sum, message) => sum + estimateTokens(message), 0);
      const estimatedTokens = replacementTokens + suffixTokens + prepared.promptAndToolsTokens;
      if (estimatedTokens >= ctx.model.contextWindow - event.preparation.settings.reserveTokens) {
        const number = (value: number) => (Number.isFinite(value) ? String(value) : "unknown");
        return stale(
          `token budget exceeded (estimated=${number(estimatedTokens)}, replacement=${number(replacementTokens)}, suffix=${number(suffixTokens)}, prompt/tools=${number(prepared.promptAndToolsTokens)}, context=${number(ctx.model.contextWindow)}, reserve=${number(event.preparation.settings.reserveTokens)})`,
          true,
        );
      }
      let keptMessages: AgentMessage[];
      try {
        keptMessages = checkpointKeptMessages(entries, leafId, firstKeptEntryId, prepared.snapshotLeafId);
      } catch {
        return stale("retained-message ancestry or snapshot projection validation failed", true);
      }
      const adopted = createCheckpointDetails({ ...details, keptMessages, snapshotLeafId: prepared.snapshotLeafId });
      return {
        kind: "ready",
        result: {
          compaction: {
            ...result.compaction,
            details: adopted,
            summary: fallbackSummary(adopted.checkpointId, {
              preparationMs: prepared.preparationMs,
              applicationMs: performance.now() - applicationStarted,
            }),
            firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        },
      };
    } finally {
      options.timings?.record("rebind", rebindStarted);
    }
  } finally {
    // The caller owns cancellation of its preparation operation.
  }
}

/** Build a validated draft for a caller-owned serialized boundary. */
async function preparedCheckpointDraft(
  prepared: PreparedData,
  ctx: ExtensionContext,
  runtime: CodexCompactSettingsRuntime,
  signal: AbortSignal,
  isCurrent: () => boolean,
  options: PreparedApplicationOptions = {},
): Promise<CompactionEntryDraft | undefined> {
  const applicationStarted = performance.now();
  const reject = (reason: string, failure = false) => {
    prepared.validationFailure = reason;
    if (failure) prepared.applicationFailure = reason;
    return undefined;
  };
  prepared.validationFailure = undefined;
  prepared.applicationFailure = undefined;
  if (!prepared.result || !("compaction" in prepared.result)) return reject("checkpoint is not ready");
  // No code below mutates these entries. Digest guards reject in-place mutations
  // and any appended entries across auth/application awaits before using them.
  const boundaryStarted = performance.now();
  const entries = ctx.sessionManager.getBranch();
  const exactBranchIsCurrent = options.exactBranchIsCurrent ?? captureExactCompactionBranch(entries);
  // Keep the newest visible raw message as the native anchor. Adoption moves
  // this cut earlier if needed to retain every uncovered suffix message. Do not
  // use projection order: older summaries precede physically earlier messages.
  const visible = new Set(
    buildSessionProjection(entries)
      .entries.filter(
        ({ sourceEntry, messages }) =>
          sourceEntry.type !== "compaction" && messages.some((message) => message.role !== "system"),
      )
      .map(({ sourceEntry }) => sourceEntry.id),
  );
  const first = [...entries].reverse().find((entry) => visible.has(entry.id));
  if (!first) return reject("no visible retained-message anchor");
  options.timings?.record("boundary", boundaryStarted);
  const adoption = await adoptPreparedCheckpoint(
    prepared,
    {
      type: "session_before_compact",
      reason: "threshold",
      willRetry: false,
      signal,
      branchEntries: entries,
      preparation: {
        firstKeptEntryId: first.id,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: ctx.getContextUsage()?.tokens ?? 0,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: ctx.model?.maxTokens ?? 0, keepRecentTokens: 0 },
      },
    },
    ctx,
    runtime,
    signal,
    isCurrent,
    { ...options, exactBranchIsCurrent },
  );
  const validate = () =>
    !signal.aborted && isCurrent() && prepared.isCurrent() && exactBranchIsCurrent(ctx.sessionManager.getBranch());
  if (
    !(options.timings ? options.timings.measure("validation", validate) : validate()) ||
    adoption.kind !== "ready" ||
    !adoption.result ||
    !("compaction" in adoption.result) ||
    !adoption.result.compaction
  )
    return reject(prepared.validationFailure ?? "application cancelled or boundary changed");
  const previewStarted = performance.now();
  try {
    const { summary, firstKeptEntryId, details, usage } = adoption.result.compaction;
    // Verify Pi's own finalized projection before handing it a draft. In
    // particular, old summaries and system entries are folded during compaction.
    const header = ctx.sessionManager.getHeader();
    if (!header) return reject("session header is unavailable");
    const preview = SessionManager.inMemory(ctx.cwd, undefined, [header, ...entries]);
    preview.appendCompaction(summary, firstKeptEntryId, 0, details, true, usage);
    const checkpoint = latestCheckpoint(preview.getBranch());
    if (
      !checkpoint ||
      !projectSessionCheckpointContext(preview.buildSessionContext().messages, preview.getBranch(), checkpoint)
    )
      return reject("finalized checkpoint projection did not validate", true);
    return {
      type: "compaction",
      summary: fallbackSummary(checkpoint.details.checkpointId, {
        preparationMs: prepared.preparationMs,
        applicationMs: performance.now() - applicationStarted,
      }),
      firstKeptEntryId,
      details,
      usage,
    };
  } finally {
    options.timings?.record("preview", previewStarted);
  }
}
