import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { ScratchpadStore } from "../src/scratchpad-store.js";
import { showScratchpad } from "../src/scratchpad-viewer.js";

const library = vi.hoisted(() => ({ review: undefined as unknown }));
vi.mock("@narumitw/pi-tui-kit", () => ({
  get runDocumentReview() {
    return library.review;
  },
}));

for (const missing of [true, false]) {
  test(`viewer ${missing ? "missing API" : "thrown error"} preserves readable notes and reports only safe UI detail`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "scratchpad-compat-"));
    try {
      const store = new ScratchpadStore({ directory });
      await store.execute("test-session", { action: "add", texts: ["Private note"] });
      const file = join(directory, "test-session.json");
      const before = await readFile(file, "utf8");
      library.review = missing
        ? undefined
        : () => {
            throw new Error("Private note from renderer");
          };
      const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true });
      await showScratchpad(ctx, store, "test-session", {
        signal: new AbortController().signal,
        isCurrent: () => true,
      });
      assert.equal(notifications.length, 1);
      assert.match(
        notifications[0]?.message ?? "",
        missing ? /UI library is incompatible/ : /viewer could not be loaded or rendered/,
      );
      assert.doesNotMatch(notifications[0]?.message ?? "", /Unable to read|Private note/);
      assert.equal(await readFile(file, "utf8"), before);
      assert.equal((await store.execute("test-session", { action: "read" })).success, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
