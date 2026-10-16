import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildContextEntries,
  buildSessionContext,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  createCheckpointDetails,
  fallbackSummary,
  latestCheckpoint,
  projectCheckpointContext,
} from "../src/checkpoint.js";
import {
  checkpointKeptMessages,
  projectedKeptMessages,
  projectSessionCheckpointContext,
} from "../src/checkpoint-projection.js";

function user(id: string, time: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(time).toISOString(),
    message: { role: "user", content: id, timestamp: time },
  };
}
function chain(entries: SessionEntry[]): SessionEntry[] {
  return entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
}
function compact(id: string, kept: AgentMessage[], firstKeptEntryId = "first", snapshotLeafId?: string): SessionEntry {
  const details = createCheckpointDetails({
    provider: "openai-codex",
    api: "openai-codex-responses",
    profile: "codex-responses-v1",
    modelId: "fixture-model",
    protocol: "remote-v2",
    replacementHistory: [{ type: "compaction", encrypted_content: "synthetic-opaque" }],
    keptMessages: kept,
    checkpointId: `checkpoint-${id}`,
    snapshotLeafId,
  });
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: new Date(100).toISOString(),
    summary: fallbackSummary(details.checkpointId),
    firstKeptEntryId,
    tokensBefore: 100,
    details,
  };
}
function edit(id: string, targetId: string, replacement: { content: string } | null): SessionEntry {
  return { type: "context_edit", id, parentId: null, timestamp: new Date(50).toISOString(), targetId, replacement };
}

function bookkeeping(id: string): SessionEntry {
  return { type: "custom", id, parentId: null, timestamp: new Date(30).toISOString(), customType: "fixture" };
}

function toolCall(id: string, time: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "fixture.txt" } }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "fixture-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: time,
    },
  };
}

function toolResult(id: string, time: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(time).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "fixture content" }],
      isError: false,
      timestamp: time,
    },
  };
}

for (const legacy of [true, false]) {
  for (const replacement of [null, { content: "edited before compaction" }]) {
    test(`projects ${legacy ? "legacy raw" : "canonical"} checkpoint with preexisting ${replacement ? "replacement" : "omission"}`, () => {
      const before = chain([user("first", 1), user("second", 2), edit("edit", "first", replacement)]);
      const kept = legacy
        ? buildContextEntries(before, "edit").flatMap(sessionEntryToContextMessages)
        : projectedKeptMessages(before, "edit", "first");
      const entries = chain([...before, compact("active", kept), user("later", 200)]);
      const checkpoint = latestCheckpoint(entries);
      assert.ok(checkpoint);
      const messages = buildSessionContext(entries).messages;
      if (legacy)
        assert.equal(projectCheckpointContext(messages, checkpoint.details, checkpoint.entry.summary), undefined);
      const projected = projectSessionCheckpointContext(messages, entries, checkpoint);
      assert.ok(projected);
      assert.equal(projected.length, 2);
      const lastEntry = entries.at(-1);
      assert.ok(lastEntry);
      assert.deepEqual(projected[1], sessionEntryToContextMessages(lastEntry)[0]);
      // An ordinary appended turn preserves the exact model-visible prefix.
      const next = chain([...entries, user("next", 201)]);
      assert.deepEqual(
        projectSessionCheckpointContext(buildSessionContext(next).messages, next, checkpoint)?.slice(0, 2),
        projected,
      );
      assert.equal(projectSessionCheckpointContext(projected, entries, checkpoint), undefined);
    });
  }
}

test("verifies nested legacy checkpoints when older summaries disappear from Pi context", () => {
  const first = user("first", 1);
  const initial = chain([first, compact("older", sessionEntryToContextMessages(first)), user("second", 2)]);
  const before = chain([
    ...initial,
    compact("middle", projectedKeptMessages(initial, "second", "first")),
    user("third", 3),
  ]);
  const raw = buildContextEntries(before, "third");
  const index = raw.findIndex((entry) => entry.id === "first");
  const entries = chain([
    ...before,
    compact("active", raw.slice(index).flatMap(sessionEntryToContextMessages)),
    user("later", 200),
  ]);
  const checkpoint = latestCheckpoint(entries);
  assert.ok(checkpoint);
  const messages = buildSessionContext(entries).messages;
  assert.equal(projectCheckpointContext(messages, checkpoint.details, checkpoint.entry.summary), undefined);
  assert.equal(projectSessionCheckpointContext(messages, entries, checkpoint)?.length, 2);
  assert.deepEqual(
    projectedKeptMessages(entries, "later", "first").map((message) => message.role),
    ["user", "user", "user", "user"],
  );
});

