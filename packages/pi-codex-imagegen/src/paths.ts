/** One policy for persisted paths, UI input, and chargeable-request preflight. */
export function validateOutputDir(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new Error("Output directory must be a nonempty path without controls.");
  }
}
