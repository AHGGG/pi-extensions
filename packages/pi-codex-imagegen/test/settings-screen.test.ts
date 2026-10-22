import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { ImagegenMenuOwner } from "../src/menu.js";
import { showImagegenSettings } from "../src/settings-screen.js";

const originalKeys = getKeybindings();
beforeEach(() => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
afterEach(() => setKeybindings(originalKeys));
const plain = (rows: readonly string[]) => rows.map(stripVTControlCharacters).join("\n");
function fixture() {
  const controller = new AbortController();
  let settings = { toolEnabled: false, outputDir: "/tmp/\x1b]0;unsafe\x07images", transparentBackground: false };
  const owner: ImagegenMenuOwner = {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
    getSettings: () => ({ ...settings }),
    settingsPath: "/tmp/\x1b[2Jsettings.json",
    getAuthStatus: () => "missing",
    isBusy: () => false,
    saveSettings: vi.fn(async (patch) => {
      settings = { ...settings, ...patch };
    }),
    generate: vi.fn(async () => {}),
  };
  return {
    owner,
    controller,
    apply: (patch: Parameters<ImagegenMenuOwner["saveSettings"]>[0]) => {
      settings = { ...settings, ...patch };
    },
  };
}

it("frames exactly three native settings, sanitizes paths and retains focused rows after resize/invalidation", async () => {
  const roles: string[] = [];
  const tui = createTuiHarness({
    theme: {
      fg: (role, text) => {
        roles.push(role);
        return text;
      },
      bold: (text) => text,
    },
  });
  const { owner } = fixture();
  let zeroWidth: string[] = [];
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      const component = await factory(host, theme, bindings, done);
      zeroWidth = component.render(0);
      return component;
    });
  const { ctx } = createMockContext({ mode: "tui", custom });
  const running = showImagegenSettings(ctx, owner);
  await tui.waitForOpen();
  expect(zeroWidth.every((line) => visibleWidth(line) === 0)).toBe(true);
  const initial = tui.render();
  expect(initial[0]).toBe("─".repeat(100));
  expect(initial.at(-1)).toBe(initial[0]);
  expect(plain(initial)).toMatch(/User scope: \/tmp\/settings.json/);
  expect(plain(initial)).toMatch(/Tool access[\s\S]*Transparent background[\s\S]*Output directory/);
  expect(initial.join("")).not.toContain("\x1b[2J");
  expect(plain(initial)).not.toMatch(/unsafe|Model {2}|Quality {2}|Size {2}|Count {2}|Format {2}/);
  tui.send("\x1b[B");
  for (const width of [1, 3, 40, 100])
    for (const rows of [4, 7, 12, 24]) {
      const frame = tui.resize({ width, rows });
      expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 40) expect(plain(frame)).toContain("→ Transparent background");
      if (rows - 3 >= 5 && width > 0) {
        expect(frame[0]).toBe("─".repeat(width));
        expect(frame.at(-1)).toBe(frame[0]);
      }
      tui.invalidate();
      expect(tui.render()).toEqual(frame);
    }
  expect(roles).toContain("border");
  expect(roles).toContain("muted");
  expect(tui.requestRenderCount).toBeGreaterThan(0);
  tui.press("ctrl+c");
  expect(await running).toBe("close");
});

it("serializes immediate saves, rolls back failures without resetting cursor, and recovers the queue", async () => {
  const tui = createTuiHarness();
  const { owner, apply } = fixture();
  const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
  let rejectFirst!: () => void;
  const calls: unknown[] = [];
  owner.saveSettings = vi.fn(async (patch) => {
    calls.push(patch);
    if (calls.length === 1)
      await new Promise<void>((_resolve, reject) => {
        rejectFirst = () => reject(new Error("secret failure"));
      });
    else apply(patch);
  });
  const running = showImagegenSettings(ctx, owner);
  await tui.waitForOpen();
  tui.send("\r");
  tui.send("\x1b[B");
  tui.send("\r");
  await vi.waitFor(() => expect(calls.length).toBe(1));
  expect(owner.getSettings().transparentBackground).toBe(false);
  rejectFirst();
  await tui.waitForPending();
  expect(calls).toEqual([{ toolEnabled: true }, { transparentBackground: true }]);
  expect(owner.getSettings()).toMatchObject({ toolEnabled: false, transparentBackground: true });
  const frame = plain(tui.render());
  expect(frame).toMatch(/Tool access\s+false/);
  expect(frame).toMatch(/→ Transparent background\s+true/);
  expect(notifications).toEqual([
    { message: "Settings were not saved. The previous value was restored.", level: "error" },
  ]);
  tui.send("\r");
  await tui.waitForPending();
  expect(owner.getSettings().transparentBackground).toBe(false);
  tui.send("\x1b");
  expect(await running).toBe("back");
});