test("does not guess missing snapshots, mutated retained content, or post-checkpoint edits", () => {
  const first = user("first", 1);
  const entries = chain([first, compact("active", sessionEntryToContextMessages(first)), user("later", 200)]);
  const checkpoint = latestCheckpoint(entries);
  assert.ok(checkpoint);
  for (const replacement of [null, { content: "edited after compaction" }]) {
    const edited = chain([...entries, edit("late-edit", "first", replacement)]);
    assert.equal(projectSessionCheckpointContext(buildSessionContext(edited).messages, edited, checkpoint), undefined);
  }
  assert.equal(
    projectSessionCheckpointContext(buildSessionContext(entries).messages, entries.slice(1), checkpoint),
    undefined,
  );
  const mutated = chain([user("mutated", 1), ...entries.slice(1)]);
  assert.equal(projectSessionCheckpointContext(buildSessionContext(entries).messages, mutated, checkpoint), undefined);
});

test("warm checkpoints replay every uncovered message once through resume, reload, and fork", () => {
  const before = chain([user("first", 1), user("covered", 2), bookkeeping("snapshot")]);
  // Identical bytes across the cutoff must not suppress the new occurrence.
  const duplicate = { ...user("covered", 2), id: "duplicate" };
  const suffix = [bookkeeping("suffix-state"), duplicate, toolCall("call", 40), toolResult("result", 41)];
  const parent = chain([...before, ...suffix]);
  const kept = checkpointKeptMessages(parent, "result", "first", "snapshot");
  assert.deepEqual(kept, before.flatMap(sessionEntryToContextMessages));
  const entries = chain([...parent, compact("warm", kept, "first", "snapshot"), user("later", 200)]);
  const expectedSuffix = [...suffix, ...entries.slice(-1)].flatMap(sessionEntryToContextMessages);
  let previous: AgentMessage[] | undefined;
  for (const restored of [entries, JSON.parse(JSON.stringify(entries)) as SessionEntry[]]) {
    const checkpoint = latestCheckpoint(restored);
    assert.ok(checkpoint);
    const projected = projectSessionCheckpointContext(buildSessionContext(restored).messages, restored, checkpoint);
    assert.ok(projected);
    assert.match(JSON.stringify(projected[0]), /checkpoint-warm/);
    assert.deepEqual(projected.slice(1), expectedSuffix);
    if (previous) assert.deepEqual(projected, previous);
    previous = projected;
    const forked = chain([...restored.slice(0, -1), user("fork", 201)]);
    assert.deepEqual(
      projectSessionCheckpointContext(buildSessionContext(forked).messages, forked, checkpoint)?.slice(1),
      [...suffix, ...forked.slice(-1)].flatMap(sessionEntryToContextMessages),
    );
    const next = chain([...restored, user("next", 202)]);
    assert.deepEqual(
      projectSessionCheckpointContext(buildSessionContext(next).messages, next, checkpoint)?.slice(0, projected.length),
      projected,
    );
  }
});

