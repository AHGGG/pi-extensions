import assert from "node:assert/strict";
import {
  buildContextEntries,
  buildSessionContext,
  buildSessionProjection,
  type SessionEntry,
  SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createCheckpointDetails, fallbackSummary } from "../src/checkpoint.js";
import { projectedKeptMessages } from "../src/checkpoint-projection.js";
import {
  captureCompactionBranch,
  captureExactCompactionBranch,
  captureWarmCompactionBranch,
} from "../src/compaction-ownership.js";

function history(legacy = false) {
  const manager = SessionManager.inMemory();
  const archived = manager.appendMessage({ role: "user", content: "ARCHIVED-BODY", timestamp: 1 });
  const olderKept = manager.appendMessage({ role: "user", content: "older retained", timestamp: 2 });
  const retained = manager.appendMessage({ role: "user", content: "current retained", timestamp: 3 });
  const older = manager.appendCompaction("older summary", olderKept, 100, { blob: "SUPERSEDED-BLOB" });
  const tail = manager.appendMessage({ role: "user", content: "recent", timestamp: 4 });
  const details = createCheckpointDetails({
    provider: "fixture",
    api: "openai-responses",
    profile: "openai-responses-v1",
    modelId: "fixture",
    protocol: "responses-compact",
    replacementHistory: [{ type: "compaction", encrypted_content: "CURRENT-CIPHERTEXT" }],
    keptMessages: projectedKeptMessages(manager.getBranch(), tail, retained),
    ...(!legacy ? { snapshotLeafId: tail } : {}),
  });
  const checkpoint = manager.appendCompaction(fallbackSummary(details.checkpointId), retained, 200, details);
  return { manager, archived, olderKept, retained, older, tail, checkpoint };
}