it("drains accepted saves after Back and rolls back repeated same-field toggles correctly", async () => {
  const tui = createTuiHarness();
  const { owner, apply } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  let release!: () => void;
  let first = true;
  const patches: unknown[] = [];
  owner.saveSettings = async (patch) => {
    patches.push(patch);
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("write failed");
    }
    apply(patch);
  };
  const running = showImagegenSettings(ctx, owner);
  await tui.waitForOpen();
  tui.send("\r");
  tui.send("\r");
  await vi.waitFor(() => expect(patches.length).toBe(1));
  release();
  await tui.waitForPending();
  expect(patches).toEqual([{ toolEnabled: true }, { toolEnabled: false }]);
  expect(plain(tui.render())).toMatch(/→ Tool access\s+false/);
  let finish!: () => void;
  owner.saveSettings = (patch) =>
    new Promise<void>((resolve) => {
      finish = () => {
        apply(patch);
        resolve();
      };
    });
  tui.send("\r");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  tui.send("\x1b");
  let settled = false;
  void running.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  expect(await running).toBe("back");
  expect(owner.getSettings().toolEnabled).toBe(true);
});

it.each([
  { label: "Tool access", patch: { toolEnabled: true }, rows: 24 },
  { label: "Transparent background", patch: { transparentBackground: true }, rows: 24 },
  { label: "Output directory", patch: { outputDir: "~/mouse images" }, rows: 8 },
])("activates $label with native press/release/click before the next frame", async ({ label, patch, rows }) => {
  const tui = createTuiHarness({ width: 80, rows });
  const { owner } = fixture();
  let component!: Component;
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      component = await factory(host, theme, bindings, done);
      return component;
    });
  const { ctx } = createMockContext({ mode: "tui", custom });
  const running = showImagegenSettings(ctx, owner);
  await tui.waitForOpen();
  if (label === "Output directory") {
    tui.press("tui.select.down");
    tui.press("tui.select.down");
  }
  const frame = tui.render();
  const y = frame.findIndex((line) => stripVTControlCharacters(line).includes(label));
  expect(y).toBeGreaterThanOrEqual(0);
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 1,
    y,
    screenX: 1,
    screenY: y,
    width: 80,
    height: frame.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  // Match Pi's captured-target dispatch: release and synthesized click share one frame.
  // The harness mouse helper renders between events and would conceal geometry loss.
  const press = component.handleMouse?.(event);
  const release = component.handleMouse?.({ ...event, type: "release" });
  const click = component.handleMouse?.({ ...event, type: "click", clickCount: 1 });
  expect(press).toMatchObject({ handled: true, focus: true });
  expect(release).toBeUndefined();
  expect(click).toMatchObject({ handled: true });
  if (label === "Output directory") {
    tui.setFocused(true);
    const submenu = tui.resize({ rows: 24 });
    expect(plain(submenu)).toContain("Enter a new output directory");
    expect(submenu.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    tui.type("~/mouse images");
    tui.send("\r");
  }
  await tui.waitForPending();
  expect(owner.saveSettings).toHaveBeenCalledExactlyOnceWith(patch);
  expect(plain(tui.render())).toContain(`→ ${label}`);
  expect(owner.getSettings()).toMatchObject(patch);
  tui.press("ctrl+c");
  expect(await running).toBe("close");
});

it.each([
  { name: "Back", key: "\x11", result: "back" },
  { name: "Ctrl+C", key: "\x03", result: "close" },
])("reports an accepted save failure after $name closes the dialog", async ({ key, result }) => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+q" });
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
  let rejectSave!: (error: Error) => void;
  owner.saveSettings = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const running = showImagegenSettings(ctx, owner);
  await tui.waitForOpen();
  tui.send("\r");
  await vi.waitFor(() => expect(owner.saveSettings).toHaveBeenCalledTimes(1));
  tui.send(key);
  expect(tui.isOpen).toBe(false);
  expect(notifications).toEqual([]);
  const renders = tui.requestRenderCount;
  rejectSave(new Error("private path /secret/\x1b[2J\u202einjected"));
  expect(await running).toBe(result);
  expect(notifications).toEqual([
    { message: "Settings were not saved. The previous value was restored.", level: "error" },
  ]);
  expect(owner.getSettings().toolEnabled).toBe(false);
  expect(owner.saveSettings).toHaveBeenCalledTimes(1);
  expect(tui.requestRenderCount).toBe(renders);
});

