import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";

const publication = vi.hoisted(() => ({ beforeRename: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rename: async (...args: Parameters<typeof original.rename>) => {
      await publication.beforeRename?.();
      return original.rename(...args);
    },
  };
});

afterEach(() => {
  publication.beforeRename = undefined;
  vi.unstubAllEnvs();
});

for (const route of ["settings", ""] as const) {
  for (const boundary of ["back", "close", "dispose", "replacement", "shutdown"] as const) {
    test(`${route || "menu"}: ${boundary} during publication keeps disk and the current owner consistent`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "progress-publication-"));
      t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
      vi.stubEnv("PI_CODING_AGENT_DIR", directory);
      vi.resetModules();
      const { initTheme } = await import("@earendil-works/pi-coding-agent");
      initTheme("dark");
      const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
      const { createContext, createHarness, setProgress } = await import("./progress-harness.js");
      const { loadProgressSettings, saveProgressSettings } = await import("../src/settings.js");
      const path = join(directory, "pi-progress.json");
      const harness = createHarness({
        loadSettings: (_path, signal) => loadProgressSettings(path, signal),
        saveSettings: (patch, _path, signal) => saveProgressSettings(patch, path, signal),
      });
      const current = createContext();
      const tui = createTuiHarness();
      Object.assign(current.ctx.ui, { custom: tui.custom });
      await harness.emit("session_start", current.ctx);
      await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
      let ready!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      publication.beforeRename = async () => {
        ready();
        await gate;
      };
      const command = harness.commands.get("progress");
      assert.ok(command);
      const running = command.handler(route, current.ctx as ExtensionCommandContext);
      let ownerChange: Promise<void> | undefined;
      try {
        await tui.waitForOpen();
        if (route === "") {
          tui.press("tui.select.down");
          tui.press("tui.select.confirm");
          await tui.waitForOpen();
        }
        tui.press("tui.select.confirm");
        await reached;
        if (boundary === "back") tui.press("tui.select.cancel");
        else if (boundary === "close") tui.press("ctrl+c");
        else if (boundary === "dispose") tui.dispose();
        else if (boundary === "replacement") ownerChange = harness.emit("session_start", createContext().ctx);
        else ownerChange = harness.emit("session_shutdown", current.ctx);
        const count = current.widgets.length;
        release();
        await ownerChange;
        if (route === "" && boundary === "back") {
          await tui.waitForOpen();
          tui.press("ctrl+c");
        }
        await running;
        assert.equal(JSON.parse(await readFile(path, "utf8")).enabled, false);
        if (boundary === "replacement" || boundary === "shutdown") {
          assert.equal(current.widgets.length, count, "The old owner must not publish after replacement or shutdown");
        } else {
          assert.equal(current.widgets.length, count + 1, "The successful save must update the active widget");
          assert.equal(current.widgets.at(-1)?.content, undefined);
        }
        assert.deepEqual(harness.entries, []);
        assert.deepEqual(current.notifications, []);
      } finally {
        release();
        tui.dispose();
        await Promise.allSettled([running, ...(ownerChange ? [ownerChange] : [])]);
        await harness.emit("session_shutdown", current.ctx);
      }
    });
  }
}