for (const [name, capture] of [
  ["warm", captureWarmCompactionBranch],
  ["foreground", captureCompactionBranch],
  ["exact", captureExactCompactionBranch],
] as const) {
  test(`${name} hashes active input and latest opaque details, not irrelevant archives`, () => {
    const h = history();
    const serialized: string[] = [];
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
      const result = stringify(value, ...args);
      if (result) serialized.push(result);
      return result;
    });
    try {
      const current = capture(h.manager.getBranch());
      assert.equal(current(h.manager.getBranch()), true);
      assert.doesNotMatch(serialized.join("\n"), /ARCHIVED-BODY|SUPERSEDED-BLOB/);
      assert.match(serialized.join("\n"), /current retained/);
      assert.match(serialized.join("\n"), /CURRENT-CIPHERTEXT/);
      const archived = h.manager.getEntry(h.archived);
      const older = h.manager.getEntry(h.older);
      assert.ok(archived?.type === "message" && archived.message.role === "user");
      assert.ok(older?.type === "compaction");
      archived.message.content = "changed irrelevant archive";
      older.details = { blob: "changed superseded blob" };
      assert.equal(current(h.manager.getBranch()), true);
      const active = h.manager.getEntry(h.tail);
      assert.ok(active?.type === "message" && active.message.role === "user");
      active.message.content = "changed active same-ID body";
      assert.equal(current(h.manager.getBranch()), false);
    } finally {
      spy.mockRestore();
    }
  });

  for (const legacy of [false, true])
    test(`${name} rejects an older cutoff that invalidates ${legacy ? "legacy" : "warm"} replay only`, () => {
      const h = history(legacy);
      const current = capture(h.manager.getBranch());
      assert.equal(current(h.manager.getBranch()), true);
      const original = buildSessionContext(h.manager.getBranch());
      const older = h.manager.getEntry(h.older);
      assert.ok(older?.type === "compaction");
      older.firstKeptEntryId = h.tail;
      assert.deepEqual(buildSessionContext(h.manager.getBranch()), original);
      assert.equal(current(h.manager.getBranch()), false);
    });

  test(`${name} retains legacy raw-fingerprint validation of suppressed older summaries`, () => {
    const manager = SessionManager.inMemory();
    const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const older = manager.appendCompaction("oldest summary", first, 100);
    manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
    manager.appendCompaction("middle summary", first, 100);
    const tail = manager.appendMessage({ role: "user", content: "third", timestamp: 3 });
    const raw = buildContextEntries(manager.getBranch(), tail);
    const details = createCheckpointDetails({
      provider: "fixture",
      api: "openai-responses",
      profile: "openai-responses-v1",
      modelId: "fixture",
      protocol: "responses-compact",
      replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
      keptMessages: raw.slice(raw.findIndex((entry) => entry.id === first)).flatMap(sessionEntryToContextMessages),
    });
    manager.appendCompaction(fallbackSummary(details.checkpointId), first, 200, details);
    const current = capture(manager.getBranch());
    assert.equal(current(manager.getBranch()), true);
    const original = buildSessionContext(manager.getBranch());
    const entry = manager.getEntry(older);
    assert.ok(entry?.type === "compaction");
    entry.summary = "changed suppressed summary";
    assert.deepEqual(buildSessionContext(manager.getBranch()), original);
    assert.equal(current(manager.getBranch()), false);
  });

  for (const change of ["ciphertext", "model", "cutoff", "fingerprints", "malformed"] as const)
    test(`${name} rejects changed latest checkpoint ${change}`, () => {
      const h = history();
      const current = capture(h.manager.getBranch());
      const entry = h.manager.getEntry(h.checkpoint);
      assert.ok(entry?.type === "compaction");
      const details = entry.details as ReturnType<typeof createCheckpointDetails>;
      switch (change) {
        case "ciphertext":
          details.replacementHistory[0].encrypted_content = "changed ciphertext";
          break;
        case "model":
          details.modelId = "changed model";
          break;
        case "cutoff":
          details.snapshotLeafId = h.older;
          break;
        case "fingerprints":
          details.keptMessageFingerprints = [];
          break;
        case "malformed":
          entry.details = { ...details, version: 999 };
          break;
      }
      assert.equal(current(h.manager.getBranch()), false);
    });

  test(`${name} rejects missing, duplicate, cyclic, switched, or rewritten ancestry before projection`, () => {
    const h = history();
    const branch = h.manager.getBranch();
    const current = capture(branch);
    const leafId = branch.at(-1)?.id;
    assert.ok(leafId);
    const malformed: SessionEntry[][] = [
      branch.slice(1),
      branch.map((entry, index) => (index === 0 ? ({ ...entry, id: 42 } as unknown as SessionEntry) : entry)),
      [...branch.slice(0, 1), ...branch],
      branch.map((entry, index) => (index === 0 ? { ...entry, parentId: leafId } : entry)),
      branch.map((entry, index) => (index === 0 ? { ...entry, id: "other-root" } : entry)),
      branch.map((entry, index) => (index === 1 ? ({ ...entry, type: "custom" } as SessionEntry) : entry)),
    ];
    for (const entries of malformed) assert.equal(current(entries), false);
    for (const entries of malformed.slice(0, 5)) assert.equal(capture(entries)(entries), false);
  });
}

test("warm projection includes empty sources and applies suffix edits before filtering snapshot IDs", () => {
  const manager = SessionManager.inMemory();
  const hidden = manager.appendMessage({ role: "user", content: "hidden original", timestamp: 1 });
  manager.appendMessage({ role: "user", content: "visible tail", timestamp: 2 });
  manager.appendContextEdit(hidden, null);
  const current = captureWarmCompactionBranch(manager.getBranch());
  const projected = buildSessionProjection(manager.getBranch());
  assert.deepEqual(projected.entries.find(({ sourceEntry }) => sourceEntry.id === hidden)?.messages, []);
  manager.appendMessage({ role: "user", content: "new turn", timestamp: 3 });
  assert.equal(current(manager.getBranch()), true);
  manager.appendContextEdit(hidden, { content: "resurrected" });
  assert.equal(current(manager.getBranch()), false);
});
