import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { SCRATCHPAD_LIMITS, ScratchpadError, ScratchpadStore } from "../src/scratchpad-store.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-scratchpad-"));
  directories.push(directory);
  let time = new Date("2026-10-25T09:00:00.000Z");
  return {
    directory,
    path: join(directory, "session-a.json"),
    store: new ScratchpadStore({ directory, now: () => time }),
    advance: () => {
      time = new Date("2026-10-25T10:00:00.000Z");
    },
  };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const errorCode = (code: string) => (error: unknown) => error instanceof ScratchpadError && error.code === code;

test("empty read is successful without creating a file", async () => {
  const { store, directory } = await fixture();
  assert.deepEqual(await store.execute("session-a", { action: "read" }), {
    success: true,
    action: "read",
    view: "full",
    items: [],
    total: 0,
    returnedCount: 0,
    nextCursor: null,
  });
  assert.deepEqual(await readdir(directory), []);
});

test("CRUD batches preserve stable IDs, timestamps, and resume isolation", async () => {
  const { store, directory, path, advance } = await fixture();
  assert.deepEqual(await store.execute("session-a", { action: "add", texts: ["First", "Second"] }), {
    success: true,
    action: "add",
    ids: [1, 2],
    count: 2,
    message: "Added items: 1, 2.",
  });
  advance();
  await store.execute("session-a", {
    action: "update",
    items: [
      { id: 1, text: "Changed" },
      { id: 2, text: "Second" },
    ],
  });
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.items[0].createdAt, "2026-10-25T09:00:00.000Z");
  assert.equal(saved.items[0].updatedAt, "2026-10-25T10:00:00.000Z");
  assert.equal(saved.items[1].updatedAt, saved.items[1].createdAt);
  await store.execute("session-a", { action: "delete", ids: [1, 2] });
  const added = await store.execute("session-a", { action: "add", texts: ["Third"] });
  assert.equal(added.action, "add");
  if (added.action === "add") assert.deepEqual(added.ids, [3]);
  const resumed = await new ScratchpadStore({ directory }).execute("session-a", { action: "read", view: "ids" });
  assert.equal(resumed.action, "read");
  if (resumed.action === "read") assert.deepEqual(resumed.items, [{ id: 3 }]);
  const isolated = await store.execute("session-b", { action: "read" });
  if (isolated.action === "read") assert.equal(isolated.total, 0);
});

test("all batch validation happens before saving", async () => {
  const { store, path } = await fixture();
  await store.execute("session-a", { action: "add", texts: ["Original"] });
  const before = await readFile(path, "utf8");
  for (const request of [
    {
      action: "update",
      items: [
        { id: 1, text: "Changed" },
        { id: 99, text: "Missing" },
      ],
    },
    { action: "delete", ids: [1, 99] },
  ])
    await assert.rejects(store.execute("session-a", request), errorCode("ITEM_NOT_FOUND"));
  for (const request of [
    { action: "add", texts: ["Valid", " "] },
    {
      action: "update",
      items: [
        { id: 1, text: "A" },
        { id: 1, text: "B" },
      ],
    },
    { action: "delete", ids: [1, 1] },
    { action: "delete", ids: [] },
  ])
    await assert.rejects(store.execute("session-a", request), errorCode("INVALID_INPUT"));
  assert.equal(await readFile(path, "utf8"), before);
});

test("reads use full, summary, and ids views with selected IDs", async () => {
  const { store } = await fixture();
  const long = "🙂".repeat(250);
  await store.execute("session-a", { action: "add", texts: [long, "Other"] });
  const full = await store.execute("session-a", { action: "read", ids: [1] });
  if (full.action === "read") assert.equal((full.items[0] as { text: string }).text, long);
  const summary = await store.execute("session-a", { action: "read", ids: [1], view: "summary" });
  if (summary.action === "read") {
    assert.equal((summary.items[0] as { preview: string }).preview, "🙂".repeat(200));
    assert.equal("text" in summary.items[0], false);
  }
  const ids = await store.execute("session-a", { action: "read", view: "ids" });
  if (ids.action === "read") assert.deepEqual(ids.items, [{ id: 1 }, { id: 2 }]);
  await assert.rejects(store.execute("session-a", { action: "read", ids: [1, 99] }), errorCode("ITEM_NOT_FOUND"));
});

