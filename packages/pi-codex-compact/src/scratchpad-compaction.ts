import { ScratchpadError, type ScratchpadExecutionOptions, ScratchpadStore } from "./scratchpad-store.js";

/** The complete serialized snapshot must fit; partial snapshots never enable omission. */
export const SCRATCHPAD_COMPACTION_BYTE_BUDGET = 16 * 1024;

export type ScratchpadCompactionSnapshot =
  | { kind: "ready"; text: string; itemCount: number; redactionValues: string[] }
  | { kind: "empty" }
  | { kind: "unavailable"; reason: "oversized" | "unreadable" };

export async function captureScratchpadForCompaction(
  sessionId: string,
  options: ScratchpadExecutionOptions & { store?: ScratchpadStore } = {},
): Promise<ScratchpadCompactionSnapshot> {
  try {
    const items = await (options.store ?? new ScratchpadStore()).readSnapshot(sessionId, options);
    if (items.length === 0) return { kind: "empty" };
    const text = JSON.stringify({ items });
    if (Buffer.byteLength(text, "utf8") > SCRATCHPAD_COMPACTION_BYTE_BUDGET)
      return { kind: "unavailable", reason: "oversized" };
    return {
      kind: "ready",
      text,
      itemCount: items.length,
      // Cover both provider prose and JSON-escaped echoes without logging either.
      redactionValues: [
        ...new Set([text, ...items.flatMap((item) => [item.text, JSON.stringify(item.text).slice(1, -1)])]),
      ],
    };
  } catch (error) {
    if (error instanceof ScratchpadError && ["CANCELLED", "SESSION_CHANGED"].includes(error.code)) throw error;
    return {
      kind: "unavailable",
      reason: error instanceof ScratchpadError && error.code === "LIMIT_EXCEEDED" ? "oversized" : "unreadable",
    };
  }
}
