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
  assert.deepEqual(items.at(-1), { id: 110, representation: "full", text: "more", createdAt: time, updatedAt: time });
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

test("mixed serialized-byte budget accepts the boundary and falls back on one extra byte", async () => {
  const { store, path } = await fixture();
  const empty = [1, 2].map((id) => ({ id, representation: "full", text: "", createdAt: time, updatedAt: time }));
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
  const fallback = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(fallback.kind, "ready");
  if (fallback.kind !== "ready") return;
  assert.equal(fallback.mode, "summary-only");
  assert.deepEqual(
    JSON.parse(fallback.text).items,
    [1, 2].map((id) => ({ id, representation: "omitted" })),
  );
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

test("compaction uses semantic summaries only beyond the 2 KiB UTF-8 boundary and preserves full notes", async () => {
  const { store, path } = await fixture();
  const entries = [
    { text: "🙂".repeat(512), summary: "At threshold: keep full." },
    { text: `${"🙂".repeat(512)}x`, summary: 'Compact "summary"\nwith reference.' },
    { text: "l".repeat(3000) },
  ] as const;
  await store.execute("session-a", { action: "add", items: entries });
  const before = await readFile(path, "utf8");
  const snapshot = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind !== "ready") return;
  const { items } = JSON.parse(snapshot.text);
  assert.deepEqual(
    items.map((item: { representation: string }) => item.representation),
    ["full", "summary", "full"],
  );
  assert.deepEqual(
    items.map((item: { text: string }) => item.text),
    [entries[0].text, entries[1].summary, entries[2].text],
  );
  assert.equal(snapshot.text.includes("summaryTextHash"), false);
  for (const value of [entries[1].text, entries[1].summary]) {
    assert.ok(snapshot.redactionValues.includes(value));
    assert.ok(snapshot.redactionValues.includes(JSON.stringify(value).slice(1, -1)));
  }
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await store.readSnapshot("session-a"))[1].text, entries[1].text);
});

test("stale summaries fall back to full text without truncation or mutations", async () => {
  const { store, path } = await fixture();
  await store.execute("session-a", { action: "add", items: [{ text: "a".repeat(3000), summary: "Old summary" }] });
  const document = JSON.parse(await readFile(path, "utf8"));
  document.items[0].text = "b".repeat(4000);
  const raw = JSON.stringify(document);
  await writeFile(path, raw);
  const snapshot = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind !== "ready") return;
  const [item] = JSON.parse(snapshot.text).items;
  assert.equal(item.representation, "full");
  assert.equal(item.text, document.items[0].text);
  assert.equal(snapshot.text.includes("Old summary"), false);
  assert.equal(await readFile(path, "utf8"), raw);
});

test("summaries can make a complete snapshot fit, but total overflow returns only an omission marker", async () => {
  const { store } = await fixture();
  await store.execute("session-a", {
    action: "add",
    items: Array.from({ length: 8 }, () => ({
      text: "x".repeat(8000),
      summary: "Verified progress; remaining blocker.",
    })),
  });
  const snapshot = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind === "ready") assert.equal(JSON.parse(snapshot.text).items.length, 8);
  await store.execute("session-a", {
    action: "add",
    items: Array.from({ length: 20 }, () => ({ text: "x".repeat(8000), summary: "s".repeat(1024) })),
  });
  assert.deepEqual(await captureScratchpadForCompaction("session-a", { store }), {
    kind: "omitted",
    reason: "oversized",
  });
});

test("summary-only fallback includes short summaries and marks missing or stale content without mutation", async () => {
  const { store, path } = await fixture();
  const summary = 'Private "semantic"\n🙂 summary';
  await store.execute("session-a", {
    action: "add",
    items: [
      { text: "short", summary },
      { text: "long".repeat(2000), summary: "stale secret" },
      { text: "missing".repeat(1100) },
      { text: "overflow".repeat(200) },
    ],
  });
  const document = JSON.parse(await readFile(path, "utf8"));
  document.items[1].text += "x";
  const before = JSON.stringify(document);
  await writeFile(path, before);
  const snapshot = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind !== "ready") return;
  assert.equal(snapshot.mode, "summary-only");
  assert.equal(snapshot.itemCount, 4);
  assert.deepEqual(JSON.parse(snapshot.text).items, [
    { id: 1, representation: "summary", text: summary },
    ...[2, 3, 4].map((id) => ({ id, representation: "omitted" })),
  ]);
  assert.doesNotMatch(snapshot.text, /stale secret|missing|overflow|createdAt|summaryTextHash/);
  for (const value of [summary, document.items[1].text]) {
    assert.ok(snapshot.redactionValues.includes(value));
    assert.ok(snapshot.redactionValues.includes(JSON.stringify(value).slice(1, -1)));
  }
  assert.equal(await readFile(path, "utf8"), before);
});

test("summary-only serialized UTF-8 budget includes escaping and accepts exactly the boundary", async () => {
  const { store } = await fixture();
  const entries = Array.from({ length: 16 }, (_, index) => ({
    id: index + 1,
    representation: "summary",
    text: "",
  }));
  const overhead = Buffer.byteLength(JSON.stringify({ items: entries }));
  const summary = "🙂".repeat(240);
  const remaining = SCRATCHPAD_COMPACTION_BYTE_BUDGET - overhead - 15 * Buffer.byteLength(summary);
  // JSON escaping makes this summary's serialized length greater than its raw bytes.
  const last = '"'.repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  await store.execute("session-a", {
    action: "add",
    items: entries.map((_, index) => ({
      text: "f".repeat(2048),
      summary: index < 15 ? summary : last,
    })),
  });
  const snapshot = await captureScratchpadForCompaction("session-a", { store });
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind !== "ready") return;
  assert.equal(snapshot.mode, "summary-only");
  assert.equal(Buffer.byteLength(snapshot.text), SCRATCHPAD_COMPACTION_BYTE_BUDGET);
  await store.execute("session-a", { action: "update", items: [{ id: 16, summary: `${last}x` }] });
  assert.deepEqual(await captureScratchpadForCompaction("session-a", { store }), {
    kind: "omitted",
    reason: "oversized",
  });
});
