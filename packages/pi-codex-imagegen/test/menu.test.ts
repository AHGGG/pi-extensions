import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  getKeybindings,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { type ImagegenMenuOwner, showImagegenMenu } from "../src/menu.js";
import { showImagegenPrompt } from "../src/prompt-editor.js";

const originalKeys = getKeybindings();
beforeEach(() => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
afterEach(() => setKeybindings(originalKeys));
function fixture() {
  const controller = new AbortController();
  let current = true;
  let settings = { toolEnabled: false, outputDir: "/tmp/\x1b]0;injected\x07images", transparentBackground: false };
  const owner: ImagegenMenuOwner = {
    signal: controller.signal,
    isCurrent: () => current,
    getSettings: () => ({ ...settings }),
    settingsPath: "/tmp/\x1b[2Jsettings.json",
    getAuthStatus: vi.fn(() => "Pi OAuth metadata present (not verified)"),
    isBusy: () => false,
    saveSettings: vi.fn(async (patch) => {
      settings = { ...settings, ...patch };
    }),
    generate: vi.fn(async () => {}),
  };
  return {
    owner,
    controller,
    replace: () => {
      current = false;
      controller.abort();
    },
  };
}
const plain = (rows: readonly string[]) => rows.map(stripVTControlCharacters).join("\n");
async function opened(tui: ReturnType<typeof createTuiHarness>, count: number) {
  await vi.waitFor(() => expect(tui.openCount).toBe(count));
}

it("uses one Kit navigator for actions, status and help without resolving authentication", async () => {
  const tui = createTuiHarness();
  const { ctx } = createMockContext({
    mode: "tui",
    custom: tui.custom,
    modelRegistry: new Proxy(
      {},
      {
        get() {
          throw new Error("auth resolution forbidden");
        },
      },
    ),
  });
  const { owner } = fixture();
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  expect(plain(tui.render())).toMatch(/Generate Image[\s\S]*Settings[\s\S]*Status[\s\S]*Help/);
  expect(owner.getAuthStatus).not.toHaveBeenCalled();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  const status = plain(tui.render());
  expect(status).toMatch(/metadata present/);
  expect(status).toMatch(/not verify account entitlement/);
  expect(status).toMatch(/Tool access: disabled/);
  expect(status).toMatch(/Output directory: \/tmp\/images/);
  expect(status).not.toContain("injected");
  expect(tui.render().join("")).not.toContain("\x1b[2J");
  tui.press("tui.select.cancel");
  await opened(tui, 3);
  // Kit retains the Status selection on Back.
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await opened(tui, 4);
  expect(plain(tui.render())).toMatch(/quota refund/);
  tui.press("ctrl+c");
  await running;
  expect(owner.generate).not.toHaveBeenCalled();
  expect(owner.saveSettings).not.toHaveBeenCalled();
});

it("closes root before standalone Settings, then reopens root on Back", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  expect(plain(tui.render())).toMatch(/Image Generation Settings/);
  tui.press("tui.select.cancel");
  await opened(tui, 3);
  expect(plain(tui.render())).toMatch(/Generate Image/);
  tui.press("ctrl+c");
  await running;
});

