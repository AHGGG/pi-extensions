import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import { showNotifyMenu } from "../src/menu.js";
import { SettingsStore, saveDestination, savePolicy } from "../src/settings.js";
import { providers } from "../src/telegram.js";

let directory: string;
let store: SettingsStore;
let owner: AbortController;
let coordinator: Coordinator;
const token = `123:${"s".repeat(30)}`;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-notify-menu-"));
  store = new SettingsStore(join(directory, "pi-notify.json"), join(directory, "project", "pi-notify.json"), providers);
  initTheme("dark", false);
  owner = new AbortController();
  await store.load();
  coordinator = new Coordinator(store.snapshot.effective, providers, true);
});
afterEach(async () => {
  owner.abort();
  await coordinator.close();
  await store.flush();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
function harness(remap = false) {
  const theme = { fg: vi.fn((_role: string, value: string) => value), bold: (value: string) => value };
  const keybindings = remap
    ? new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.select.down": "ctrl+n",
        "tui.select.up": "ctrl+p",
        "tui.select.cancel": "ctrl+q",
      })
    : undefined;
  const tui = createTuiHarness({ width: 72, rows: 24, theme, keybindings });
  const notify = vi.fn();
  const zeroFrames: string[][] = [];
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    tui.custom(async (...args) => {
      const component = await factory(...args);
      zeroFrames.push(component.render(0));
      return component;
    }, options);
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: directory,
    sessionManager: { getSessionId: () => "session", getSessionName: () => "Test" },
    ui: { custom, notify },
  } as unknown as ExtensionCommandContext;
  const run = () =>
    showNotifyMenu(ctx, {
      store,
      coordinator,
      providers,
      signal: owner.signal,
      isCurrent: () => !owner.signal.aborted,
    });
  const transition = async (perform: () => unknown) => {
    const count = tui.openCount;
    perform();
    await vi.waitFor(
      () => {
        expect(tui.openCount).toBeGreaterThan(count);
        expect(tui.isOpen).toBe(true);
      },
      { interval: 1 },
    );
  };
  const down = () => (remap ? tui.send("\x0e") : tui.press("tui.select.down"));
  const choose = async (index: number) => {
    tui.press("home");
    for (let n = 0; n < index; n++) down();
    await transition(() => tui.press("tui.select.confirm"));
  };
  return { tui, ctx, notify, run, choose, transition, theme, zeroFrames, down };
}
it("frames main/settings/detail screens, bounds sizes, and uses callback theme", async () => {
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  h.tui.render();
  expect(h.theme.fg.mock.calls.some(([role]) => role === "border")).toBe(true);
  expect(h.tui.render()[0]).toMatch(/^─+$/);
  expect(h.tui.render().at(-1)).toMatch(/^─+$/);
  await h.choose(2);
  expect(h.tui.render().join("\n")).toContain("Notify Settings");
  expect(h.zeroFrames.every((frame) => frame.every((line) => visibleWidth(line) === 0))).toBe(true);
  for (const width of [1, 8, 40])
    for (const rows of [4, 7, 24]) {
      const frame = h.tui.resize({ width, rows });
      expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  h.tui.resize({ width: 72, rows: 24 });
  h.tui.invalidate();
  await h.transition(() => h.tui.press("tui.select.cancel"));
  await h.choose(3);
  expect(h.tui.render().join("\n")).toContain("Notify Status");
  h.tui.press("ctrl+c");
  await running;
});
it("saves settings immediately without losing cursor; restores values after failure", async () => {
  await savePolicy(store, "user", "enabled", false, owner.signal);
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(2);
  h.down();
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.effective.enabled).toBe(true);
  expect(h.tui.render().join("\n")).toMatch(/Automatic notifications.*On/);
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error(token));
  h.tui.press("tui.select.confirm");
  await h.tui.waitForPending();
  expect(store.snapshot.effective.enabled).toBe(true);
  expect(h.tui.render().join("\n")).toMatch(/Automatic notifications.*On/);
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain(token);
  h.tui.press("ctrl+c");
  await running;
});
it("changes mode and custom inactivity time through the same settings flow", async () => {
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(2);
  h.tui.press("tui.select.down");
  h.tui.press("tui.select.down");
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.effective.mode).toBe("after-inactivity");
  h.tui.press("tui.select.down");
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await h.choose(3);
  h.tui.send("\x15");
  h.tui.type("0");
  h.tui.press("tui.input.submit");
  await h.tui.waitForPending();
  expect(store.snapshot.effective.inactivitySeconds).toBe(30);
  h.tui.send("\x15");
  h.tui.send("\x1b[200~90\x1b[201~");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(store.snapshot.effective.inactivitySeconds).toBe(90);
  h.tui.press("ctrl+c");
  await running;
});
it("keeps setup transactional, masked, and cancellable with remapped keys", async () => {
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  h.tui.send(`\x1b[200~${token}\x1b[201~`);
  expect(h.tui.render().join("\n")).not.toContain(token);
  expect(h.tui.isFocusable).toBe(true);
  h.tui.setFocused(true);
  expect(h.tui.focused).toBe(true);
  h.tui.press("ctrl+c");
  await running;
  expect(await fs.readdir(directory)).toEqual([]);
});
it.each(["use", "save only"])(
  "configures Telegram with paste/editing and confirms selection: %s",
  async (selection) => {
    const h = harness();
    const running = h.run();
    await h.tui.waitForOpen();
    await h.choose(0);
    await h.choose(0);
    h.tui.send(`\x1b[200~${token}\x1b[201~`);
    await h.transition(() => h.tui.press("tui.input.submit"));
    expect(h.tui.render().join("\n")).toContain("Telegram chat ID");
    h.tui.send("\x1b[200~-10012X\x1b[201~");
    h.tui.send("\x7f");
    h.tui.type("3");
    await h.transition(() => h.tui.press("tui.input.submit"));
    expect(h.tui.render().join("\n")).toContain("Review Telegram destination");
    expect(h.tui.render().join("\n")).toContain("Telegram -100123");
    expect(h.tui.render().join("\n")).not.toContain(token);
    expect(await fs.readdir(directory)).toEqual([]);
    expect(h.tui.render().join("\n")).toContain("Use this chat for notifications?");
    await h.choose(selection === "use" ? 0 : 5);
    expect(Object.values(store.snapshot.effective.destinations)[0]).toMatchObject({
      provider: "telegram",
      label: "Telegram -100123",
      chatId: "-100123",
    });
    expect(Object.values(store.snapshot.effective.destinations)[0].messageThreadId).toBeUndefined();
    expect(store.snapshot.effective.targetIds).toEqual(
      selection === "use" ? Object.keys(store.snapshot.effective.destinations) : [],
    );
    expect(store.snapshot.effective.enabled).toBe(true);
    h.tui.press("ctrl+c");
    await running;
  },
);
it("edits optional fields from review without changing saved settings before confirmation", async () => {
  const original = {
    provider: "telegram" as const,
    label: "Personal",
    botToken: token,
    chatId: "123",
    messageThreadId: 42,
  };
  await saveDestination(store, "one", original, owner.signal);
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  await h.choose(0);
  expect(h.tui.render().join("\n")).toContain("Review Telegram destination");
  expect(h.tui.render().join("\n")).toContain("Topic: 42");
  await h.choose(2);
  h.tui.send("\x15");
  h.tui.type("456");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Personal");
  await h.choose(3);
  h.tui.send("\x15");
  h.tui.send("\x1b[200~WorkX\x1b[201~");
  h.tui.send("\x7f");
  await h.transition(() => h.tui.press("tui.input.submit"));
  await h.choose(4);
  h.tui.send("\x15");
  h.tui.type("0");
  h.tui.press("tui.input.submit");
  await h.tui.waitForPending();
  expect(store.snapshot.effective.destinations.one).toEqual(original);
  h.tui.send("\x15");
  h.tui.type("99");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Topic: 99");
  expect(h.tui.render().join("\n")).not.toContain(token);
  expect(store.snapshot.effective.destinations.one).toEqual(original);
  await h.choose(0);
  expect(store.snapshot.effective.destinations.one).toEqual({
    ...original,
    label: "Work",
    chatId: "456",
    messageThreadId: 99,
  });
  h.tui.press("ctrl+c");
  await running;
});
it.each(["cancel", "save"])("clears an optional topic only on save: %s", async (completion) => {
  const original = {
    provider: "telegram" as const,
    label: "Personal",
    botToken: token,
    chatId: "123",
    messageThreadId: 42,
  };
  await saveDestination(store, "one", original, owner.signal);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  await h.choose(0);
  await h.choose(4);
  h.tui.send("\x15");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Topic: none");
  expect(store.snapshot.effective.destinations.one).toEqual(original);
  if (completion === "save") await h.choose(0);
  h.tui.press("ctrl+c");
  await running;
  expect(store.snapshot.effective.destinations.one.messageThreadId).toBe(completion === "save" ? undefined : 42);
});
it("selects destinations immediately and restores project inheritance", async () => {
  await saveDestination(
    store,
    "one",
    { provider: "telegram", label: "Personal", botToken: token, chatId: "123" },
    owner.signal,
  );
  await savePolicy(store, "user", "targetIds", ["one"], owner.signal);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(2);
  await h.transition(() => h.tui.press("tui.select.confirm")); // User -> Project
  for (let n = 0; n < 4; n++) h.tui.press("tui.select.down");
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.project.targetIds).toEqual([]);
  await h.choose(1);
  expect(store.snapshot.project).not.toHaveProperty("targetIds");
  expect(store.snapshot.effective.targetIds).toEqual(["one"]);
  h.tui.press("ctrl+c");
  await running;
});
it("requires confirmation before a test and sends no transcript", async () => {
  await saveDestination(
    store,
    "one",
    { provider: "telegram", label: "Personal", botToken: token, chatId: "123" },
    owner.signal,
  );
  const sending = vi.spyOn(coordinator, "send").mockResolvedValue({ state: "accepted" });
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(1);
  await h.choose(0);
  expect(sending).not.toHaveBeenCalled();
  expect(h.tui.render().join("\n")).toContain("Pi notification test");
  expect(h.tui.render().join("\n")).not.toContain(token);
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await vi.waitFor(() => expect(sending).toHaveBeenCalledTimes(1), { interval: 1 });
  await vi.waitFor(() => expect(h.tui.render().join("\n")).toContain("Telegram destinations"), { interval: 1 });
  h.tui.press("ctrl+c");
  await running;
});
it("edits User selection independently from an active Project override", async () => {
  await saveDestination(
    store,
    "one",
    { provider: "telegram", label: "Personal", botToken: token, chatId: "123" },
    owner.signal,
  );
  await savePolicy(store, "user", "targetIds", ["one"], owner.signal);
  await savePolicy(store, "project", "targetIds", [], owner.signal);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(2);
  for (let n = 0; n < 4; n++) h.down();
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(h.tui.render().join("\n")).toMatch(/\[x\].*Personal/);
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.user.targetIds).toEqual([]);
  expect(store.snapshot.project.targetIds).toEqual([]);
  h.tui.press("ctrl+c");
  await running;
});
it("hard-cancels an active test request and drains the loader", async () => {
  await saveDestination(
    store,
    "one",
    { provider: "telegram", label: "Personal", botToken: token, chatId: "123" },
    owner.signal,
  );
  let requestSignal: AbortSignal | undefined;
  vi.spyOn(coordinator, "send").mockImplementation(
    async (_id, _destination, _notification, signal) =>
      new Promise((resolve) => {
        requestSignal = signal;
        signal?.addEventListener("abort", () => resolve({ state: "cancelled", code: "cancelled" }), { once: true });
      }),
  );
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(1);
  await h.choose(0);
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await vi.waitFor(() => expect(requestSignal).toBeDefined(), { interval: 1 });
  h.tui.press("ctrl+c");
  await running;
  expect(requestSignal?.aborted).toBe(true);
  expect(h.tui.isOpen).toBe(false);
});
it.each(["abort", "dispose"])("releases the menu on %s", async (cause) => {
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  if (cause === "abort") owner.abort();
  else h.tui.dispose();
  await running;
  expect(h.tui.isOpen).toBe(false);
  expect(await fs.readdir(directory)).toEqual([]);
});