test("pagination binds cursor to exact file content, session and view", async () => {
  const { store, path } = await fixture();
  await store.execute("session-a", { action: "add", texts: ["One", "Two", "Three"] });
  const first = await store.execute("session-a", { action: "read", limit: 1, view: "ids" });
  assert.equal(first.action, "read");
  if (first.action !== "read") return;
  assert.ok(first.nextCursor);
  const next = await store.execute("session-a", { action: "read", cursor: first.nextCursor, view: "ids", limit: 2 });
  if (next.action === "read") {
    assert.deepEqual(next.items, [{ id: 2 }, { id: 3 }]);
    assert.equal(next.nextCursor, null);
  }
  await assert.rejects(
    store.execute("session-a", { action: "read", cursor: first.nextCursor, view: "full" }),
    errorCode("INVALID_INPUT"),
  );
  await assert.rejects(
    store.execute("session-b", { action: "read", cursor: first.nextCursor, view: "ids" }),
    errorCode("INVALID_INPUT"),
  );
  await writeFile(path, `${await readFile(path, "utf8")} `);
  await assert.rejects(
    store.execute("session-a", { action: "read", cursor: first.nextCursor, view: "ids" }),
    errorCode("STALE_CURSOR"),
  );
});

test("byte-bounded reads never truncate full items and selected oversized reads fail", async () => {
  const { store } = await fixture();
  const text = "\u0001".repeat(SCRATCHPAD_LIMITS.itemBytes);
  await store.execute("session-a", { action: "add", texts: [text, text] });
  const read = await store.execute("session-a", { action: "read" });
  assert.ok(Buffer.byteLength(JSON.stringify(read)) <= SCRATCHPAD_LIMITS.responseBytes);
  if (read.action === "read") {
    assert.equal(read.returnedCount, 1);
    assert.ok(read.nextCursor);
    assert.equal((read.items[0] as { text: string }).text, text);
  }
  await assert.rejects(store.execute("session-a", { action: "read", ids: [1, 2] }), errorCode("LIMIT_EXCEEDED"));
  await assert.rejects(
    store.execute("session-a", { action: "add", texts: ["🙂".repeat(2049)] }),
    errorCode("LIMIT_EXCEEDED"),
  );
});

test("invalid direct edits are preserved, valid direct edits become immediately visible", async () => {
  const { store, path } = await fixture();
  await store.execute("session-a", { action: "add", texts: ["Original"] });
  const document = JSON.parse(await readFile(path, "utf8"));
  document.items[0].text = "Edited outside Pi";
  await writeFile(path, JSON.stringify(document));
  const read = await store.execute("session-a", { action: "read" });
  if (read.action === "read") assert.equal((read.items[0] as { text: string }).text, "Edited outside Pi");
  for (const invalid of [
    "{bad",
    JSON.stringify({ ...document, sessionId: "another" }),
    JSON.stringify({ ...document, nextId: 1 }),
    JSON.stringify({ ...document, items: [...document.items, ...document.items] }),
  ]) {
    await writeFile(path, invalid);
    await assert.rejects(store.execute("session-a", { action: "add", texts: ["New"] }), errorCode("INVALID_FILE"));
    assert.equal(await readFile(path, "utf8"), invalid);
  }
});

test("oversized files are not overwritten", async () => {
  const { store, path } = await fixture();
  const raw = "x".repeat(SCRATCHPAD_LIMITS.fileBytes + 1);
  await writeFile(path, raw);
  await assert.rejects(store.execute("session-a", { action: "read" }), errorCode("LIMIT_EXCEEDED"));
  assert.equal(await readFile(path, "utf8"), raw);
});

test("queued mutations serialize across store instances", async () => {
  const { store, directory } = await fixture();
  const other = new ScratchpadStore({ directory });
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? store : other).execute("session-a", { action: "add", texts: [`Note ${index}`] }),
    ),
  );
  const read = await store.execute("session-a", { action: "read", view: "ids" });
  if (read.action === "read")
    assert.deepEqual(
      read.items,
      Array.from({ length: 20 }, (_, index) => ({ id: index + 1 })),
    );
});

