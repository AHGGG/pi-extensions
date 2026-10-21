import { createHash } from "node:crypto";

/** Hash persisted JSON values without retaining or serializing an entire history at once. */
export function fingerprintJsonSequence(values: Iterable<unknown>): string {
  const hash = createHash("sha256");
  for (const value of values) {
    // JSON strings escape newlines, so this separator cannot merge adjacent values.
    hash.update(JSON.stringify(value) ?? "null").update("\n");
  }
  return hash.digest("hex");
}
