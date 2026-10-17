import type { AnySyncConfig } from "../settings/settings-types.js";
import { withLock } from "../state/lock.js";
import { withStateDirectoryAccess } from "../state/state-directory.js";
import { ContinuousError, type ContinuousErrorKind } from "./continuous-errors.js";
import { type ContinuousLease, continuousLeaseOwner } from "./continuous-lease.js";
import { continuousBinding, readContinuousPrivate, writeContinuousPrivate } from "./continuous-storage.js";

export const REQUEST_WINDOW_MS = 15 * 60_000;
export interface ContinuousRecord {
  version: 1;
  binding: string;
  pending: boolean;
  phase: "waiting" | "syncing" | "retry" | "blocked";
  next: number;
  failures: number;
  evidence?: string;
  recovery?: string;
  notice?: string;
  configuration?: string;
  error?: ContinuousErrorKind;
  checked?: number;
  transferred?: number;
  calls: { key: string; at: number }[];
  attempts: Record<string, number>;
}
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
export function validateContinuousRecord(value: unknown, binding: string): asserts value is ContinuousRecord {
  const record = value as ContinuousRecord;
  if (
    !record ||
    typeof record !== "object" ||
    record.version !== 1 ||
    record.binding !== binding ||
    Object.keys(record).some(
      (key) =>
        ![
          "version",
          "binding",
          "pending",
          "phase",
          "next",
          "failures",
          "evidence",
          "recovery",
          "notice",
          "configuration",
          "error",
          "checked",
          "transferred",
          "calls",
          "attempts",
        ].includes(key),
    ) ||
    typeof record.pending !== "boolean" ||
    !["waiting", "syncing", "retry", "blocked"].includes(record.phase) ||
    !timestamp(record.next) ||
    !timestamp(record.failures) ||
    record.failures > 30 ||
    (record.evidence !== undefined && !digest(record.evidence)) ||
    (record.recovery !== undefined && !digest(record.recovery)) ||
    (record.notice !== undefined && !digest(record.notice)) ||
    (record.configuration !== undefined && !digest(record.configuration)) ||
    (record.error !== undefined &&
      ![
        "transient",
        "contention",
        "stale",
        "authentication",
        "storage",
        "unsafe",
        "model",
        "budget",
        "unknown",
      ].includes(record.error)) ||
    (record.checked !== undefined && !timestamp(record.checked)) ||
    (record.transferred !== undefined && !timestamp(record.transferred)) ||
    !Array.isArray(record.calls) ||
    record.calls.length > 2 ||
    record.calls.some(
      (call) => !call || Object.keys(call).sort().join(",") !== "at,key" || !digest(call.key) || !timestamp(call.at),
    ) ||
    !record.attempts ||
    typeof record.attempts !== "object" ||
    Array.isArray(record.attempts) ||
    Object.entries(record.attempts).some(
      ([key, count]) => !digest(key) || !Number.isInteger(count) || count < 1 || count > 2,
    ) ||
    record.calls.some(
      (call) => (record.attempts[call.key] ?? 0) < record.calls.filter((other) => other.key === call.key).length,
    )
  )
    throw new Error("Invalid continuous sync state; evidence retained.");
}
export async function readContinuousRecord(binding: string): Promise<ContinuousRecord> {
  const value = await readContinuousPrivate(`${binding}.json`);
  if (value === undefined)
    return { version: 1, binding, pending: true, phase: "waiting", next: 0, failures: 0, calls: [], attempts: {} };
  validateContinuousRecord(value, binding);
  return value;
}
export async function updateContinuousRecord<T>(
  binding: string,
  lease: ContinuousLease,
  update: (record: ContinuousRecord) => T,
): Promise<T> {
  return withStateDirectoryAccess(() =>
    withLock("continuous-state", async () => {
      lease.assert();
      const record = await readContinuousRecord(binding);
      lease.assert();
      const result = update(record);
      validateContinuousRecord(record, binding);
      lease.assert();
      await writeContinuousPrivate(`${binding}.json`, record);
      lease.assert();
      return result;
    }),
  );
}
export function normalizeContinuousClock(record: ContinuousRecord, now: number) {
  // A backward wall-clock jump cannot grant more calls: retain them for a full window.
  record.calls = record.calls
    .map((call) => ({ ...call, at: Math.min(call.at, now) }))
    .filter((call) => now - call.at < REQUEST_WINDOW_MS);
  record.next = Math.min(record.next, now + (record.error === "budget" ? REQUEST_WINDOW_MS : 300_000));
}
export async function reserveContinuousRequest(
  binding: string,
  lease: ContinuousLease,
  key: string,
  clock: () => number = Date.now,
) {
  if (!digest(key)) throw new Error("Invalid continuous candidate key.");
  let failure: ContinuousError | undefined;
  await updateContinuousRecord(binding, lease, (record) => {
    const now = clock();
    normalizeContinuousClock(record, now);
    if ((record.attempts[key] ?? 0) >= 2)
      failure = new ContinuousError(
        "model",
        "Automatic request limit reached for this evidence. Use Sync now for an explicit retry.",
      );
    else if (record.calls.length >= 2)
      failure = new ContinuousError(
        "budget",
        "Automatic request window is full.",
        Math.max(0, (record.calls[0]?.at ?? now) + REQUEST_WINDOW_MS - now),
      );
    else {
      record.attempts[key] = (record.attempts[key] ?? 0) + 1;
      record.calls.push({ key, at: now });
    }
  });
  if (failure) throw failure;
}

/** Read-only status: no directory creation, lease, mutation, request reservation or provider call. */
export async function continuousStatusLines(config: AnySyncConfig): Promise<string[]> {
  if (!config.continuous) return ["Continuous sync: Off"];
  if (!config.agentMode) return ["Continuous sync: paused; enable Agent mode first"];
  try {
    const record = await readContinuousRecord(await continuousBinding(config));
    return [
      `Continuous sync: ${record.phase}${record.error ? ` (${record.error})` : ""}`,
      await continuousLeaseOwner(record.binding),
      `Last successful background check: ${record.checked ? new Date(record.checked).toISOString() : "not yet checked"}`,
      `Last successful background transfer: ${record.transferred ? new Date(record.transferred).toISOString() : "none"}`,
      ...(record.phase === "retry" ? [`Next background attempt: ${new Date(record.next).toISOString()}`] : []),
      ...(record.phase === "blocked"
        ? ["Background sync needs changed evidence or repair. Review /sync, or use Sync now for an explicit retry."]
        : []),
      "Monitoring requires an eligible open Pi session. Status does not spend model requests or clear retry limits.",
    ];
  } catch {
    return ["Continuous sync: private state unavailable; retain evidence and repair access before retrying."];
  }
}