test("cancelled or switched sessions cannot commit, and queued operations recover", async () => {
  const { store, directory } = await fixture();
  await assert.rejects(
    store.execute("session-a", { action: "add", texts: ["No"] }, { signal: AbortSignal.abort() }),
    errorCode("CANCELLED"),
  );
  await assert.rejects(
    store.execute("session-a", { action: "add", texts: ["No"] }, { isCurrent: () => false }),
    errorCode("SESSION_CHANGED"),
  );
  let checks = 0;
  await assert.rejects(
    store.execute("session-a", { action: "add", texts: ["No"] }, { isCurrent: () => ++checks < 4 }),
    errorCode("SESSION_CHANGED"),
  );
  assert.deepEqual(await readdir(directory), []);
  await store.execute("session-a", { action: "add", texts: ["Yes"] });
});

test("rejects path traversal and symbolic-link files or directories", async () => {
  const { store, path, directory } = await fixture();
  await assert.rejects(store.execute("../escape", { action: "read" }), errorCode("INVALID_SESSION"));
  const target = join(directory, "target.json");
  await writeFile(target, "untouched");
  await symlink(target, path);
  await assert.rejects(store.execute("session-a", { action: "add", texts: ["No"] }), errorCode("INVALID_FILE"));
  assert.equal(await readFile(target, "utf8"), "untouched");
  const linked = `${directory}-link`;
  directories.push(linked);
  await symlink(directory, linked, "dir");
  await assert.rejects(
    new ScratchpadStore({ directory: linked }).execute("session-a", { action: "read" }),
    errorCode("INVALID_FILE"),
  );
});

test("whole-file size rejection leaves the previous file intact", async () => {
  const { store, path } = await fixture();
  const text = "x".repeat(SCRATCHPAD_LIMITS.itemBytes);
  await store.execute("session-a", { action: "add", texts: Array(100).fill(text) });
  const before = await readFile(path, "utf8");
  await assert.rejects(
    store.execute("session-a", { action: "add", texts: Array(30).fill(text) }),
    errorCode("LIMIT_EXCEEDED"),
  );
  assert.equal(await readFile(path, "utf8"), before);
});

test("invalid UTF-8 is rejected without rewriting and full reads expose only defined item fields", async () => {
  const { store, path } = await fixture();
  await store.execute("session-a", { action: "add", texts: ["Note"] });
  const document = JSON.parse(await readFile(path, "utf8"));
  document.items[0].unrelated = "not part of a note";
  await writeFile(path, JSON.stringify(document));
  const read = await store.execute("session-a", { action: "read" });
  if (read.action === "read") assert.equal("unrelated" in read.items[0], false);
  const invalid = Buffer.from([0x7b, 0x22, 0xff]);
  await writeFile(path, invalid);
  await assert.rejects(store.execute("session-a", { action: "add", texts: ["No"] }), errorCode("INVALID_FILE"));
  assert.deepEqual(await readFile(path), invalid);
});

test("rejects action-inapplicable fields rather than silently ignoring them", async () => {
  const { store, directory } = await fixture();
  for (const request of [
    { action: "toString" },
    { action: "__proto__" },
    { action: "read", ids: [1], limit: 1 },
    { action: "read", texts: ["Ignored"] },
    { action: "add", texts: ["Note"], ids: [99] },
    { action: "update", items: [{ id: 1, text: "Note", extra: true }] },
    { action: "delete", ids: [1], view: "ids" },
    { action: "read", sessionId: "other" },
    { action: "read", path: "other.json" },
  ])
    await assert.rejects(store.execute("session-a", request), errorCode("INVALID_INPUT"));
  assert.deepEqual(await readdir(directory), []);
});

