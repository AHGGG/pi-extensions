import { isDeepStrictEqual } from "node:util";
import {
  CodexCompactionProtocolError,
  type JsonObject,
  MAX_COMPACTION_ITEM_BYTES,
  validateCompactionItem,
} from "./protocol.js";

export const CONTEXT_MANAGEMENT_THRESHOLD = 1024;
export const COMPACTION_MAINTENANCE_MESSAGE =
  "[PI_CONTEXT_COMPACTION_V1] This request is conversation maintenance only. " +
  "Preserve the conversation for later continuation. Do not perform tasks or call tools. Reply only OK.";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function invalid(message: string): never {
  throw new CodexCompactionProtocolError(`Context management ${message}`);
}

function validateCompletedCheckpoint(value: unknown): JsonObject {
  const item = validateCompactionItem(value);
  if (item.status !== undefined && item.status !== "completed") invalid("returned an incomplete checkpoint");
  return item;
}

/** Completed stream items may need encrypted reasoning backfilled by the terminal event. */
function validateObservedMaintenanceOutput(value: unknown): JsonObject {
  if (!isObject(value) || bytes(value) > MAX_COMPACTION_ITEM_BYTES) invalid("returned an invalid output item");
  if (value.status !== undefined && value.status !== "completed") invalid("returned incomplete output");
  if (value.type === "reasoning") {
    if (
      !Array.isArray(value.summary) ||
      !value.summary.every((part) => isObject(part) && part.type === "summary_text" && typeof part.text === "string")
    ) {
      invalid("returned invalid reasoning output");
    }
    if (
      value.encrypted_content !== undefined &&
      value.encrypted_content !== null &&
      typeof value.encrypted_content !== "string"
    ) {
      invalid("returned invalid encrypted reasoning");
    }
  } else if (value.type === "message" && value.role === "assistant") {
    if (
      !Array.isArray(value.content) ||
      !value.content.every(
        (part) =>
          isObject(part) &&
          ((part.type === "output_text" && typeof part.text === "string") ||
            (part.type === "refusal" && typeof part.refusal === "string")),
      )
    ) {
      invalid("returned invalid assistant output");
    }
  } else invalid("returned unsupported output (tool invocation is disabled)");
  return structuredClone(value);
}

/** Persist only inert output that can be replayed without server-side response state. */
export function validateMaintenanceOutput(value: unknown): JsonObject {
  const item = validateObservedMaintenanceOutput(value);
  if (
    item.type === "reasoning" &&
    (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0)
  ) {
    invalid("returned reasoning without replayable encrypted reasoning");
  }
  return item;
}

export function validateContextManagementHistory(
  history: readonly unknown[],
  options: { byteBudget: number; tokenBudget?: number },
): JsonObject[] {
  if (history.length === 0 || bytes(history) > options.byteBudget) invalid("exceeded the replacement history limit");
  const checkpoint = validateCompletedCheckpoint(history[0]);
  const suffix = history.slice(1).map(validateMaintenanceOutput);
  if (options.tokenBudget !== undefined && JSON.stringify(suffix).length > options.tokenBudget * 4) {
    invalid("exceeded the replacement text budget");
  }
  return [checkpoint, ...suffix];
}

/** Event order is authoritative: hosted streams can omit all checkpoints from terminal output. */
export function createContextManagementCollector() {
  let history: JsonObject[] = [];
  let completed = false;
  let failure: unknown;
  const doneById = new Map<string, JsonObject>();
  const doneWithoutId = new Map<string, JsonObject>();
  let historyIndices = new Map<JsonObject, number>();
  return {
    observe(event: unknown): void {
      if (failure) return;
      try {
        if (!isObject(event) || typeof event.type !== "string") invalid("returned an invalid stream event");
        if (completed) invalid("returned events after completion");
        if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
          invalid("stream did not complete successfully");
        }
        if (event.type === "response.output_item.done") {
          const item =
            isObject(event.item) && event.item.type === "compaction"
              ? validateCompletedCheckpoint(event.item)
              : validateObservedMaintenanceOutput(event.item);
          if (typeof item.id === "string") {
            if (doneById.has(item.id)) invalid("repeated a completed output item");
            doneById.set(item.id, item);
          } else doneWithoutId.set(JSON.stringify(item), item);
          if (item.type === "compaction") {
            history = [item];
            historyIndices = new Map([[item, 0]]);
          } else if (history.length > 0) {
            historyIndices.set(item, history.length);
            history.push(item);
          }
        } else if (event.type === "response.completed" || event.type === "response.done") {
          // Codex exposes raw response.done to the public hook before Pi normalizes it.
          if (
            !isObject(event.response) ||
            event.response.status !== "completed" ||
            !Array.isArray(event.response.output)
          )
            invalid("returned an invalid terminal response");
          for (const terminalItem of event.response.output) {
            if (!isObject(terminalItem)) invalid("returned invalid terminal output");
            const done =
              typeof terminalItem.id === "string"
                ? doneById.get(terminalItem.id)
                : doneWithoutId.get(JSON.stringify(terminalItem));
            if (!done || done.type !== terminalItem.type)
              invalid("returned terminal output without a completed item event");
            // Pi's Azure adapter also backfills encrypted reasoning from terminal output.
            const canonical =
              done.type === "reasoning" &&
              !done.encrypted_content &&
              typeof terminalItem.encrypted_content === "string" &&
              terminalItem.encrypted_content.length > 0
                ? { ...done, encrypted_content: terminalItem.encrypted_content }
                : done;
            if (!isDeepStrictEqual(canonical, terminalItem)) invalid("returned conflicting terminal output");
            if (canonical.type !== "compaction") validateObservedMaintenanceOutput(canonical);
            const index = historyIndices.get(done);
            if (index !== undefined) history[index] = canonical;
          }
          completed = true;
        }
      } catch (error) {
        // Observation hooks must not leak rejected promises into provider instrumentation.
        failure = error;
      }
    },
    finish(): JsonObject[] {
      if (failure) throw failure;
      if (!completed) invalid("stream ended without a successful terminal response");
      if (history.length === 0) invalid("returned no completed compaction item");
      return [structuredClone(history[0]), ...history.slice(1).map(validateMaintenanceOutput)];
    },
  };
}
