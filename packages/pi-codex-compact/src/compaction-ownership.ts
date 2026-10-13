import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Allow bookkeeping descendants without accepting a different branch or compaction input. */
export function captureCompactionBranch(entries: SessionEntry[]): (current: SessionEntry[]) => boolean {
  // getBranch() returns a new array, not immutable entries. Capture persisted
  // JSON values before awaiting; schema symbols and prototypes are not session data.
  const length = entries.length;
  const prefix = JSON.stringify(entries);
  const leafId = entries.at(-1)?.id ?? null;
  const context = JSON.stringify(buildSessionContext(entries, leafId));
  const capturedIds = entries.map((entry) => entry.id);
  return (current) => {
    if (current.length < length || JSON.stringify(current.slice(0, length)) !== prefix) return false;
    const ids = new Set(capturedIds);
    let parentId = leafId;
    for (const entry of current.slice(length)) {
      if (entry.parentId !== parentId || ids.has(entry.id)) return false;
      ids.add(entry.id);
      switch (entry.type) {
        case "custom":
        case "usage":
        case "label":
        case "session_info":
        case "context_edit":
          break;
        default:
          return false;
      }
      parentId = entry.id;
    }
    // A context_edit contributes no message itself, but can omit or replace an
    // earlier message. Pi's finalized projection is authoritative, not raw types.
    return JSON.stringify(buildSessionContext(current, parentId)) === context;
  };
}