test("semantic summaries round-trip independently of previews, with stable IDs and timestamps", async () => {
  const { store, path, advance } = await fixture();
  const text = "Full details ".repeat(250);
  await store.execute("session-a", { action: "add", items: [{ text, summary: "A concise semantic summary." }] });
  const before = await readFile(path, "utf8");
  for (const view of ["full", "summary"] as const) {
    const result = await store.execute("session-a", { action: "read", view });
    assert.equal(result.action, "read");
    if (result.action !== "read") return;
    const item = result.items[0];
    assert.ok("summary" in item);
    assert.equal(item.summary, "A concise semantic summary.");
    assert.equal("summaryTextHash" in item, false);
    if (view === "full") assert.equal((item as { text: string }).text, text);
    else assert.equal((item as { preview: string }).preview, text.slice(0, 200));
  }
  assert.equal(await readFile(path, "utf8"), before);
  advance();
  await store.execute("session-a", { action: "update", items: [{ id: 1, summary: "Updated summary." }] });
  let [item] = await store.readSnapshot("session-a");
  assert.equal(item.text, text);
  assert.equal(item.summary, "Updated summary.");
  assert.equal(item.createdAt, "2026-10-25T09:00:00.000Z");
  assert.equal(item.updatedAt, "2026-10-25T10:00:00.000Z");
  await store.execute("session-a", { action: "update", items: [{ id: 1, summary: null }] });
  [item] = await store.readSnapshot("session-a");
  assert.equal(item.summary, undefined);
  assert.equal(JSON.parse(await readFile(path, "utf8")).items[0].summaryTextHash, undefined);
});

test("text changes invalidate summaries, same-text updates preserve them, replacements bind atomically", async () => {
  const { store, path } = await fixture();
  await store.execute("session-a", { action: "add", items: [{ text: "Original", summary: "Summary" }] });
  const before = await readFile(path, "utf8");
  await store.execute("session-a", { action: "update", items: [{ id: 1, text: "Original" }] });
  assert.equal(await readFile(path, "utf8"), before);
  await store.execute("session-a", { action: "update", items: [{ id: 1, text: "Changed" }] });
  assert.equal((await store.readSnapshot("session-a"))[0].summary, undefined);
  await store.execute("session-a", { action: "update", items: [{ id: 1, text: "New", summary: "New summary" }] });
  assert.equal((await store.readSnapshot("session-a"))[0].summary, "New summary");
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.match(saved.items[0].summaryTextHash, /^[a-f0-9]{64}$/);
});

test("older-client or direct text changes and unbound summaries cannot expose a stale summary", async () => {
  const { store, path } = await fixture();
  await store.execute("session-a", { action: "add", items: [{ text: "Original", summary: "Old summary" }] });
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.items[0].text = "Changed by an older client retaining unknown fields";
  for (const hash of [saved.items[0].summaryTextHash, undefined]) {
    saved.items[0].summaryTextHash = hash;
    const raw = JSON.stringify(saved);
    await writeFile(path, raw);
    assert.equal((await store.readSnapshot("session-a"))[0].summary, undefined);
    const read = await store.execute("session-a", { action: "read", view: "summary" });
    assert.doesNotMatch(JSON.stringify(read), /Old summary/);
    assert.equal(await readFile(path, "utf8"), raw);
  }
  await store.execute("session-a", { action: "update", items: [{ id: 1, summary: "Fresh summary" }] });
  assert.equal((await store.readSnapshot("session-a"))[0].summary, "Fresh summary");
});

test("summary validation uses UTF-8 bytes and rejects an entire invalid mutation batch", async () => {
  const { store, path } = await fixture();
  await store.execute("session-a", { action: "add", items: [{ text: "Note", summary: "🙂".repeat(256) }] });
  const before = await readFile(path, "utf8");
  for (const request of [
    { action: "add", items: [{ text: "Another", summary: "🙂".repeat(257) }] },
    { action: "update", items: [{ id: 1, summary: "x".repeat(1025) }] },
  ])
    await assert.rejects(store.execute("session-a", request), errorCode("LIMIT_EXCEEDED"));
  for (const request of [
    { action: "add", texts: ["Legacy"], items: [{ text: "New" }] },
    { action: "add", items: [{ text: "New", summary: null }] },
    { action: "add", items: [{ id: 2, text: "New" }] },
    { action: "add", items: [{ text: "New", summaryTextHash: "forged" }] },
    { action: "update", items: [{ id: 1 }] },
    {
      action: "update",
      items: [
        { id: 1, text: "Valid" },
        { id: 2, summary: " " },
      ],
    },
    { action: "update", items: [{ id: 1, summary: 5 }] },
  ])
    await assert.rejects(store.execute("session-a", request), errorCode("INVALID_INPUT"));
  assert.equal(await readFile(path, "utf8"), before);
});
