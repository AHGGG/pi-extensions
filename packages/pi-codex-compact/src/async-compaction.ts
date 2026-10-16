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
import { createCheckpointDetails, fallbackSummary, latestCheckpoint, parseCheckpointDetails } from "./checkpoint.js";
import { checkpointKeptMessages, projectSessionCheckpointContext } from "./checkpoint-projection.js";
import { resolveCompactionBinding, sameCompactionBinding } from "./compaction-binding.js";
import { activeTools, type CompactionAttempt, compactRemotely } from "./compaction-operation.js";
import { captureCompactionBranch } from "./compaction-ownership.js";
import { type RemoteCompactionProtocol, resolveCompactionRoute } from "./model-api.js";
import { type RejectedRoutes, rejectionRouteKey } from "./rejection-state.js";
import { type CodexCompactSettingsRuntime, compactionSettingsKey } from "./settings.js";

type CompactionResult = Awaited<ReturnType<typeof compactRemotely>>;

/** The immutable snapshot remains an ancestor; edits cannot rewrite its context. */
export function captureWarmCompactionBranch(snapshot: SessionEntry[]): (entries: SessionEntry[]) => boolean {
  const prefix = JSON.stringify(snapshot);
  const leafId = snapshot.at(-1)?.id ?? null;
  const snapshotIds = new Set(snapshot.map((entry) => entry.id));
  const projected = JSON.stringify(
    buildSessionProjection(snapshot, leafId).entries.map(({ sourceEntry, messages }) => [sourceEntry.id, messages]),
  );
  return (entries) => {
    if (entries.length < snapshot.length || JSON.stringify(entries.slice(0, snapshot.length)) !== prefix) return false;
    const ids = new Set(snapshotIds);
    let parentId = leafId;
    for (const entry of entries.slice(snapshot.length)) {
      if (entry.parentId !== parentId || ids.has(entry.id)) return false;
      ids.add(entry.id);
      // New turns and bookkeeping are safe; model/branch/compaction transitions are not.
      if (
        !["message", "custom_message", "custom", "usage", "label", "session_info", "context_edit"].includes(entry.type)
      )
        return false;
      parentId = entry.id;
    }
    const currentPrefix = buildSessionProjection(entries, parentId)
      .entries.filter(({ sourceEntry }) => snapshotIds.has(sourceEntry.id))
      .map(({ sourceEntry, messages }) => [sourceEntry.id, messages]);
    return JSON.stringify(currentPrefix) === projected;
  };
}

function completeToolPairs(messages: AgentMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  return pending.size === 0;
}

export interface WarmCompactionJob {
  controller: AbortController;
  attempt: CompactionAttempt;
  promise: Promise<CompactionResult>;
  snapshot: SessionEntry[];
  snapshotLeafId: string;
  state: "Preparing" | "Ready" | "Failed";
  promptAndToolsTokens: number;
  isCurrent(): boolean;
}

