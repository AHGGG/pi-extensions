import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { boundedSettingsUI } from "../src/ui/settings-frame.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { startupTransferSummary } from "../src/ui/sync-behavior.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

for (const asynchronous of [false, true]) {
  test(`settings frame guards zero width, compact mouse mapping and ${asynchronous ? "async" : "sync"} factories`, async () => {
    const tui = createTuiHarness({ width: 48, rows: 4 });
    const context = createMockContext({ mode: "tui", custom: tui.custom });
    const mouseRows: number[] = [];
    let matches = true;
    const component = {
      render: (_width: number) => [
        "rule",
        "title",
        "> search",
        matches ? "→ Active setting" : "No matching settings",
        "rule",
      ],
      invalidate() {},
      handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent) {
        mouseRows.push(event.y);
        return { handled: true };
      },
    };
    const running = boundedSettingsUI(context.ctx).custom((_tui, _theme, _keys, done) => {
      const screen = { ...component, handleInput: () => done(undefined) };
      // Retain the public component reference after the boundary guard is installed.
      Object.assign(component, screen);
      return asynchronous ? Promise.resolve(component) : component;
    });
    try {
      await tui.waitForOpen();
      assert.deepEqual(component.render(0), []);
      assert.deepEqual(tui.render(), ["→ Active setting"]);
      tui.mouse({ type: "click", x: 1, y: 0 });
      assert.deepEqual(mouseRows, [3]);
      matches = false;
      assert.deepEqual(tui.render(), ["> search"]);
      matches = true;
      tui.resize({ width: 48, rows: 24 });
      tui.mouse({ type: "click", x: 1, y: 3 });
      assert.deepEqual(mouseRows, [3, 3]);
      tui.press("ctrl+c");
      await running;
    } finally {
      tui.dispose();
    }
  });
}

for (const [before, expected] of [
  [
    [false, false],
    [true, false],
  ],
  [
    [true, false],
    [true, true],
  ],
  [
    [true, true],
    [false, true],
  ],
  [
    [false, true],
    [false, false],
  ],
] as const) {
  test(`content/partial choice ${before.join("/")} saves ${expected.join("/")} after explicit review`, async () =>
    withTempHome(async (root) => {
      mkdirSync(root, { recursive: true });
      const settings = { ...v3S3Settings(), version: 5 };
      Object.assign(settings.syncSetups.home.sync, { mergeContent: before[0], partialSync: before[1] });
      writeFileSync(localConfigPath(), JSON.stringify(settings));
      const choices = ["Advanced", "Content merge / partial progress", undefined, undefined];
      const context = createMockContext({ mode: "tui", select: async () => choices.shift() });
      await showSyncSettings(context.ctx, async () => undefined);
      const config = await loadConfig();
      assert.deepEqual([config.mergeContent, config.partialSync], expected);
      assert.ok(context.notifications.some((entry) => entry.message.startsWith("Saved reviewed policy")));
    }));
}

const categories = [
  ["Sync content", ["Included paths", "Compare included paths", "Machine-local fields"]],
  ["Sync behavior", ["Automatic sync", "Startup transfer", "On setup switch"]],
  ["Storage & setups", ["Storage location", "Manage sync setups", "Manage storage connections"]],
  ["Advanced", ["Merge settings fields", "Content merge / partial progress", "Skip secret scan", "Show sync status"]],
] as const;

for (const [index, [name, labels]] of categories.entries()) {
  test(`${name} contains its task rows and stays bounded through resize`, async () =>
    withTempHome(async (root) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()));
      const before = readFileSync(localConfigPath());
      const tui = createTuiHarness({ width: 100, rows: 40 });
      const context = createMockContext({ mode: "tui", custom: tui.custom });
      const running = showSyncSettings(context.ctx, async () => undefined);
      try {
        await tui.waitForOpen();
        const rootFrame = tui.render().join("\n");
        assert.match(rootFrame, /All settings \(search\)/);
        for (let move = 0; move < index; move++) tui.press("tui.select.down");
        tui.press("tui.select.confirm");
        await tui.waitForPending();
        await tui.waitForOpen();
        const initial = tui.render().join("\n");
        assert.ok(initial.includes(`Pi Sync Settings · ${name}`));
        for (const label of labels) assert.ok(initial.includes(label), initial);
        for (const [other, otherLabels] of categories) {
          if (other === name) continue;
          for (const label of otherLabels) assert.equal(initial.includes(`→ ${label}`), false);
        }
        for (const rows of [4, 8, 16, 24]) {
          for (const width of [1, 12, 48, 100]) {
            tui.resize({ width, rows });
            tui.invalidate();
            const frame = tui.render();
            assert.ok(frame.length <= Math.max(1, rows - 3), `${width}x${rows}`);
            assert.ok(
              frame.every((line) => visibleWidth(line) <= width),
              `${width}x${rows}: ${frame.join("\n")}`,
            );
            if (width >= 48)
              assert.ok(
                frame.some((line) => line.includes("→")),
                frame.join("\n"),
              );
          }
        }
        tui.press("ctrl+c");
        await running;
        assert.deepEqual(readFileSync(localConfigPath()), before);
        assert.deepEqual(context.notifications, []);
      } finally {
        tui.dispose();
      }
    }));
}

test("All settings search handles paste and Backspace, retains saved scope and mouse coordinates", async () =>
  withTempHome(async (root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()));
    const tui = createTuiHarness({ width: 48, rows: 16 });
    const context = createMockContext({ mode: "tui", custom: tui.custom });
    const routes: string[] = [];
    const running = showSyncSettings(context.ctx, async (route) => {
      routes.push(route);
    });
    try {
      await tui.waitForOpen();
      for (let move = 0; move < 4; move++) tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await tui.waitForOpen();
      tui.send("\u001b[200~Show sync statusx\u001b[201~");
      assert.match(tui.render().join("\n"), /No matching/);
      tui.send("\u007f");
      assert.match(tui.render().join("\n"), /Show sync status.*On/);
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await tui.waitForOpen();
      assert.equal((await loadConfig()).showStatus, false);
      assert.match(tui.render().join("\n"), /Show sync status.*Off/);
      assert.ok(context.notifications.some((entry) => entry.message.startsWith("Saving")));
      assert.ok(context.notifications.some((entry) => entry.message.startsWith("Saved")));
      // Clear the searched text through the native Input editing path.
      tui.send("\u0015");
      tui.send("\u001b[200~Included paths\u001b[201~");
      const frame = tui.render();
      const y = frame.findIndex((line) => line.includes("→ Included paths"));
      assert.ok(y >= 0, frame.join("\n"));
      tui.mouse({ type: "click", x: 3, y });
      await tui.waitForPending();
      await tui.waitForOpen();
      assert.deepEqual(routes, ["files"]);
      tui.press("ctrl+c");
      await running;
    } finally {
      tui.dispose();
    }
  }));

test("startup preference reports capability requirements without claiming current eligibility", async () =>
  withTempHome(async (root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()));
    const config = await loadConfig();
    assert.equal(startupTransferSummary(config), "Off");
    assert.match(
      startupTransferSummary({ ...config, automaticTransfer: true }),
      /conditional-write verification required/,
    );
  }));
