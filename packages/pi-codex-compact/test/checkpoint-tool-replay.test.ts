import assert from "node:assert/strict";
import { test } from "vitest";
import { COMPACTION_WORK_REPLAY_MESSAGE, rewriteCheckpointForWork } from "../src/checkpoint-replay.js";
import { expandRemoteCompactionPayload, type JsonObject } from "../src/protocol.js";

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
const nativeDeclaration = {
  type: "additional_tools",
  role: "developer",
  tools: [
    ...tools,
    {
      type: "custom",
      name: "codemode",
      description: "Run tool orchestration",
      format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
    },
  ],
};

for (const [layout, history] of [
  ["checkpoint only", [checkpoint]],
  ["maintenance suffix", [checkpoint, reasoning, acknowledgement]],
  ["retained user prefix", [{ role: "user", content: [{ type: "input_text", text: "retained" }] }, checkpoint]],
] as const) {
  test(`native tool declarations survive ${layout} replay without changing their schemas`, () => {
    const leading = [nativeDeclaration, { role: "developer", content: "stable system" }];
    const user = { role: "user", content: [{ type: "input_text", text: "Read the file." }] };
    const payload = { model: "gpt", tool_choice: "auto", input: [...leading, markerItem, user] };
    const original = structuredClone({ payload, history });
    const expected = {
      ...payload,
      input: [
        ...leading,
        ...history,
        { role: "developer", content: [{ type: "input_text", text: COMPACTION_WORK_REPLAY_MESSAGE }] },
        nativeDeclaration,
        user,
      ],
    };
    assert.deepEqual(rewriteCheckpointForWork(payload, marker, history), expected);
    assert.deepEqual(rewriteCheckpointForWork(payload, marker, JSON.parse(JSON.stringify(history))), expected);
    assert.deepEqual({ payload, history }, original);
  });
}

test("restored native declarations stay fixed before later additions, redefinitions, and removals", () => {
  const prefix = [nativeDeclaration, { role: "developer", content: "stable system" }];
  const history = [checkpoint, reasoning, acknowledgement];
  const base = { input: [...prefix, markerItem] };
  const first = rewriteCheckpointForWork(base, marker, history).input as JsonObject[];
  const user = { role: "user", content: [{ type: "input_text", text: "Continue." }] };
  const additions = {
    type: "additional_tools",
    role: "developer",
    tools: [
      { ...tools[0], description: "Updated read" },
      { ...tools[0], name: "search" },
    ],
  };
  const removal = {
    role: "developer",
    content: "The following tools are no longer available. Do not call them:\n- write",
  };
  const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] };
  let previous = first;
  for (const tail of [[user], [user, additions, removal], [user, additions, removal, assistant]]) {
    const replay = rewriteCheckpointForWork({ input: [...base.input, ...tail] }, marker, history).input as JsonObject[];
    assert.deepEqual(replay.slice(0, previous.length), previous);
    assert.deepEqual(replay.slice(first.length), tail);
    assert.deepEqual(replay[first.length - 1], nativeDeclaration);
    previous = replay;
  }
});

test("maintenance expansion keeps native declarations only in their original prefix", () => {
  const payload = { input: [nativeDeclaration, markerItem] };
  assert.deepEqual(expandRemoteCompactionPayload(payload, { marker, replacementHistory: [checkpoint] }), {
    input: [nativeDeclaration, checkpoint],
  });
});

test("work replay does not add an absent tool choice or top-level tools", () => {
  const replay = rewriteCheckpointForWork({ input: [nativeDeclaration, markerItem] }, marker, [checkpoint]);
  assert.equal(Object.hasOwn(replay, "tool_choice"), false);
  assert.equal(Object.hasOwn(replay, "tools"), false);
  assert.deepEqual((replay.input as JsonObject[]).at(-1), nativeDeclaration);
});
