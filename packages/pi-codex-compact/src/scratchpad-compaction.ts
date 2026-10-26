import { ScratchpadError, type ScratchpadExecutionOptions, ScratchpadStore } from "./scratchpad-store.js";

/** Every item is represented, or only a content-free existence notice may be used. */
export const SCRATCHPAD_COMPACTION_BYTE_BUDGET = 16 * 1024;
export const SCRATCHPAD_COMPACTION_FULL_TEXT_BYTES = 2 * 1024;

export type ScratchpadCompactionSnapshot =
  | { kind: "ready"; text: string; itemCount: number; redactionValues: string[] }
  | { kind: "empty" }
  | { kind: "omitted"; reason: "oversized" }
  | { kind: "unavailable"; reason: "oversized" | "unreadable" };

export async function captureScratchpadForCompaction(
  sessionId: string,
  options: ScratchpadExecutionOptions & { store?: ScratchpadStore } = {},
): Promise<ScratchpadCompactionSnapshot> {
  try {
    const notes = await (options.store ?? new ScratchpadStore()).readSnapshot(sessionId, options);
    if (notes.length === 0) return { kind: "empty" };
    const items = notes.map(({ id, text, summary, createdAt, updatedAt }) => {
      const summarized =
        Buffer.byteLength(text, "utf8") > SCRATCHPAD_COMPACTION_FULL_TEXT_BYTES && summary !== undefined;
      return {
        id,
        representation: summarized ? "summary" : "full",
        text: summarized ? summary : text,
        createdAt,
        updatedAt,
      };
    });
    const text = JSON.stringify({ items });
    if (Buffer.byteLength(text, "utf8") > SCRATCHPAD_COMPACTION_BYTE_BUDGET)
      return { kind: "omitted", reason: "oversized" };
    return {
      kind: "ready",
      text,
      itemCount: items.length,
      // Cover both provider prose and JSON-escaped echoes without logging either.
      redactionValues: [
        ...new Set([
          text,
          ...notes.flatMap((item) =>
            [item.text, item.summary]
              .filter((value): value is string => value !== undefined)
              .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
          ),
        ]),
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
