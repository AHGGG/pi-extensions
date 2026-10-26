import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createScratchpadRuntime } from "../src/scratchpad.js";
import { ScratchpadStore } from "../src/scratchpad-store.js";
import { createCodexCompactSettingsRuntime } from "../src/settings.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function setup(options: Parameters<typeof createTuiHarness>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "scratchpad-viewer-"));
  directories.push(directory);
  const tui = createTuiHarness(options);
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const mock = createMockPi();
  const store = new ScratchpadStore({ directory: join(directory, "notes") });
  const settings = createCodexCompactSettingsRuntime(join(directory, "settings.json"));
  await settings.reload();
  const runtime = createScratchpadRuntime(mock.pi, settings, { store });
  runtime.beginSession(context.ctx);
  runtime.sync(context.ctx);
  const registeredCommand = mock.commands.get("scratchpad");
  assert.ok(registeredCommand);
  const command = (args = "show") => registeredCommand.handler(args, context.ctx);
  const text = () => stripVTControlCharacters(tui.render().join("\n"));
  return { directory, tui, context, mock, store, settings, runtime, command, text };
}

test("show displays all items, IDs and timestamps while Off or On without writes or model messages", async () => {
  for (const enabled of [false, true]) {
    const current = await setup({ rows: 20, width: 100 });
    if (enabled) await current.command("on");
    await current.store.execute("test-session", {
      action: "add",
      texts: Array.from({ length: 100 }, (_, index) => `Note ${index + 1}\nFull text, not a preview.`),
    });
    await current.store.execute("test-session", { action: "add", texts: ["Note 101\nLast item."] });
    const file = join(current.store.directory, "test-session.json");
    const before = await readFile(file, "utf8");
    const toolCount = current.mock.tools.length;
    const running = current.command();
    await current.tui.waitForOpen();
    const first = current.text();
    current.tui.send("\u001b[F");
    const last = current.text();
    current.tui.press("tui.select.cancel");
    await running;
    assert.match(first, /#1\nCreated: .*\nUpdated:/);
    assert.match(first, /Full text, not a preview/);
    assert.match(last, /#101/);
    assert.equal(await readFile(file, "utf8"), before);
    assert.deepEqual(await readdir(current.store.directory), ["test-session.json"]);
    assert.equal(current.settings.get().settings.scratchpadEnabled, enabled);
    assert.equal(current.mock.tools.length, toolCount);
    assert.deepEqual(current.mock.sentMessages, []);
    assert.deepEqual(current.mock.sentUserMessages, []);
    assert.deepEqual(current.mock.entries, []);
  }
});

test("viewer scrolls, reflows and sanitizes terminal content without interpreting Markdown", async () => {
  const current = await setup({ rows: 22, width: 50 });
  await current.store.execute("test-session", {
    action: "add",
    texts: [
      `**literal**\n\u001b[31mred\u001b[0m\u001b]52;c;SECRET\u0007\u001b]8;;https://example.invalid\u001b\\link\u001b]8;;\u001b\\\r\u0007\u009b31m\n${"wide 界 é 👩‍💻 ".repeat(30)}\n${Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n")}`,
    ],
  });
  const running = current.command();
  await current.tui.waitForOpen();
  const raw = current.tui.render().join("\n");
  const first = current.text();
  current.tui.press("tui.select.down");
  const down = current.text();
  current.tui.press("tui.select.up");
  const up = current.text();
  current.tui.press("tui.select.pageDown");
  const page = current.text();
  current.tui.press("tui.select.pageUp");
  const pageUp = current.text();
  current.tui.send("\u001b[F");
  const end = current.text();
  current.tui.send("\u001b[H");
  const home = current.text();
  const frames = [1, 2, 8, 20, 50, 80, 120].map((width) => ({ width, lines: current.tui.render(width) }));
  current.tui.press("ctrl+c");
  await running;
  assert.match(first, /\*\*literal\*\*/);
  assert.doesNotMatch(raw, /SECRET|example.invalid/);
  assert.equal(raw.includes("\u001b]"), false);
  assert.equal(raw.includes("\u009b"), false);
  assert.equal(raw.includes("\r"), false);
  assert.equal(raw.includes("\u0007"), false);
  assert.notEqual(down, first);
  assert.equal(up, first);
  assert.equal(pageUp, first);
  assert.equal(first.includes("\u001b"), false);
  assert.notEqual(page, first);
  assert.match(end, /line 39/);
  assert.equal(home, first);
  for (const { width, lines } of frames) assert.ok(lines.every((line) => visibleWidth(line) <= width));
});

test("viewer respects non-default navigation and cancel bindings", async () => {
  const bindings: Record<string, string> = {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.pageUp": "u",
    "tui.select.pageDown": "d",
    "tui.select.cancel": "q",
  };
  const current = await setup({
    rows: 12,
    keybindings: {
      matches: (data, binding) => data === bindings[binding],
      getKeys: (binding) => (bindings[binding] ? [bindings[binding] as KeyId] : []),
    },
  });
  await current.store.execute("test-session", { action: "add", texts: ["row\n".repeat(50)] });
  const running = current.command();
  await current.tui.waitForOpen();
  const before = current.text();
  current.tui.send("d");
  const after = current.text();
  current.tui.send("q");
  await running;
  assert.notEqual(after, before);
});

test("empty viewer does not create storage; malformed files remain unchanged", async () => {
  const current = await setup();
  const running = current.command();
  await current.tui.waitForOpen();
  const frame = current.text();
  current.tui.press("tui.select.cancel");
  await running;
  assert.match(frame, /No scratchpad notes/);
  assert.deepEqual(await readdir(current.directory), []);
  await current.store.execute("test-session", { action: "add", texts: ["note"] });
  const file = join(current.store.directory, "test-session.json");
  await writeFile(file, "invalid JSON");
  await current.command();
  assert.match(current.context.notifications.at(-1)?.message ?? "", /Could not read scratchpad.*INVALID_FILE/);
  assert.equal(await readFile(file, "utf8"), "invalid JSON");
});

for (const action of ["switch", "shutdown", "dispose"] as const) {
  test(`viewer closes on ${action}`, async () => {
    const current = await setup();
    const running = current.command();
    await current.tui.waitForOpen();
    if (action === "switch") current.runtime.beginSession(createMockContext().ctx);
    else if (action === "shutdown") current.runtime.stopSession(current.context.ctx);
    else current.tui.dispose();
    await running;
    assert.deepEqual(current.mock.entries, []);
  });
}

test("RPC gives a local file hint; print/JSON reject observably; no custom UI or state changes", async () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const current = await setup();
    const context = createMockContext({
      mode,
      hasUI: mode === "rpc",
      custom: () => {
        throw new Error("Unexpected custom UI");
      },
    });
    current.runtime.beginSession(context.ctx);
    const registeredCommand = current.mock.commands.get("scratchpad");
    assert.ok(registeredCommand);
    const command = () => registeredCommand.handler("show", context.ctx);
    if (mode === "rpc") {
      await command();
      assert.match(context.notifications.at(-1)?.message ?? "", /viewer requires TUI mode.*test-session.json/);
    } else await assert.rejects(async () => command(), /viewer requires TUI mode/);
    assert.deepEqual(await readdir(current.directory), []);
    assert.deepEqual(current.mock.sentMessages, []);
  }
});

