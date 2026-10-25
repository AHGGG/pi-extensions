import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { captureScratchpadForCompaction, SCRATCHPAD_COMPACTION_BYTE_BUDGET } from "../src/scratchpad-compaction.js";
import { ScratchpadError, ScratchpadStore } from "../src/scratchpad-store.js";

const directories: string[] = [];
const time = "2026-10-25T09:00:00.000Z";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-scratchpad-compaction-"));
  directories.push(directory);
  return {
    directory,
    path: join(directory, "session-a.json"),
    store: new ScratchpadStore({ directory, now: () => new Date(time) }),
  };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("missing and empty scratchpads do not create files or enable omission", async () => {
  const { store, directory } = await fixture();
  assert.deepEqual(await captureScratchpadForCompaction("session-a", { store }), { kind: "empty" });
  assert.deepEqual(await readdir(directory), []);
  await store.execute("session-a", { action: "add", texts: ["temporary"] });
  await store.execute("session-a", { action: "delete", ids: [1] });
  assert.deepEqual(await captureScratchpadForCompaction("session-a", { store }), { kind: "empty" });
});

test("capture includes every item beyond the tool page limit without truncation", async () => {
  const { store } = await fixture();
  await store.execute("session-a", { action: "add", texts: Array.from({ length: 100 }, () => "note") });
  await store.execute("session-a", { action: "add", texts: Array.from({ length: 10 }, () => "more") });
  const snapshot = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind !== "ready") return;
  assert.equal(snapshot.itemCount, 110);
  const { items } = JSON.parse(snapshot.text);
  assert.equal(items.length, 110);
  assert.deepEqual(items.at(-1), { id: 110, text: "more", createdAt: time, updatedAt: time });
});

test("capture is queued behind pending writes and remains unchanged by later edits", async () => {
  const { store, path } = await fixture();
  const added = store.execute("session-a", { action: "add", texts: ["original"] });
  const pending = captureScratchpadForCompaction("session-a", { store });
  await added;
  const snapshot = await pending;
  assert.equal(snapshot.kind, "ready");
  const document = JSON.parse(await readFile(path, "utf8"));
  document.items[0].text = "external edit";
  document.items[0].ignoredField = "not note content";
  await writeFile(path, JSON.stringify(document));
  const latest = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(latest.kind, "ready");
  if (snapshot.kind === "ready" && latest.kind === "ready") {
    assert.equal(JSON.parse(snapshot.text).items[0].text, "original");
    assert.equal(JSON.parse(latest.text).items[0].text, "external edit");
    assert.equal(latest.text.includes("ignoredField"), false);
  }
});

test("serialized-byte budget accepts the complete boundary and rejects one extra byte", async () => {
  const { store, path } = await fixture();
  const empty = [1, 2].map((id) => ({ id, text: "", createdAt: time, updatedAt: time }));
  const overhead = Buffer.byteLength(JSON.stringify({ items: empty }), "utf8");
  await store.execute("session-a", {
    action: "add",
    texts: ["a".repeat(8000), "b".repeat(SCRATCHPAD_COMPACTION_BYTE_BUDGET - overhead - 8000)],
  });
  const snapshot = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind === "ready") assert.equal(Buffer.byteLength(snapshot.text), SCRATCHPAD_COMPACTION_BYTE_BUDGET);
  const document = JSON.parse(await readFile(path, "utf8"));
  document.items[1].text += "b";
  await writeFile(path, JSON.stringify(document));
  assert.deepEqual(await captureScratchpadForCompaction("session-a", { store }), {
    kind: "unavailable",
    reason: "oversized",
  });
});

test("malformed or oversized files produce only fixed safe fallback reasons", async () => {
  const { store, path } = await fixture();
  await writeFile(path, "private malformed note: secret-123");
  const before = await readFile(path, "utf8");
  assert.deepEqual(await captureScratchpadForCompaction("session-a", { store }), {
    kind: "unavailable",
    reason: "unreadable",
  });
  assert.equal(await readFile(path, "utf8"), before);
  await writeFile(path, "x".repeat(1024 * 1024 + 1));
  assert.deepEqual(await captureScratchpadForCompaction("session-a", { store }), {
    kind: "unavailable",
    reason: "oversized",
  });
});

test("snapshot is session-scoped and provides raw plus escaped echo redaction values", async () => {
  const { store } = await fixture();
  const note = 'Private "quoted"\nnote';
  await store.execute("session-a", { action: "add", texts: [note] });
  assert.deepEqual(await captureScratchpadForCompaction("session-b", { store }), { kind: "empty" });
  const snapshot = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind !== "ready") return;
  assert.ok(snapshot.redactionValues.includes(note));
  assert.ok(snapshot.redactionValues.includes(JSON.stringify(note).slice(1, -1)));
  assert.ok(snapshot.redactionValues.includes(snapshot.text));
});

test("cancellation and changed ownership propagate instead of enabling a fallback request", async () => {
  const { store } = await fixture();
  const controller = new AbortController();
  controller.abort();
  for (const [options, code] of [
    [{ signal: controller.signal }, "CANCELLED"],
    [{ isCurrent: () => false }, "SESSION_CHANGED"],
  ] as const) {
    await assert.rejects(
      captureScratchpadForCompaction("session-a", { store, ...options }),
      (error: unknown) => error instanceof ScratchpadError && error.code === code,
    );
  }
});
