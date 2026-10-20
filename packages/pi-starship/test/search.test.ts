import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { plainTuiText } from "../../../test/tui-text.js";
import { effectiveConfigurationScreen, settingsDocumentScreen } from "../src/command-configuration.js";
import { loadStarshipConfig } from "../src/config.js";
import { serializeEffectiveConfig } from "../src/effective-config.js";

initTheme("dark", false);

for (const kind of ["effective", "raw"] as const) {
  test(`${kind} TOML search preserves bytes, wrapped literals, native editing, and Back versus Close`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "starship-search-"));
    const path = join(root, "pi-starship.toml");
    const raw = "# retained comment\r\nformat = 'abcdefghijklmnopqrstuvWXYZabcdefgh'\r\nfuture = true\r\n";
    writeFileSync(path, raw);
    try {
      const loaded = loadStarshipConfig(path);
      const before = structuredClone(loaded);
      const review = kind === "effective" ? effectiveConfigurationScreen(loaded) : settingsDocumentScreen(loaded, path);
      assert.equal(review.kind, "review");
      if (review.kind !== "review") return;
      assert.equal(review.enableSearch, true);
      assert.equal(review.content, kind === "effective" ? serializeEffectiveConfig(loaded.config) : raw);
      assert.equal("confirm" in review, false);
      const menu = defineMenu<undefined, "main" | "review", never>({
        start: "main",
        screens: {
          main: () => ({
            kind: "actions",
            title: "Configuration",
            items: [{ id: kind, label: review.title, to: "review" }],
          }),
          review: () => review,
        },
        actions: {},
      });
      const tui = createTuiHarness({ width: 24, rows: 18, keybindings: getKeybindings() as never });
      t.onTestFinished(() => tui.dispose());
      const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
      const running = runMenu(ctx.ctx, menu, { getState: () => undefined });
      await tui.waitForOpen();
      tui.press("tui.select.confirm");
      await tui.waitForOpen();
      tui.render();
      tui.send(" ");
      tui.type("mnox");
      tui.send("\u007f");
      tui.type("p");
      assert.match(plainTuiText(tui.render().join("\n")), /1\/1/u);
      assert.match(plainTuiText(tui.render().join("\n")), /Find: > mnop/u);
      tui.resize({ width: 17, rows: 14 });
      assert.match(plainTuiText(tui.render().join("\n")), /1\/1/u);
      tui.send("\u0015");
      tui.send("\u001b[200~a.b\u001b[201~");
      assert.match(plainTuiText(tui.render().join("\n")), /0\/0/u);
      tui.press("tui.select.cancel");
      assert.equal(tui.isOpen, true);
      assert.doesNotMatch(plainTuiText(tui.render().join("\n")), /Find:/u);
      tui.press("tui.select.cancel");
      await tui.waitForOpen();
      tui.resize({ width: 64, rows: 18 });
      assert.match(plainTuiText(tui.render().join("\n")), new RegExp(`→ ${review.title}`, "u"));
      tui.press("tui.select.confirm");
      await tui.waitForOpen();
      tui.render();
      tui.send(" ");
      tui.press("ctrl+c");
      assert.deepEqual(await running, { kind: "closed", reason: "close" });
      assert.equal(readFileSync(path, "utf8"), raw);
      assert.deepEqual(loaded, before);

      // Search adds no RPC controls or pagination changes.
      const dialogs = [];
      for (const enableSearch of [false, true]) {
        const rpc = createRpcHarness([{ kind: "select", response: "Back" }]);
        const base = createMockContext({ mode: "rpc", hasUI: true }).ctx as ExtensionCommandContext;
        await runMenu(
          { ...base, ui: { ...base.ui, ...rpc.ui } },
          {
            start: "review",
            screens: { review: () => ({ ...review, enableSearch }) },
            actions: {},
          },
          { getState: () => undefined },
        );
        rpc.assertConsumed();
        dialogs.push(rpc.dialogs);
      }
      assert.deepEqual(dialogs[1], dialogs[0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
