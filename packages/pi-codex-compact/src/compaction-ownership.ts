import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { hasActiveCheckpointClaim, latestCheckpoint } from "./checkpoint.js";
import { projectSessionCheckpointContext } from "./checkpoint-projection.js";
import { fingerprintJsonSequence } from "./compaction-fingerprint.js";

/** Reject malformed paths before Pi's tolerant traversal can guess or loop. */
function ancestry(entries: SessionEntry[], prefixLength = entries.length): string | undefined {
  const ids = new Set<string>();
  let parentId: string | null = null;
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || entry.parentId !== parentId) return undefined;
    ids.add(entry.id);
    parentId = entry.id;
  }
  return fingerprintJsonSequence(
    entries.slice(0, prefixLength).map((entry) => [
      entry.id,
      entry.parentId,
      entry.type,
      // These small entries influence Pi's context settings, even outside the
      // active message range. They are not archived conversation payloads.
      ...(entry.type === "model_change" ? [entry.provider, entry.modelId] : []),
      ...(entry.type === "thinking_level_change" ? [entry.thinkingLevel] : []),
      ...(entry.type === "message" && entry.message.role === "assistant"
        ? [entry.message.provider, entry.message.model]
        : []),
    ]),
  );
}

function workingSet(entries: SessionEntry[], snapshotIds: Set<string>): string {
  // Project the FULL current branch first: later context edits can replace or
  // resurrect a captured contribution, including one previously omitted.
  const projection = buildSessionProjection(entries, entries.at(-1)?.id ?? null);
  const checkpoint = latestCheckpoint(entries);
  // Latest-checkpoint reconstruction can depend on older cutoffs and edits that
  // today's projection hides. Keep the authoritative replay/fingerprint checks;
  // never treat unchanged current messages alone as proof of valid replay.
  const replayValid = checkpoint
    ? !!projectSessionCheckpointContext(projection.messages, entries, checkpoint)
    : !hasActiveCheckpointClaim(entries);
  // An already-invalid checkpoint still belongs to the foreground operation:
  // it must report the existing actionable error/cancel policy, not masquerade
  // as stale ownership. A valid snapshot becoming invalid changes this digest.
  const latest = [...entries].reverse().find((entry) => entry.type === "compaction");
  return fingerprintJsonSequence([
    replayValid,
    // Keep all latest opaque data and metadata, including malformed/native
    // details, but never serialize superseded checkpoint payloads.
    [latest?.id, latest?.firstKeptEntryId, latest?.details],
    ...projection.entries
      .filter(({ sourceEntry }) => snapshotIds.has(sourceEntry.id))
      .map(({ sourceEntry, messages }) => [sourceEntry.id, messages]),
  ]);
}

function captureBranch(
  entries: SessionEntry[],
  mode: "exact" | "bookkeeping" | "prefix",
  onInvalid?: (reason: string) => void,
  allowThinkingChanges = false,
): (current: SessionEntry[]) => boolean {
  const invalid = (reason: string) => {
    onInvalid?.(reason);
    return false;
  };
  const length = entries.length;
  const prefix = ancestry(entries);
  const snapshotIds = new Set(entries.map((entry) => entry.id));
  const input = prefix === undefined ? undefined : workingSet(entries, snapshotIds);
  return (current) => {
    if (current.length < length || (mode === "exact" && current.length !== length))
      return invalid("session branch length changed");
    if (prefix === undefined || ancestry(current, length) !== prefix)
      return invalid("snapshot ancestry changed, is incomplete, or is duplicated");
    for (const entry of current.slice(length)) {
      if (
        !["custom", "usage", "label", "session_info", "context_edit"].includes(entry.type) &&
        !(mode === "prefix" && (entry.type === "message" || entry.type === "custom_message")) &&
        !(allowThinkingChanges && entry.type === "thinking_level_change")
      )
        return invalid("session transition invalidated the snapshot");
    }
    return (
      (input !== undefined && workingSet(current, snapshotIds) === input) ||
      invalid("projected snapshot or checkpoint replay changed")
    );
  };
}

/** A serialized turn boundary accepts no appended entries, including bookkeeping. */
export function captureExactCompactionBranch(entries: SessionEntry[]): (current: SessionEntry[]) => boolean {
  return captureBranch(entries, "exact");
}

/** Allow bookkeeping descendants without accepting a different branch or compaction input. */
export function captureCompactionBranch(
  entries: SessionEntry[],
  allowThinkingChanges = false,
): (current: SessionEntry[]) => boolean {
  return captureBranch(entries, "bookkeeping", undefined, allowThinkingChanges);
}

/** Preserve snapshot ancestry, effective input, and replay while allowing new turns. */
export function capturePrefixCompactionBranch(
  entries: SessionEntry[],
  onInvalid?: (reason: string) => void,
  allowThinkingChanges = false,
): (current: SessionEntry[]) => boolean {
  return captureBranch(entries, "prefix", onInvalid, allowThinkingChanges);
}