it.each([
  { name: "C0 control", invalid: "\x00" },
  { name: "C1 control", invalid: "\u0085" },
  { name: "bidi override", invalid: "\u202e" },
  { name: "direction mark", invalid: "\u200e" },
  { name: "high surrogate", invalid: "\ud800" },
  { name: "low surrogate", invalid: "\udfff" },
])("rejects pasted $name without saving or changing the focused draft, then recovers", async ({ invalid }) => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const previous = owner.getSettings();
  const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenSettings(ctx, owner);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  // Native bracketed paste retains these code points; normal key input rejects C0/C1.
  tui.send(`\x1b[200~/tmp/images${invalid}\x1b[201~`);
  const draft = tui.render().find((line) => line.includes(CURSOR_MARKER));
  expect(draft).toBeDefined();
  tui.send("\r");
  await tui.waitForPending();
  const rejected = tui.render();
  expect(plain(rejected)).toContain("Enter a nonempty path without control characters.");
  expect(rejected.find((line) => line.includes(CURSOR_MARKER))).toBe(draft);
  expect(tui.focused).toBe(true);
  expect(owner.saveSettings).not.toHaveBeenCalled();
  expect(owner.getSettings()).toEqual(previous);
  // Delete only the final invalid code point: the accepted save proves the draft survived intact.
  tui.send("\x7f");
  tui.send("\r");
  await tui.waitForPending();
  expect(owner.saveSettings).toHaveBeenCalledExactlyOnceWith({ outputDir: "/tmp/images" });
  expect(owner.getSettings().outputDir).toBe("/tmp/images");
  expect(plain(tui.render())).toMatch(/→ Output directory\s+\/tmp\/images/);
  expect(plain(tui.render())).not.toContain("Enter a nonempty path");
  expect(notifications).toEqual([]);
  tui.press("ctrl+c");
  expect(await running).toBe("close");
});

it("maps clipped frame mouse rows to native rows, ignores borders, and edits free-form paths in a native submenu", async () => {
  const tui = createTuiHarness({ rows: 8, width: 80 });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenSettings(ctx, owner);
  await tui.waitForOpen();
  tui.render();
  tui.mouse({ type: "click", x: 0, y: 0 });
  expect(owner.saveSettings).not.toHaveBeenCalled();
  // Clip to a single focused row; its frame index is not its native list index.
  tui.send("\x1b[B");
  tui.send("\x1b[B");
  let frame = tui.render();
  const selected = frame.findIndex((line) => stripVTControlCharacters(line).startsWith("→ Output directory"));
  expect(selected).toBeGreaterThanOrEqual(0);
  tui.mouse({ type: "press", x: 1, y: selected });
  tui.mouse({ type: "click", x: 1, y: selected });
  tui.setFocused(true);
  frame = tui.resize({ rows: 24 });
  expect(frame.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
  for (const rows of [4, 7, 24]) {
    const bounded = tui.resize({ rows, width: 12 });
    expect(bounded.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
    expect(bounded.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(bounded.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    tui.invalidate();
    expect(tui.render()).toEqual(bounded);
  }
  tui.resize({ rows: 24, width: 80 });
  tui.send("\x1b[200~~/new images\x1b[201~");
  tui.send("\r");
  await tui.waitForPending();
  expect(owner.saveSettings).toHaveBeenCalledWith({ outputDir: "~/new images" });
  expect(plain(tui.render())).toMatch(/→ Output directory\s+~\/new images/);
  tui.send("\r");
  tui.type("discard this");
  tui.send("\x1b");
  expect(owner.saveSettings).toHaveBeenCalledTimes(1);
  expect(plain(tui.render())).toMatch(/→ Output directory/);
  tui.press("ctrl+c");
  expect(await running).toBe("close");
});

it("honors remapped native keys and keeps Ctrl+C as hard cancel inside the path input", async () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+t",
    "tui.select.cancel": "ctrl+q",
  });
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenSettings(ctx, owner);
  await tui.waitForOpen();
  tui.send("\x0e");
  tui.send("\x0e");
  tui.send("\x14");
  tui.type("do not save");
  tui.press("ctrl+c");
  expect(await running).toBe("close");
  expect(owner.saveSettings).not.toHaveBeenCalled();
});

it.each(["abort", "dispose"])("skips queued stale saves and does not notify or redraw after %s", async (method) => {
  const tui = createTuiHarness();
  const { owner, controller } = fixture();
  const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
  let fail!: () => void;
  owner.saveSettings = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = () => reject(new Error("private error"));
      }),
  );
  const running = showImagegenSettings(ctx, owner);
  await tui.waitForOpen();
  tui.send("\r");
  tui.send("\x1b[B");
  tui.send("\r");
  await vi.waitFor(() => expect(owner.saveSettings).toHaveBeenCalledTimes(1));
  if (method === "abort") controller.abort();
  else tui.dispose();
  const renders = tui.requestRenderCount;
  fail();
  expect(await running).toBe("stale");
  expect(owner.saveSettings).toHaveBeenCalledTimes(1);
  expect(notifications).toEqual([]);
  expect(tui.requestRenderCount).toBe(renders);
});
