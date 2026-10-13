import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { showProgressSettings } from "../src/progress-settings-ui.js";
import { DEFAULT_PROGRESS_SETTINGS } from "../src/settings.js";
import { createContext } from "./progress-harness.js";

initTheme("dark");

async function openSettings(t: { onTestFinished(callback: () => Promise<void>): void }, rows = 24, width = 80) {
  const current = createContext();
  const tui = createTuiHarness({ rows, width });
  Object.assign(current.ctx.ui, { custom: tui.custom });
  let settings = { ...DEFAULT_PROGRESS_SETTINGS };
  const save = vi.fn(async (patch) => ({ ...settings, ...patch }));
  const controller = new AbortController();
  const running = showProgressSettings(current.ctx as ExtensionCommandContext, {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
    get: () => settings,
    save,
    apply: (next) => {
      settings = next;
    },
  });
  t.onTestFinished(async () => {
    controller.abort();
    tui.dispose();
    await running;
  });
  await tui.waitForOpen();
  const frame = () => tui.render().map(stripVTControlCharacters);
  const row = (label: string) => {
    const y = frame().findIndex((line) => line.includes(label));
    assert.ok(y >= 0, `Missing ${label}`);
    return y;
  };
  return { tui, save, frame, row, settings: () => settings };
}

for (const rows of [4, 7, 8, 12, 24]) {
  for (const width of [4, 20, 80]) {
    test(`mouse coordinates retain the native setting at ${rows} rows and width ${width}`, async (t) => {
      const screen = await openSettings(t, rows, width);
      screen.tui.press("tui.select.down");
      const y = screen.frame().findIndex((line) => line.startsWith("→"));
      assert.ok(y >= 0);
      screen.tui.mouse({ type: "click", x: 0, y });
      await vi.waitFor(() => assert.equal(screen.settings().displayMode, "expanded"));
      assert.deepEqual(screen.save.mock.calls[0]?.[0], { displayMode: "expanded" });
    });
  }
}

for (const width of [1, 2, 3]) {
  test(`compact rendering at width ${width} still routes clicks to the focused setting`, async (t) => {
    const screen = await openSettings(t, 4, width);
    screen.tui.press("tui.select.down");
    assert.equal(screen.frame().length, 1);
    screen.tui.mouse({ type: "click", x: 0, y: 0 });
    await vi.waitFor(() => assert.equal(screen.settings().displayMode, "expanded"));
    assert.deepEqual(screen.save.mock.calls[0]?.[0], { displayMode: "expanded" });
  });
}

test("header, borders, descriptions, hints, hover, and secondary buttons do not change settings", async (t) => {
  const screen = await openSettings(t);
  const lines = screen.frame();
  const setting = screen.row("Show completed");
  screen.tui.mouse({ type: "move", x: 1, y: setting });
  screen.tui.mouse({ type: "click", button: "right", x: 1, y: setting });
  for (const y of [0, 1, 2, 3, screen.row("Show progress above"), screen.row("Enter/Space"), lines.length - 1]) {
    screen.tui.mouse({ type: "click", x: 1, y });
  }
  screen.tui.mouse({ type: "wheel", x: 1, y: 0, wheelDelta: 1 });
  screen.tui.mouse({ type: "click", x: 80, y: setting });
  assert.ok(screen.frame().some((line) => line.startsWith("→ Show widget")));
  assert.equal(screen.save.mock.calls.length, 0);
});

test("wheel input navigates Settings and the item-limit submenu; clicks save the shown choice", async (t) => {
  const screen = await openSettings(t);
  screen.tui.mouse({ type: "wheel", x: 1, y: screen.row("Show widget"), wheelDelta: 1 });
  assert.ok(screen.frame().some((line) => line.startsWith("→ Display mode")));
  assert.equal(screen.save.mock.calls.length, 0);
  screen.tui.mouse({ type: "click", x: 1, y: screen.row("Visible item limit") });
  const none = screen.row("none");
  screen.tui.mouse({ type: "wheel", x: 1, y: none, wheelDelta: 1 });
  assert.ok(screen.frame().some((line) => line.startsWith("→ 1")));
  screen.tui.mouse({ type: "click", x: 1, y: screen.row("→ 1") });
  await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 1));
  assert.deepEqual(screen.save.mock.calls[0]?.[0], { maxVisibleItems: 1 });
});

test("submenu press keeps its target after native scrolling; an outside click clears a stale press", async (t) => {
  const screen = await openSettings(t);
  screen.tui.mouse({ type: "click", x: 1, y: screen.row("Visible item limit") });
  const six = screen.frame().findIndex((line) => /^ {2}6$/u.test(line));
  assert.ok(six >= 0);
  screen.tui.mouse({ type: "press", x: 1, y: six });
  screen.tui.mouse({ type: "click", x: 1, y: six });
  await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 6));
  screen.tui.mouse({ type: "click", x: 1, y: screen.row("Visible item limit") });
  const eight = screen.frame().findIndex((line) => /^ {2}8$/u.test(line));
  assert.ok(eight >= 0);
  screen.tui.mouse({ type: "press", x: 1, y: eight });
  screen.tui.mouse({ type: "click", x: 1, y: 0 });
  const five = screen.frame().findIndex((line) => /^ {2}5$/u.test(line));
  assert.ok(five >= 0);
  screen.tui.mouse({ type: "click", x: 1, y: five });
  await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 5));
});

test("submenu clicks use the latest compact frame after resize and invalidation", async (t) => {
  const screen = await openSettings(t);
  screen.tui.mouse({ type: "click", x: 1, y: screen.row("Visible item limit") });
  screen.tui.press("tui.select.up");
  screen.tui.resize({ rows: 4, width: 20 });
  screen.tui.invalidate();
  assert.equal(screen.frame()[0], "→ 50");
  screen.tui.mouse({ type: "click", x: 1, y: 0 });
  await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 50));
});
