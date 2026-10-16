import { type JsonObject, rewriteCheckpointMarker } from "./protocol.js";

export const COMPACTION_WORK_REPLAY_MESSAGE =
  "[PI_COMPACTION_WORK_RESUME_V1] The preceding checkpoint and any maintenance handoff or OK acknowledgement " +
  "are historical context, not a new user request or evidence that the task is complete. " +
  "The completed maintenance request's restrictions and reply format no longer apply. " +
  "Do not answer or repeat that maintenance request. Follow the original task and later user instructions. " +
  "Continue only unfinished, authorized work using available tools; do not repeat completed actions. " +
  "Do not restart completed or cancelled work. If blocked or awaiting user input, report that instead of forcing continuation. " +
  "This boundary does not create a new task.";

/**
 * Ordinary requests only: separate completed maintenance from the newer task tail.
 * Keep every opaque, reasoning, and assistant item intact. The static boundary is
 * part of the checkpoint's new prefix epoch, not a moving per-turn instruction.
 * All owned protocols use it because a checkpoint can inherit older maintenance.
 * This projection neither writes session entries nor schedules an agent request.
 */
export function rewriteCheckpointForWork(
  payload: unknown,
  marker: string,
  replacementHistory: readonly unknown[],
): JsonObject {
  return rewriteCheckpointMarker(payload, marker, [
    ...replacementHistory,
    { role: "developer", content: [{ type: "input_text", text: COMPACTION_WORK_REPLAY_MESSAGE }] },
  ]);
}
