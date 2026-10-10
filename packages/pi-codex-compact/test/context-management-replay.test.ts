import assert from "node:assert/strict";
import { test } from "vitest";
import {
  COMPACTION_MAINTENANCE_MESSAGE,
  COMPACTION_REPLAY_MESSAGE,
  rewriteCheckpointForReplay,
} from "../src/context-management.js";
import { hasCheckpointMarker, type JsonObject } from "../src/protocol.js";

const marker = "checkpoint replay marker";
const markerItem = { role: "user", content: [{ type: "input_text", text: marker }] };
const checkpoint = { type: "compaction", id: "cmp_preserved", encrypted_content: "opaque-task-state" };
const reasoning = { type: "reasoning", id: "rs_preserved", summary: [], encrypted_content: "signed-maintenance" };
const acknowledgement = {
  type: "message",
  id: "msg_preserved",
  role: "assistant",
  content: [{ type: "output_text", text: "OK" }],
};
const tools = [
  { type: "function", name: "read", description: "Read", parameters: { type: "object", properties: {} } },
  {
    type: "function",
    name: "write",
    description: "Write",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    strict: false,
  },
];

function normalized(payload: JsonObject) {
  return {
    instructions: payload.instructions,
    tools: payload.tools,
    input: payload.input as JsonObject[],
  };
}

test("maintenance acknowledgement is explicitly scoped to its own request", () => {
  assert.match(COMPACTION_MAINTENANCE_MESSAGE, /maintenance for this response only/);
  assert.match(COMPACTION_MAINTENANCE_MESSAGE, /pending work, and whether the task is already complete/);
  assert.match(COMPACTION_MAINTENANCE_MESSAGE, /does not complete, cancel, or change the user's task/);
  assert.match(COMPACTION_MAINTENANCE_MESSAGE, /inactive on subsequent ordinary requests/);
});

for (const [protocol, history] of [
  ["context-management", [checkpoint, reasoning, acknowledgement]],
  ["remote-v2", [{ role: "user", content: [{ type: "input_text", text: "real user history" }] }, checkpoint]],
  ["responses-compact", [checkpoint]],
] as const) {
  for (const systemLocation of ["instructions", "input"] as const) {
    test(`${protocol} replay preserves the ${systemLocation} prefix and exact items without a new user prompt`, () => {
      const leading = systemLocation === "input" ? [{ role: "developer", content: "original system" }] : [];
      const payload: JsonObject = {
        ...(systemLocation === "instructions" ? { instructions: "original system" } : {}),
        tools,
        tool_choice: "auto",
        input: [...leading, markerItem],
      };
      const originalPayload = structuredClone(payload);
      const originalHistory = structuredClone(history);
      const first = normalized(rewriteCheckpointForReplay(payload, marker, history));
      assert.equal(first.instructions, payload.instructions);
      assert.deepEqual(first.tools, tools);
      assert.deepEqual(first.input.slice(0, leading.length), leading);
      assert.deepEqual(first.input.slice(leading.length, leading.length + history.length), history);
      assert.deepEqual(first.input.at(-1), {
        role: "developer",
        content: [{ type: "input_text", text: COMPACTION_REPLAY_MESSAGE }],
      });
      assert.equal(
        first.input.filter((item) => item.role === "user").length,
        history.filter((item) => "role" in item && item.role === "user").length,
      );
      assert.deepEqual(normalized(rewriteCheckpointForReplay(payload, marker, history)), first);
      assert.equal(hasCheckpointMarker(rewriteCheckpointForReplay(payload, marker, history), marker), false);
      assert.equal(rewriteCheckpointForReplay(payload, marker, history).tool_choice, "auto");
      assert.deepEqual(payload, originalPayload);
      assert.deepEqual(history, originalHistory);
    });
  }
}

test("ordinary requests keep one fixed checkpoint boundary before newer user instructions and output", () => {
  const history = [checkpoint, reasoning, acknowledgement];
  const base: JsonObject = { instructions: "stable system", tools, input: [markerItem] };
  const first = normalized(rewriteCheckpointForReplay(base, marker, history));
  const newerUser = { role: "user", content: [{ type: "input_text", text: "Cancel that work. Reply only OK." }] };
  const nextAssistant = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "OK" }],
  };
  let previous = first;
  for (const tail of [[newerUser], [newerUser, nextAssistant]]) {
    const next = normalized(rewriteCheckpointForReplay({ ...base, input: [markerItem, ...tail] }, marker, history));
    assert.equal(next.instructions, first.instructions);
    assert.deepEqual(next.tools, first.tools);
    assert.deepEqual(next.input.slice(0, previous.input.length), previous.input);
    assert.deepEqual(next.input.slice(first.input.length), tail);
    assert.equal(next.input.filter((item) => JSON.stringify(item).includes(COMPACTION_REPLAY_MESSAGE)).length, 1);
    previous = next;
  }
});

test("reload and recompaction use the same replay boundary without mutating persisted checkpoint data", () => {
  const restored = JSON.parse(JSON.stringify([checkpoint, reasoning, acknowledgement])) as JsonObject[];
  const nextCheckpoint = { ...checkpoint, id: "cmp_next", encrypted_content: "next-opaque-task-state" };
  const base = { input: [markerItem] };
  const original = JSON.stringify(restored);
  const first = rewriteCheckpointForReplay(base, marker, restored).input as JsonObject[];
  const resumed = rewriteCheckpointForReplay(base, marker, JSON.parse(original)).input;
  assert.deepEqual(resumed, first);
  // Recompaction may switch protocol and retain only a new opaque item. The old
  // maintenance exchange can still be inside it, so its replay needs the same boundary.
  const repeated = rewriteCheckpointForReplay(base, marker, [nextCheckpoint]).input as JsonObject[];
  assert.deepEqual(repeated, [nextCheckpoint, first.at(-1)]);
  assert.equal(JSON.stringify(restored), original);
});