test("command completes known routes and rejects trailing input", async () => {
  const current = await setup();
  const command = current.mock.commands.get("scratchpad");
  assert.ok(command);
  assert.deepEqual(command.getArgumentCompletions?.("sh"), [{ value: "show", label: "show" }]);
  await assert.rejects(async () => current.command("show other-session"), /Usage/);
});

test("session replacement during a pending read never opens the stale snapshot", async () => {
  const current = await setup();
  const originalRead = current.store.readSnapshot.bind(current.store);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  current.store.readSnapshot = async (...args) => {
    started();
    await pending;
    return originalRead(...args);
  };
  const running = current.command();
  await reading;
  current.runtime.beginSession(createMockContext().ctx);
  release();
  await running;
  assert.deepEqual(current.context.notifications, []);
  assert.deepEqual(await readdir(current.directory), []);
});

test("reopening reads fresh notes instead of retaining the previous snapshot", async () => {
  const current = await setup();
  await current.store.execute("test-session", { action: "add", texts: ["First version"] });
  const first = current.command();
  await current.tui.waitForOpen();
  current.tui.press("tui.select.cancel");
  await first;
  await current.store.execute("test-session", { action: "update", items: [{ id: 1, text: "Second version" }] });
  const second = current.command();
  await current.tui.waitForOpen();
  const text = current.text();
  current.tui.press("tui.select.cancel");
  await second;
  assert.match(text, /Second version/);
  assert.doesNotMatch(text, /First version/);
});

test("display failures are not reported as unreadable notes and do not expose renderer details", async () => {
  const current = await setup();
  await current.store.execute("test-session", { action: "add", texts: ["Private note"] });
  const file = join(current.store.directory, "test-session.json");
  const before = await readFile(file, "utf8");
  const failing = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async () => {
      throw new Error("Private note in renderer exception");
    },
  });
  current.runtime.beginSession(failing.ctx);
  const command = current.mock.commands.get("scratchpad");
  assert.ok(command);
  await command.handler("show", failing.ctx);
  assert.match(failing.notifications.at(-1)?.message ?? "", /Could not display/);
  assert.doesNotMatch(failing.notifications.at(-1)?.message ?? "", /Unable to read|Private note/);
  assert.equal(await readFile(file, "utf8"), before);
});
