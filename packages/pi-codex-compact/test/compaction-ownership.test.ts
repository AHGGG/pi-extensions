import assert from "node:assert/strict";
import { buildSessionContext, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  captureCompactionBranch,
  captureExactCompactionBranch,
  capturePrefixCompactionBranch,
} from "../src/compaction-ownership.js";

function fixture() {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "First input", timestamp: 1 });
  const tail = manager.appendMessage({ role: "user", content: "Tail input", timestamp: 2 });
  const captured = manager.getBranch();
  return { manager, first, tail, captured, isCurrent: captureCompactionBranch(captured) };
}

test("allows all Pi bookkeeping entry types and projection-equivalent context edits", () => {
  const h = fixture();
  h.manager.appendCustomEntry("unknown-extension-state", { arbitrary: ["data"] });
  h.manager.appendUsage("maintenance", "openai", "fixture", {
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  h.manager.appendLabelChange(h.tail, "Bookmark");
  h.manager.appendSessionInfo("New name");
  h.manager.appendContextEdit(h.first, { content: "First input" });
  assert.deepEqual(buildSessionContext(h.captured), h.manager.buildSessionContext());
  assert.equal(h.isCurrent(h.manager.getBranch()), true);
});

test("uses the finalized projection when the snapshot already contains omissions and replacements", () => {
  const h = fixture();
  h.manager.appendContextEdit(h.first, null);
  h.manager.appendContextEdit(h.tail, { content: "Replaced before compaction" });
  const isCurrent = captureCompactionBranch(h.manager.getBranch());
  h.manager.appendCustomEntry("bookkeeping", null);
  assert.equal(isCurrent(h.manager.getBranch()), true);
  h.manager.appendContextEdit(h.tail, { content: "Changed during compaction" });
  assert.equal(isCurrent(h.manager.getBranch()), false);
});

for (const kind of ["new-message", "hidden-message", "model", "thinking", "compaction", "branch-summary"] as const) {
  test(`rejects ${kind} rather than treating it as bookkeeping`, () => {
    const h = fixture();
    switch (kind) {
      case "new-message": {
        const added = h.manager.appendMessage({ role: "user", content: "New input", timestamp: 3 });
        h.manager.appendContextEdit(added, null);
        // Even a later omission does not make a newly added conversation turn bookkeeping.
        assert.deepEqual(h.manager.buildSessionContext().messages, buildSessionContext(h.captured).messages);
        break;
      }
      case "hidden-message":
        h.manager.appendCustomMessageEntry("hidden", "New contract", false);
        break;
      case "model":
        h.manager.appendModelChange("openai", "fixture");
        break;
      case "thinking":
        h.manager.appendThinkingLevelChange("high");
        break;
      case "compaction":
        h.manager.appendCompaction("New summary", h.tail, 100);
        break;
      case "branch-summary":
        h.manager.branchWithSummary(h.tail, "New branch summary");
        break;
    }
    assert.equal(h.isCurrent(h.manager.getBranch()), false);
  });
}

test("requires unchanged ancestry and direct descendant links, not merely equal projected messages", () => {
  const h = fixture();
  assert.equal(h.isCurrent(structuredClone(h.captured)), true);
  for (const changed of [
    h.captured.slice(0, 1),
    [
      { ...h.captured[0], id: "other-root" },
      { ...h.captured[1], parentId: "other-root" },
    ],
    [...h.captured, { type: "custom", customType: "state", id: "extra", parentId: h.first, timestamp: "2026-01-01" }],
  ] as SessionEntry[][]) {
    assert.equal(h.isCurrent(changed), false);
  }
});

test("compares persisted values rather than schema symbols or object prototypes", () => {
  const h = fixture();
  h.manager.appendCustomEntry("serializable-state", {
    source: new URL("https://example.test"),
    [Symbol("internal-metadata")]: "not persisted",
  });
  const isCurrent = captureCompactionBranch(h.manager.getBranch());
  assert.equal(isCurrent(h.manager.getBranch()), true);
});

test("rejects duplicate descendant IDs before projecting potentially cyclic ancestry", () => {
  const h = fixture();
  assert.equal(
    h.isCurrent([
      ...h.captured,
      {
        type: "custom",
        customType: "state",
        id: h.tail,
        parentId: h.tail,
        timestamp: "2026-01-01",
      },
    ]),
    false,
  );
});

test("snapshot values cannot be changed through shared event entry references", () => {
  const h = fixture();
  const tail = h.captured[1];
  assert.ok(tail.type === "message" && tail.message.role === "user");
  tail.message.content = "Mutated same-ID input";
  assert.equal(h.isCurrent(h.manager.getBranch()), false);
});

test("changes to opaque checkpoint details cannot bypass ownership through unchanged summary text", () => {
  const h = fixture();
  const checkpoint = h.manager.appendCompaction("Same summary", h.tail, 100, { encrypted: "old" });
  const isCurrent = captureCompactionBranch(h.manager.getBranch());
  const entry = h.manager.getEntry(checkpoint);
  assert.ok(entry?.type === "compaction");
  entry.details = { encrypted: "changed" };
  assert.equal(isCurrent(h.manager.getBranch()), false);
});

test("empty snapshots permit bookkeeping roots but not conversation roots", () => {
  const isCurrent = captureCompactionBranch([]);
  assert.equal(isCurrent([]), true);
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("state", {});
  assert.equal(isCurrent(manager.getBranch()), true);
  manager.appendMessage({ role: "user", content: "New input", timestamp: 1 });
  assert.equal(isCurrent(manager.getBranch()), false);
});

test("only Text summary prefix/bookkeeping guards permit appended thinking metadata", () => {
  const h = fixture();
  h.manager.appendThinkingLevelChange("low");
  const entries = h.manager.getBranch();
  const prefix = capturePrefixCompactionBranch(entries, undefined, true);
  const bookkeeping = captureCompactionBranch(entries, true);
  const exact = captureExactCompactionBranch(entries);
  const opaque = capturePrefixCompactionBranch(entries);
  h.manager.appendThinkingLevelChange("high");
  assert.equal(prefix(h.manager.getBranch()), true);
  assert.equal(bookkeeping(h.manager.getBranch()), true);
  assert.equal(exact(h.manager.getBranch()), false);
  assert.equal(opaque(h.manager.getBranch()), false);
  const changed = structuredClone(h.manager.getBranch());
  const originalThinking = changed.find((entry) => entry.type === "thinking_level_change");
  assert.ok(originalThinking?.type === "thinking_level_change");
  originalThinking.thinkingLevel = "medium";
  assert.equal(prefix(changed), false);
  h.manager.appendModelChange("openai", "fixture");
  assert.equal(prefix(h.manager.getBranch()), false);
  assert.equal(bookkeeping(h.manager.getBranch()), false);
});
