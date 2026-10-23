import assert from "node:assert/strict";
import { test } from "vitest";
import { RecoveryOutput } from "../src/recovery-output.js";

const message = {
  type: "message",
  id: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "secret summary" }],
};
const added = { type: "response.output_item.added", output_index: 0, item: message };
const done = { ...added, type: "response.output_item.done" };
const terminal = { type: "response.completed", response: { status: "completed", output: [] } };

for (const [name, events] of [
  ["unsuccessful event before completion", [{ type: "response.incomplete" }, added, done, terminal]],
  ["failed event before completion", [{ type: "response.failed" }, added, done, terminal]],
  ["error event", [{ type: "error" }, added, done, terminal]],
  ["unsafe start role", [{ ...added, item: { ...message, role: "user" } }, done, terminal]],
  [
    "unsafe start refusal",
    [{ ...added, item: { ...message, content: [{ type: "refusal", refusal: "no" }] } }, done, terminal],
  ],
  [
    "duplicate created",
    [
      { type: "response.created", response: { id: "a" } },
      { type: "response.created", response: { id: "b" } },
    ],
  ],
  [
    "mismatched terminal identity",
    [
      { type: "response.created", response: { id: "a" } },
      added,
      done,
      { ...terminal, response: { ...terminal.response, id: "b" } },
    ],
  ],
  ["missing done", [added, terminal]],
  ["missing added", [done, terminal]],
  ["missing lower index", [{ ...added, output_index: 1 }, { ...done, output_index: 1 }, terminal]],
  ["negative index", [{ ...added, output_index: -1 }]],
  ["fractional index", [{ ...added, output_index: 0.5 }]],
  ["missing index", [{ type: added.type, item: message }]],
  ["missing id", [{ ...added, item: { ...message, id: undefined } }]],
  ["duplicate added", [added, added]],
  ["duplicate id", [added, { ...added, output_index: 1 }]],
  ["duplicate done", [added, done, done]],
  ["changed id", [added, { ...done, item: { ...message, id: "other" } }]],
  ["changed type", [added, { ...done, item: { ...message, type: "reasoning" } }]],
  ["unfinished item", [added, { ...done, item: { ...message, status: "in_progress" } }]],
  ["unsafe tool", [{ ...added, item: { ...message, type: "function_call" } }]],
  ["unsafe role", [added, { ...done, item: { ...message, role: "user" } }]],
  ["refusal", [added, { ...done, item: { ...message, content: [{ type: "refusal", refusal: "no" }] } }]],
  ["malformed text", [added, { ...done, item: { ...message, content: [{ type: "output_text", text: 42 }] } }]],
  ["omitted terminal output", [added, done, { ...terminal, response: { status: "completed" } }]],
  ["incomplete terminal", [added, done, { ...terminal, response: { status: "incomplete", output: [] } }]],
  ["errored terminal", [added, done, { ...terminal, response: { status: "completed", output: [], error: {} } }]],
  ["duplicate terminal", [added, done, terminal, terminal]],
  ["item after terminal", [added, done, terminal, done]],
  ["no items", [terminal]],
] as const) {
  test(`recovery inventory rejects ${name}`, () => {
    const output = new RecoveryOutput();
    assert.throws(() => {
      for (const event of events) output.observe(event);
      if (!output.terminalSeen) output.observe(terminal);
    });
  });
}

test("empty terminal chooses complete done inventory and emits only content-free diagnostics", () => {
  const output = new RecoveryOutput();
  for (const event of [added, done, terminal]) output.observe(event);
  output.assertMatches("secret summary");
  assert.equal(output.terminalSeen, true);
  assert.match(
    output.diagnostic("different text"),
    /source=output_item_done; addedItems=1; doneItems=1; terminalItems=0; validatedTextBytes=14; providerTextBytes=14/,
  );
  assert.throws(
    () => output.assertMatches("different text"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /terminal text conflicts/);
      assert.doesNotMatch(error.message, /secret summary|different text/);
      return true;
    },
  );
});

test("nonempty terminal stays authoritative even when complete streamed inventory matches Pi", () => {
  const output = new RecoveryOutput();
  for (const event of [added, done]) output.observe(event);
  output.observe({
    ...terminal,
    response: { status: "completed", output: [{ ...message, content: [{ type: "output_text", text: "other" }] }] },
  });
  assert.throws(() => output.assertMatches("secret summary"), /source=terminal/);
});

test("terminal-only completed output retains compatibility without a partial streamed lifecycle", () => {
  const output = new RecoveryOutput();
  output.observe({ ...terminal, response: { status: "completed", output: [message] } });
  output.assertMatches("secret summary");
});

test("unindexed done items retain full-terminal compatibility but cannot justify empty output", () => {
  const output = new RecoveryOutput();
  output.observe({ type: "response.output_item.done", item: message });
  output.observe({ ...terminal, response: { status: "completed", output: [message] } });
  output.assertMatches("secret summary");
});