export function startWarmCompaction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: CodexCompactSettingsRuntime,
  ownerSignal: AbortSignal,
  rejected: RejectedRoutes,
  ownerIsCurrent: () => boolean,
  ownsStatus: () => boolean,
  onRouteResolved: (protocol: RemoteCompactionProtocol) => void,
  fetch?: typeof globalThis.fetch,
): WarmCompactionJob | undefined {
  const settings = runtime.get().settings;
  const model = ctx.model;
  const route = resolveCompactionRoute(model, settings);
  if (
    !settings.asyncEnabled ||
    !settings.enabled ||
    !model ||
    route.kind !== "remote" ||
    ownerSignal.aborted ||
    ctx.signal?.aborted ||
    rejected.hasObserved(rejectionRouteKey(model, route))
  )
    return undefined;
  const usage = ctx.getContextUsage();
  if (
    !usage ||
    usage.tokens === null ||
    !Number.isFinite(usage.tokens) ||
    !Number.isFinite(usage.contextWindow) ||
    usage.contextWindow <= 0 ||
    (usage.tokens / usage.contextWindow) * 100 < settings.asyncThresholdPercent
  )
    return undefined;
  // Session entries are mutable references. Only persisted JSON values belong to this job.
  const snapshot = JSON.parse(JSON.stringify(ctx.sessionManager.getBranch())) as SessionEntry[];
  // Pi recreates label entries with new IDs when forking. Persist a stable
  // non-label cutoff; keep every raw entry in the live ownership snapshot.
  const snapshotLeafId = [...snapshot].reverse().find((entry) => entry.type !== "label")?.id;
  const projection = buildSessionProjection(snapshot, snapshotLeafId ?? null);
  const first = projection.entries.find(({ messages }) => messages.some((message) => message.role !== "system"));
  if (!snapshotLeafId || !first || !completeToolPairs(buildSessionContext(snapshot, snapshotLeafId).messages))
    return undefined;
  const branchIsCurrent = captureWarmCompactionBranch(snapshot);
  const settingsKey = compactionSettingsKey(settings);
  const modelKey = JSON.stringify(model);
  const systemPrompt = ctx.getSystemPrompt();
  const toolsKey = JSON.stringify([pi.getActiveTools(), activeTools(pi)]);
  const thinkingLevel = pi.getThinkingLevel();
  const controller = new AbortController();
  // The request belongs to the run while preparing, but a completed checkpoint
  // belongs to the session. Escape must not invalidate an already-ready result.
  const signal = AbortSignal.any([controller.signal, ownerSignal]);
  const runSignal = ctx.signal;
  const cancelPreparing = () => controller.abort();
  runSignal?.addEventListener("abort", cancelPreparing, { once: true });
  const isCurrent = () =>
    !signal.aborted &&
    ownerIsCurrent() &&
    compactionSettingsKey(runtime.get().settings) === settingsKey &&
    JSON.stringify(ctx.model) === modelKey &&
    ctx.getSystemPrompt() === systemPrompt &&
    JSON.stringify([pi.getActiveTools(), activeTools(pi)]) === toolsKey &&
    pi.getThinkingLevel() === thinkingLevel &&
    branchIsCurrent(ctx.sessionManager.getBranch());
  const attempt: CompactionAttempt = {};
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(new Error("Background compaction request timed out")),
    settings.requestTimeoutMs,
  );
  const event: SessionBeforeCompactEvent = {
    type: "session_before_compact",
    branchEntries: snapshot,
    reason: "threshold",
    willRetry: false,
    signal,
    preparation: {
      firstKeptEntryId: first.sourceEntry.id,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: usage.tokens,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
    },
  };
  const job: WarmCompactionJob = {
    controller,
    attempt,
    snapshot,
    snapshotLeafId,
    state: "Preparing",
    isCurrent,
    promptAndToolsTokens: Math.ceil((systemPrompt.length + toolsKey.length) / 4),
    promise: Promise.resolve(undefined),
  };
  // Never publish from this promise: Pi owns foreground and boundary commits.
  job.promise = compactRemotely(
    pi,
    event,
    ctx,
    settings,
    signal,
    rejected,
    isCurrent,
    ownsStatus,
    onRouteResolved,
    fetch,
    { background: { attempt, branchIsCurrent }, deadlineSignal: deadline.signal },
  )
    .then((result) => {
      runSignal?.removeEventListener("abort", cancelPreparing);
      job.state = result && "compaction" in result ? "Ready" : "Failed";
      return result;
    })
    .finally(() => {
      runSignal?.removeEventListener("abort", cancelPreparing);
      clearTimeout(timeout);
      deadline.abort();
    });
  return job;
}

export type WarmCompactionAdoption =
  | { kind: "stale" }
  | { kind: "cancel" }
  | { kind: "failed"; attempt: CompactionAttempt }
  | { kind: "ready"; result: CompactionResult };