it("preserves native editing, multiline paste expansion, focused cursor and bounded prompt frames", async () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.editor.deleteCharBackward": "ctrl+h",
    "tui.select.cancel": "ctrl+q",
  });
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  let zeroWidth: string[] = [];
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      const component = await factory(host, theme, bindings, done);
      zeroWidth = component.render(0);
      return component;
    });
  const { ctx } = createMockContext({ mode: "tui", custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.setFocused(true);
  expect(zeroWidth.every((line) => visibleWidth(line) === 0)).toBe(true);
  tui.type("ab");
  tui.send("\x08");
  tui.send("\x0a");
  const pasted = "wide 界\n".repeat(30);
  tui.send(`\x1b[200~${pasted}\x1b[201~`);
  expect(plain(tui.render())).toMatch(/paste #/);
  for (const width of [1, 8, 80])
    for (const rows of [4, 7, 24]) {
      const frame = tui.resize({ width, rows });
      expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  const frame = tui.resize({ width: 80, rows: 24 });
  expect(frame.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
  tui.invalidate();
  expect(tui.render()).toEqual(frame);
  // External-editor launch is unavailable; no unreachable native hint is shown.
  expect(plain(frame)).not.toMatch(/external editor/i);
  tui.send("\r");
  expect(await running).toEqual({ kind: "submitted", prompt: `a\n${pasted}`.trim() });
});

it("positions the native editor cursor after press, release and synthesized click without another frame", async () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+t" });
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys, width: 80 });
  const { owner } = fixture();
  let component!: Component;
  const custom = (factory: Parameters<typeof tui.custom>[0]) =>
    tui.custom(async (host, theme, bindings, done) => {
      component = await factory(host, theme, bindings, done);
      return component;
    });
  const { ctx } = createMockContext({ mode: "tui", custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.send("\x1b[200~first line\nsecond line\x1b[201~");
  const frame = tui.render();
  const y = frame.findIndex((line) => stripVTControlCharacters(line).includes("first line"));
  expect(y).toBeGreaterThanOrEqual(0);
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 3,
    y,
    screenX: 3,
    screenY: y,
    width: 80,
    height: frame.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  // Pi's selection fallback sends the click synchronously after the unhandled release.
  // Do not use tui.mouse(): the harness renders after each event and hides this regression.
  const press = component.handleMouse?.(event);
  const release = component.handleMouse?.({ ...event, type: "release" });
  const click = component.handleMouse?.({ ...event, type: "click", clickCount: 1 });
  tui.type("X");
  tui.send("\x14");
  expect(await running).toEqual({ kind: "submitted", prompt: "firXst line\nsecond line" });
  expect(press).toBeUndefined();
  expect(release).toBeUndefined();
  expect(click).toMatchObject({ handled: true, focus: true });
});

it.each(["ctrl+q", "ALT+CTRL+x"])("hard Ctrl+C cancels prompt even when selection cancel is %s", async (cancel) => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": cancel } as KeybindingsConfig);
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.type("do not submit");
  tui.press("ctrl+c");
  expect(await running).toEqual({ kind: "close" });
});

it.each([
  { name: "return alias", config: { "tui.input.submit": "return" }, raw: "\r", kind: "submitted" },
  { name: "modifier order", config: { "tui.select.cancel": "alt+ctrl+x" }, raw: "\x1b\x18", kind: "back" },
  { name: "Kitty modifiers", config: { "tui.select.cancel": "ctrl+alt+x" }, raw: "\x1b[120;7u", kind: "back" },
  { name: "legacy Ctrl+M collision", config: { "tui.select.cancel": "ctrl+m" }, raw: "\r", kind: "back" },
  {
    name: "cancel wins over native delete",
    config: { "tui.select.cancel": "ctrl+h", "tui.editor.deleteCharBackward": "ctrl+h" },
    raw: "\x08",
    kind: "back",
  },
  {
    name: "invalid config leaves submission",
    config: { "tui.select.cancel": "not+a+key" },
    raw: "\r",
    kind: "submitted",
  },
  {
    name: "first usable configured fallback",
    config: { "tui.select.cancel": ["not+a+key", "ctrl+q"] },
    raw: "\x11",
    kind: "back",
  },
])("keeps native key matching for $name", async ({ config, raw, kind }) => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, config as KeybindingsConfig);
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.type("native draft");
  tui.send(raw);
  expect(await running).toMatchObject({ kind });
});

it("suppresses external-editor launch without changing native draft or displaying its hint", async () => {
  const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.editor.external": { defaultKeys: "ctrl+g" } });
  setKeybindings(keys);
  const tui = createTuiHarness({ keybindings: keys });
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.type("native draft");
  tui.send("\x07");
  expect(plain(tui.render())).toContain("native draft");
  expect(plain(tui.render())).not.toMatch(/external editor/i);
  tui.send("\r");
  expect(await running).toEqual({ kind: "submitted", prompt: "native draft" });
});

it("sanitizes bidirectional prompt display without changing the native submitted draft", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenPrompt(ctx, owner);
  await tui.waitForOpen();
  tui.send("\x1b[200~one\u202etwo\x1b[201~");
  expect(tui.render().join("")).not.toContain("\u202e");
  tui.send("\r");
  expect(await running).toEqual({ kind: "submitted", prompt: "one\u202etwo" });
});

it.each(["abort", "dispose"])("does not generate after stale prompt %s", async (method) => {
  const tui = createTuiHarness();
  const { owner, replace } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  tui.type("a draft");
  if (method === "abort") replace();
  else tui.dispose();
  await running;
  tui.send("\r");
  expect(owner.generate).not.toHaveBeenCalled();
});

it("runs generation only after editor disposal and aborts HTTP work on task disposal", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  let taskSignal: AbortSignal | undefined;
  owner.generate = vi.fn(async (_prompt, signal) => {
    taskSignal = signal;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  tui.type("A small circle");
  tui.send("\r");
  await opened(tui, 3);
  expect(owner.generate).toHaveBeenCalledWith("A small circle", expect.any(AbortSignal));
  expect(taskSignal?.aborted).toBe(false);
  tui.dispose();
  await running;
  expect(taskSignal?.aborted).toBe(true);
});

it("keeps manual generation available when tool access is disabled and reopens after success", async () => {
  const tui = createTuiHarness();
  const { owner } = fixture();
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
  // Hold completion until the task component is mounted.
  let finish!: () => void;
  owner.generate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const running = showImagegenMenu(ctx, owner);
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await opened(tui, 2);
  tui.type("circle");
  tui.send("\r");
  await opened(tui, 3);
  finish();
  await opened(tui, 4);
  expect(plain(tui.render())).toMatch(/Generate Image/);
  tui.press("ctrl+c");
  await running;
  expect(owner.generate).toHaveBeenCalledTimes(1);
});
