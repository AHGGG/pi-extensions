import assert from "node:assert/strict";
import { test } from "vitest";
import { COMPACTION_WORK_REPLAY_MESSAGE, rewriteCheckpointForWork } from "../src/checkpoint-replay.js";
import { expandRemoteCompactionPayload, hasCheckpointMarker, type JsonObject } from "../src/protocol.js";

const marker = "fixture-checkpoint-marker";
const history = [
  { type: "compaction", encrypted_content: "opaque-fixture" },
  { type: "reasoning", summary: [], encrypted_content: "signed-fixture" },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "Goal: work. Next: read." }] },
];
const boundary = {
  role: "developer",
  content: [{ type: "input_text", text: COMPACTION_WORK_REPLAY_MESSAGE }],
};
const markerItem = { role: "user", content: [{ type: "input_text", text: marker }] };
const latest = { role: "user", content: [{ type: "input_text", text: "Use the newer task instructions." }] };

function payload(tail: JsonObject[] = [latest]): JsonObject {
  return {
    instructions: "Stable system instructions",
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
    tool_choice: "auto",
    input: [markerItem, ...tail],
  };
}

test("work replay preserves all checkpoint items and separates them from the newer task", () => {
  const request = payload();
  const saved = structuredClone({ request, history });
  const rewritten = rewriteCheckpointForWork(request, marker, history);
  assert.deepEqual(rewritten.input, [...history, boundary, latest]);
  assert.equal(rewritten.instructions, request.instructions);
  assert.deepEqual(rewritten.tools, request.tools);
  assert.equal(rewritten.tool_choice, "auto");
  assert.deepEqual({ request, history }, saved);
});

test("later ordinary requests retain the same exact replay prefix", () => {
  const completed = { role: "assistant", content: [{ type: "output_text", text: "Step completed." }] };
  const next = { role: "user", content: [{ type: "input_text", text: "Next step." }] };
  const first = rewriteCheckpointForWork(payload(), marker, history);
  const second = rewriteCheckpointForWork(payload([latest, completed, next]), marker, history);
  const input = second.input as JsonObject[];
  assert.deepEqual(input.slice(0, (first.input as JsonObject[]).length), first.input);
  assert.deepEqual(input.slice(-2), [completed, next]);
  assert.equal(input.filter((item) => JSON.stringify(item) === JSON.stringify(boundary)).length, 1);
  assert.deepEqual(rewriteCheckpointForWork(payload(), marker, history), first);
  assert.equal(hasCheckpointMarker(second, marker), false, "the owning hook skips an already rewritten payload");
});

test("maintenance expansion does not inherit the ordinary-work instruction", () => {
  const expanded = expandRemoteCompactionPayload(payload(), { marker, replacementHistory: history });
  assert.deepEqual(expanded.input, [...history, latest]);
  assert.doesNotMatch(JSON.stringify(expanded), /PI_COMPACTION_WORK_RESUME_V1/);
});

test("tool calls and results remain paired and unchanged after the boundary", () => {
  const call = { type: "function_call", call_id: "call_fixture", name: "read", arguments: "{}" };
  const result = { type: "function_call_output", call_id: "call_fixture", output: "Read result." };
  const rewritten = rewriteCheckpointForWork(payload([latest, call, result]), marker, history);
  assert.deepEqual((rewritten.input as JsonObject[]).slice(-3), [latest, call, result]);
});

test("older OK checkpoints get the same boundary without changing their saved output", () => {
  const oldHistory = [history[0], { role: "assistant", content: [{ type: "output_text", text: "OK" }] }];
  const rewritten = rewriteCheckpointForWork(payload(), marker, oldHistory);
  assert.deepEqual(rewritten.input, [...oldHistory, boundary, latest]);
  assert.match(COMPACTION_WORK_REPLAY_MESSAGE, /not a new user request/);
  assert.match(COMPACTION_WORK_REPLAY_MESSAGE, /Do not restart completed or cancelled work/);
  assert.match(COMPACTION_WORK_REPLAY_MESSAGE, /blocked or awaiting user input/);
});

test("retained unary messages and pre-marker instructions preserve their order", () => {
  const retained = { role: "user", content: [{ type: "input_text", text: "Retained original task." }] };
  const before = { role: "developer", content: [{ type: "input_text", text: "Earlier instructions." }] };
  const request = { ...payload(), input: [before, markerItem, latest] };
  const rewritten = rewriteCheckpointForWork(request, marker, [retained, history[0]]);
  assert.deepEqual(rewritten.input, [before, retained, history[0], boundary, latest]);
});

test("missing and repeated checkpoint markers still fail closed", () => {
  assert.throws(() => rewriteCheckpointForWork({ input: [latest] }, marker, history), /0 checkpoint markers/);
  assert.throws(
    () => rewriteCheckpointForWork({ input: [markerItem, markerItem] }, marker, history),
    /2 checkpoint markers/,
  );
});