/** Wait only for the existing request's deadline; do not start a second request. */
export async function adoptWarmCompaction(
  job: WarmCompactionJob,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  runtime: CodexCompactSettingsRuntime,
  operationSignal: AbortSignal,
  isCurrent: () => boolean,
): Promise<WarmCompactionAdoption> {
  const signal = AbortSignal.any([event.signal, operationSignal]);
  const adoptionBranchIsCurrent = captureCompactionBranch(event.branchEntries);
  const valid = () =>
    !signal.aborted && isCurrent() && job.isCurrent() && adoptionBranchIsCurrent(ctx.sessionManager.getBranch());
  if (signal.aborted) return { kind: "cancel" };
  if (!valid()) return { kind: "stale" };
  const cancel = () => {
    if (job.state !== "Ready") job.controller.abort();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    // Wait for the bounded preparation before refreshing auth. A duplicate auth
    // lookup here could hide its deadline; validate once before using the result.
    let result: CompactionResult;
    try {
      result = await abortable(job.promise, signal);
    } catch {
      return signal.aborted ? { kind: "cancel" } : { kind: "stale" };
    }
    if (signal.aborted) return { kind: "cancel" };
    if (!valid() || !ctx.model) return { kind: "stale" };
    let binding: Awaited<ReturnType<typeof resolveCompactionBinding>>;
    try {
      binding = await abortable(resolveCompactionBinding(ctx, ctx.model, runtime.get().settings, valid), signal);
    } catch {
      return signal.aborted ? { kind: "cancel" } : { kind: "stale" };
    }
    if (signal.aborted) return { kind: "cancel" };
    if (!valid() || !sameCompactionBinding(job.attempt.binding, binding.binding)) return { kind: "stale" };
    if (job.attempt.failure) return { kind: "failed", attempt: job.attempt };
    if (!result || !("compaction" in result) || !result.compaction) return { kind: "stale" };
    const entries = event.branchEntries;
    if (!completeToolPairs(buildSessionContext(entries).messages)) return { kind: "stale" };
    const cutoffIndex = entries.findIndex((entry) => entry.id === job.snapshotLeafId);
    if (cutoffIndex < 0) return { kind: "stale" };
    const leafId = entries.at(-1)?.id ?? null;
    const projection = buildSessionProjection(entries, leafId);
    const suffixIds = new Set(entries.slice(cutoffIndex + 1).map((entry) => entry.id));
    const suffix = projection.entries.filter(({ sourceEntry }) => suffixIds.has(sourceEntry.id));
    const nativeCutIndex = entries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
    if (nativeCutIndex < 0) return { kind: "stale" };
    const firstSuffix = suffix.find(({ messages }) => messages.length > 0);
    const firstKeptEntryId =
      firstSuffix && entries.findIndex((entry) => entry.id === firstSuffix.sourceEntry.id) < nativeCutIndex
        ? firstSuffix.sourceEntry.id
        : event.preparation.firstKeptEntryId;
    const details = parseCheckpointDetails(result.compaction.details);
    if (!details) return { kind: "stale" };
    // A large untouched tail can erase the benefit. Use the current-history foreground
    // path instead of truncating it or immediately overflowing the adopted checkpoint.
    const estimatedTokens =
      Math.ceil(JSON.stringify(details.replacementHistory).length / 4) +
      suffix.flatMap(({ messages }) => messages).reduce((sum, message) => sum + estimateTokens(message), 0) +
      job.promptAndToolsTokens;
    if (estimatedTokens >= ctx.model.contextWindow - event.preparation.settings.reserveTokens) return { kind: "stale" };
    let keptMessages: AgentMessage[];
    try {
      keptMessages = checkpointKeptMessages(entries, leafId, firstKeptEntryId, job.snapshotLeafId);
    } catch {
      return { kind: "stale" };
    }
    const adopted = createCheckpointDetails({ ...details, keptMessages, snapshotLeafId: job.snapshotLeafId });
    return {
      kind: "ready",
      result: {
        compaction: {
          ...result.compaction,
          details: adopted,
          summary: fallbackSummary(adopted.checkpointId),
          firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      },
    };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Adopt only a ready result at Pi's serialized model/tool-batch boundary. */
export async function warmCompactionDraft(
  job: WarmCompactionJob,
  ctx: ExtensionContext,
  runtime: CodexCompactSettingsRuntime,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<CompactionEntryDraft | undefined> {
  if (job.state !== "Ready") return undefined;
  const entries = JSON.parse(JSON.stringify(ctx.sessionManager.getBranch())) as SessionEntry[];
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
  if (!first) return undefined;
  const branch = JSON.stringify(entries);
  const adoption = await adoptWarmCompaction(
    job,
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
    () => isCurrent() && JSON.stringify(ctx.sessionManager.getBranch()) === branch,
  );
  if (
    signal.aborted ||
    !isCurrent() ||
    !job.isCurrent() ||
    JSON.stringify(ctx.sessionManager.getBranch()) !== branch ||
    adoption.kind !== "ready" ||
    !adoption.result ||
    !("compaction" in adoption.result) ||
    !adoption.result.compaction
  )
    return undefined;
  const { summary, firstKeptEntryId, details, usage } = adoption.result.compaction;
  // Verify Pi's own finalized projection before handing it a draft. In
  // particular, old summaries and system entries are folded during compaction.
  const header = ctx.sessionManager.getHeader();
  if (!header) return undefined;
  const preview = SessionManager.inMemory(ctx.cwd, undefined, [header, ...entries]);
  preview.appendCompaction(summary, firstKeptEntryId, 0, details, true, usage);
  const checkpoint = latestCheckpoint(preview.getBranch());
  if (
    !checkpoint ||
    !projectSessionCheckpointContext(preview.buildSessionContext().messages, preview.getBranch(), checkpoint)
  )
    return undefined;
  return { type: "compaction", summary, firstKeptEntryId, details, usage };
}