test("a retained cut after the snapshot keeps an uncovered tool pair intact", () => {
  const parent = chain([
    user("first", 1),
    bookkeeping("snapshot"),
    bookkeeping("suffix-state"),
    toolCall("call", 40),
    toolResult("result", 41),
  ]);
  for (const firstKeptEntryId of ["suffix-state", "call"]) {
    const kept = checkpointKeptMessages(parent, "result", firstKeptEntryId, "snapshot");
    assert.deepEqual(kept, []);
    const entries = chain([...parent, compact("warm", kept, firstKeptEntryId, "snapshot")]);
    const checkpoint = latestCheckpoint(entries);
    assert.ok(checkpoint);
    assert.deepEqual(
      projectSessionCheckpointContext(buildSessionContext(entries).messages, entries, checkpoint)?.slice(1),
      parent.slice(-2).flatMap(sessionEntryToContextMessages),
    );
  }
  assert.throws(() => checkpointKeptMessages(parent, "result", "result", "snapshot"), /skips messages/);
  const skipped = chain([...parent, compact("warm", [], "result", "snapshot")]);
  const invalid = latestCheckpoint(skipped);
  assert.ok(invalid);
  assert.equal(projectSessionCheckpointContext(buildSessionContext(skipped).messages, skipped, invalid), undefined);
});

test("tool results after the cutoff remain when their call is snapshot-covered", () => {
  const parent = chain([user("first", 1), toolCall("snapshot", 20), toolResult("result", 40)]);
  const kept = checkpointKeptMessages(parent, "result", "first", "snapshot");
  assert.deepEqual(kept, parent.slice(0, 2).flatMap(sessionEntryToContextMessages));
  const entries = chain([...parent, compact("warm", kept, "first", "snapshot")]);
  const checkpoint = latestCheckpoint(entries);
  assert.ok(checkpoint);
  assert.deepEqual(
    projectSessionCheckpointContext(buildSessionContext(entries).messages, entries, checkpoint)?.slice(1),
    sessionEntryToContextMessages(parent[2]),
  );
});

test("warm checkpoints reconstruct nested compaction without replaying covered summaries", () => {
  const first = user("first", 1);
  const before = chain([
    first,
    compact("older", sessionEntryToContextMessages(first)),
    user("second", 2),
    bookkeeping("snapshot"),
  ]);
  const parent = chain([...before, user("suffix", 40)]);
  const kept = checkpointKeptMessages(parent, "suffix", "first", "snapshot");
  assert.deepEqual(
    kept.map((message) => message.role),
    ["user", "user"],
  );
  const entries = chain([...parent, compact("warm", kept, "first", "snapshot"), user("later", 200)]);
  const checkpoint = latestCheckpoint(entries);
  assert.ok(checkpoint);
  const projected = projectSessionCheckpointContext(buildSessionContext(entries).messages, entries, checkpoint);
  assert.deepEqual(
    projected?.slice(1),
    [...parent.slice(-1), ...entries.slice(-1)].flatMap(sessionEntryToContextMessages),
  );
});

test("warm checkpoints reject missing or nonancestor cutoffs and incomplete parent ancestry", () => {
  const parent = chain([user("first", 1), user("snapshot", 2), user("suffix", 3)]);
  const offBranch = { ...user("fork", 4), parentId: "first" };
  for (const snapshotLeafId of ["missing", "fork"]) {
    const entries = chain([...parent, compact("warm", [], "first", snapshotLeafId)]);
    entries.push(offBranch);
    const checkpoint = latestCheckpoint(entries);
    assert.ok(checkpoint);
    assert.equal(
      projectSessionCheckpointContext(buildSessionContext(entries, "warm").messages, entries, checkpoint),
      undefined,
    );
    assert.throws(() => checkpointKeptMessages([...parent, offBranch], "suffix", "first", snapshotLeafId), /ancestor/);
  }
  assert.throws(() => checkpointKeptMessages(parent, "missing", "first", "snapshot"), /ancestry/);
  assert.throws(() => checkpointKeptMessages(parent.slice(1), "suffix", "snapshot", "snapshot"), /ancestry/);
  assert.throws(() => checkpointKeptMessages(parent, null, "first", "snapshot"), /ancestor/);
});

