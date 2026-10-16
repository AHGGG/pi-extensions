import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildContextEntries,
  buildSessionProjection,
  type ProjectedSessionEntry,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { fingerprintMessage, type latestCheckpoint, projectCheckpointContext } from "./checkpoint.js";

function retainedMessages({ sourceEntry, messages }: ProjectedSessionEntry): AgentMessage[] {
  return sourceEntry.type === "compaction" ? [] : messages.filter((message) => message.role !== "system");
}

function sameMessages(expected: readonly AgentMessage[], actual: readonly AgentMessage[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((message, index) => fingerprintMessage(message) === fingerprintMessage(actual[index]))
  );
}

/** Use the same finalized projection as Pi, including edits and suppressed older summaries. */
export function projectedKeptMessages(
  entries: SessionEntry[],
  leafId: string | null,
  firstKeptEntryId: string,
): AgentMessage[] {
  const projection = buildSessionProjection(entries, leafId);
  const index = projection.entries.findIndex(({ sourceEntry }) => sourceEntry.id === firstKeptEntryId);
  if (index < 0) throw new Error("Pi compaction cut point is not present in the active context");
  // A newly appended compaction suppresses all retained compaction entries and
  // folds pre-compaction system messages into its own system checkpoint.
  return projection.entries.slice(index).flatMap(retainedMessages);
}

/** Return only retained messages already represented by a checkpoint's snapshot. */
export function checkpointKeptMessages(
  entries: SessionEntry[],
  parentId: string | null,
  firstKeptEntryId: string,
  snapshotLeafId?: string,
): AgentMessage[] {
  if (snapshotLeafId === undefined) return projectedKeptMessages(entries, parentId, firstKeptEntryId);

  // Pi falls back to the newest entry for an unknown leaf and tolerates missing
  // ancestors. An opaque checkpoint cannot safely guess either boundary.
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionEntry[] = [];
  const visited = new Set<string>();
  let id = parentId;
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry || visited.has(id)) throw new Error("Checkpoint parent ancestry is incomplete");
    visited.add(id);
    path.push(entry);
    id = entry.parentId;
  }
  path.reverse();
  const snapshotIndex = path.findIndex((entry) => entry.id === snapshotLeafId);
  if (snapshotIndex < 0) throw new Error("Checkpoint snapshot is not an ancestor of its parent");

  const snapshot = buildSessionProjection(path.slice(0, snapshotIndex + 1), snapshotLeafId);
  const current = buildSessionProjection(path, parentId);
  // A suffix may append model-visible messages or bookkeeping, but cannot change
  // any projected snapshot contribution, even one outside the retained range.
  for (let index = 0; index < snapshot.entries.length; index++) {
    const expected = snapshot.entries[index];
    const actual = current.entries[index];
    if (actual?.sourceEntry.id !== expected.sourceEntry.id || !sameMessages(expected.messages, actual.messages)) {
      throw new Error("Checkpoint snapshot prefix changed before adoption");
    }
  }
  const keptIndex = current.entries.findIndex(({ sourceEntry }) => sourceEntry.id === firstKeptEntryId);
  if (keptIndex < 0) throw new Error("Pi compaction cut point is not present in the active context");
  const uncoveredIndex = current.entries.findIndex(
    ({ messages }, index) => index >= snapshot.entries.length && messages.length > 0,
  );
  if (uncoveredIndex >= 0 && keptIndex > uncoveredIndex) {
    throw new Error("Pi compaction cut point skips messages outside the checkpoint snapshot");
  }
  return current.entries.slice(keptIndex, snapshot.entries.length).flatMap(retainedMessages);
}

export function projectSessionCheckpointContext(
  messages: readonly AgentMessage[],
  entries: SessionEntry[],
  checkpoint: NonNullable<ReturnType<typeof latestCheckpoint>>,
): AgentMessage[] | undefined {
  const { entry, details } = checkpoint;
  // Reconstruct only the snapshot that the provider actually compacted. Later edits
  // must still fail the ordinary prefix check rather than be silently absorbed.
  if (entry.parentId !== null && !entries.some((candidate) => candidate.id === entry.parentId)) return undefined;
  let canonical: AgentMessage[];
  try {
    canonical =
      entry.firstKeptEntryId === entry.id && details.snapshotLeafId === undefined
        ? []
        : checkpointKeptMessages(entries, entry.parentId, entry.firstKeptEntryId, details.snapshotLeafId);
  } catch {
    return undefined;
  }
  if (details.snapshotLeafId !== undefined) {
    const snapshot = buildSessionProjection(entries, details.snapshotLeafId);
    const keptIndex = snapshot.entries.findIndex(({ sourceEntry }) => sourceEntry.id === entry.firstKeptEntryId);
    const current = new Map(buildSessionProjection(entries).entries.map((item) => [item.sourceEntry.id, item]));
    // Fingerprints alone cannot detect an omitted covered message becoming
    // visible again after adoption. Preserve each retained source's contribution,
    // including empty contributions, before suppressing the fingerprinted prefix.
    if (
      keptIndex >= 0 &&
      snapshot.entries.slice(keptIndex).some((expected) => {
        const actual = current.get(expected.sourceEntry.id);
        return !actual || !sameMessages(retainedMessages(expected), retainedMessages(actual));
      })
    ) {
      return undefined;
    }
  }
  const fingerprints = canonical.map(fingerprintMessage);
  const matches = (expected: readonly string[]) =>
    expected.length === details.keptMessageFingerprints.length &&
    expected.every((fingerprint, index) => fingerprint === details.keptMessageFingerprints[index]);
  if (!matches(fingerprints)) {
    if (details.snapshotLeafId !== undefined) return undefined;
    // Older releases fingerprinted raw entries, including omitted messages and
    // nested summaries. Accept that contract only after verifying the entire raw
    // snapshot; never relax the fingerprint check against arbitrary current text.
    const raw = buildContextEntries(entries, entry.parentId);
    const index = raw.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
    if (index < 0 || !matches(raw.slice(index).flatMap(sessionEntryToContextMessages).map(fingerprintMessage)))
      return undefined;
  }
  return projectCheckpointContext(messages, { ...details, keptMessageFingerprints: fingerprints }, entry.summary);
}