test("warm checkpoints reject snapshot prefix edits before adoption, including discarded messages", () => {
  const before = chain([user("first", 1), user("kept", 2), bookkeeping("snapshot")]);
  for (const replacement of [null, { content: "changed" }]) {
    for (const targetId of ["first", "kept"]) {
      const parent = chain([...before, edit("edit", targetId, replacement), user("suffix", 40)]);
      assert.throws(() => checkpointKeptMessages(parent, "suffix", "kept", "snapshot"), /prefix changed/);
      const entries = chain([
        ...parent,
        compact("warm", checkpointKeptMessages(before, "snapshot", "kept", "snapshot"), "kept", "snapshot"),
      ]);
      const checkpoint = latestCheckpoint(entries);
      assert.ok(checkpoint);
      assert.equal(
        projectSessionCheckpointContext(buildSessionContext(entries).messages, entries, checkpoint),
        undefined,
      );
    }
  }
});

test("warm checkpoints preserve existing edits and reject later edits to retained covered messages", () => {
  for (const replacement of [null, { content: "edited before snapshot" }]) {
    const before = chain([user("first", 1), edit("snapshot", "first", replacement)]);
    const parent = chain([...before, user("suffix", 40)]);
    const kept = checkpointKeptMessages(parent, "suffix", "first", "snapshot");
    const entries = chain([...parent, compact("warm", kept, "first", "snapshot")]);
    const checkpoint = latestCheckpoint(entries);
    assert.ok(checkpoint);
    const projected = projectSessionCheckpointContext(buildSessionContext(entries).messages, entries, checkpoint);
    assert.deepEqual(projected?.slice(1), parent.slice(-1).flatMap(sessionEntryToContextMessages));
    const edited = chain([...entries, edit("later-edit", "first", { content: "changed after checkpoint" })]);
    assert.equal(projectSessionCheckpointContext(buildSessionContext(edited).messages, edited, checkpoint), undefined);
  }
});

test("warm checkpoints retain edited suffix contributions and allow bookkeeping-only extensions", () => {
  const before = chain([user("first", 1), bookkeeping("snapshot")]);
  const parent = chain([
    ...before,
    user("suffix", 40),
    edit("suffix-edit", "suffix", { content: "edited uncovered message" }),
    bookkeeping("parent"),
  ]);
  const kept = checkpointKeptMessages(parent, "parent", "first", "snapshot");
  assert.deepEqual(kept, sessionEntryToContextMessages(before[0]));
  const entries = chain([...parent, compact("warm", kept, "first", "snapshot")]);
  const checkpoint = latestCheckpoint(entries);
  assert.ok(checkpoint);
  assert.deepEqual(
    projectSessionCheckpointContext(buildSessionContext(entries).messages, entries, checkpoint)?.slice(1),
    [{ role: "user", content: "edited uncovered message", timestamp: 40 }],
  );
  const onlyBookkeeping = chain([...before, bookkeeping("parent")]);
  assert.deepEqual(checkpointKeptMessages(onlyBookkeeping, "parent", "parent", "snapshot"), []);
});

test("warm checkpoints reject intervening prefix transitions and corrupted covered fingerprints", () => {
  const before = chain([user("first", 1), bookkeeping("snapshot")]);
  const kept = checkpointKeptMessages(before, "snapshot", "first", "snapshot");
  const changed = chain([...before, compact("intervening", kept), user("suffix", 40)]);
  assert.throws(() => checkpointKeptMessages(changed, "suffix", "first", "snapshot"), /prefix changed/);
  const entries = chain([...before, user("suffix", 40), compact("warm", [], "first", "snapshot")]);
  const checkpoint = latestCheckpoint(entries);
  assert.ok(checkpoint);
  assert.equal(projectSessionCheckpointContext(buildSessionContext(entries).messages, entries, checkpoint), undefined);
});

test("warm retained cuts cannot skip an uncovered system-message source", () => {
  const system: SessionEntry = {
    type: "message",
    id: "system",
    parentId: null,
    timestamp: new Date(20).toISOString(),
    message: { role: "system", content: "new system context", timestamp: 20 },
  };
  const entries = chain([user("first", 1), bookkeeping("snapshot"), system, user("suffix", 40)]);
  assert.throws(() => checkpointKeptMessages(entries, "suffix", "suffix", "snapshot"), /skips messages/);
  assert.deepEqual(checkpointKeptMessages(entries, "suffix", "system", "snapshot"), []);
});
