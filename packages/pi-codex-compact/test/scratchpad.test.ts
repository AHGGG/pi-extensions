import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createScratchpadRuntime } from "../src/scratchpad.js";
import { ScratchpadStore } from "../src/scratchpad-store.js";
import { createCodexCompactSettingsRuntime } from "../src/settings.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup(existingTools?: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "scratchpad-runtime-"));
  directories.push(directory);
  const settings = createCodexCompactSettingsRuntime(join(directory, "settings.json"));
  await settings.reload();
  const mock = createMockPi({ allTools: existingTools });
  const context = createMockContext();
  const store = new ScratchpadStore({ directory: join(directory, "notes") });
  let toggles = 0;
  const runtime = createScratchpadRuntime(mock.pi, settings, { store, onToggle: () => toggles++ });
  runtime.beginSession(context.ctx);
  runtime.sync(context.ctx);
  const tool = () => mock.tools.at(-1) as unknown as ToolDefinition;
  const command = (args: string) => mock.commands.get("scratchpad")?.handler(args, context.ctx);
  const execute = (args: unknown) => tool().execute("call", args as never, undefined, undefined, context.ctx);
  return { directory, settings, mock, context, runtime, store, tool, command, execute, toggles: () => toggles };
}

test("command toggles the same persistent setting and only re-registers the owned tool", async () => {
  const current = await setup();
  assert.equal(current.tool().exposure, "hidden");
  assert.equal(current.mock.tools.length, 1);
  const originalTools = (current.mock.pi as ExtensionAPI).getActiveTools();
  await current.command("on");
  assert.equal(current.tool().exposure, "direct");
  assert.equal(current.settings.get().settings.scratchpadEnabled, true);
  assert.equal(JSON.parse(await readFile(join(current.directory, "settings.json"), "utf8")).scratchpadEnabled, true);
  await current.command("status");
  assert.match(current.context.notifications.at(-1)?.message ?? "", /Notes file: .*test-session\.json/);
  await current.command("on");
  current.runtime.sync(current.context.ctx);
  assert.equal(current.mock.tools.length, 2);
  assert.equal(current.toggles(), 1);
  assert.deepEqual((current.mock.pi as ExtensionAPI).getActiveTools(), originalTools);
  await current.command("");
  assert.equal(current.tool().exposure, "hidden");
  await current.command("toggle");
  assert.equal(current.tool().exposure, "direct");
  await assert.rejects(async () => current.command("unknown"), /Usage/);
});

test("CRUD results are model-visible and structured, errors are tool failures, and Off preserves notes", async () => {
  const current = await setup();
  let response = await current.execute({ action: "read" });
  assert.equal(response.isError, true);
  assert.equal((response.structuredContent as { code: string }).code, "DISABLED");
  await current.command("on");
  response = await current.execute({ action: "add", texts: ["Verified test passed."] });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, JSON.parse((response.content[0] as { text: string }).text));
  const count = current.mock.tools.length;
  await current.execute({ action: "update", items: [{ id: 1, text: "Verified two tests passed." }] });
  assert.equal(current.mock.tools.length, count, "note edits must not rebuild the active tool set");
  response = await current.execute({ action: "delete", ids: [99] });
  assert.equal(response.isError, true);
  assert.equal((response.structuredContent as { code: string }).code, "ITEM_NOT_FOUND");
  await current.command("off");
  await current.command("on");
  response = await current.execute({ action: "read" });
  assert.match(JSON.stringify(response.structuredContent), /Verified two tests passed/);
  assert.equal(current.mock.sentMessages.length, 0);
  assert.equal(current.mock.sentUserMessages.length, 0);
  assert.equal(current.mock.entries.length, 0);
});

test("settings menu-style changes sync independently of remote compaction enabled", async () => {
  const current = await setup();
  await current.settings.update({ enabled: false, scratchpadEnabled: true });
  current.runtime.sync(current.context.ctx);
  assert.equal(current.tool().exposure, "direct");
  assert.equal((await current.execute({ action: "read" })).isError, undefined);
  await current.settings.update({ scratchpadEnabled: false });
  current.runtime.sync(current.context.ctx);
  assert.equal(current.tool().exposure, "hidden");
});

test("existing scratchpad tool is never overwritten", async () => {
  const current = await setup([{ name: "scratchpad", description: "Other extension" }]);
  assert.equal(current.mock.tools.length, 0);
  assert.match(current.context.notifications[0].message, /already registered/);
  await assert.rejects(async () => current.command("on"), /Another extension/);
  assert.equal(current.settings.get().settings.scratchpadEnabled, false);
  await current.settings.update({ scratchpadEnabled: true });
  await current.command("off");
  assert.equal(current.settings.get().settings.scratchpadEnabled, false);
  assert.equal(current.mock.tools.length, 0);
});

test("session switches and shutdown reject stale calls", async () => {
  const current = await setup();
  await current.command("on");
  const next = createMockContext({
    sessionManager: { getSessionId: () => "other-session", getBranch: () => [], getEntries: () => [] },
  });
  current.runtime.beginSession(next.ctx);
  current.runtime.sync(next.ctx);
  assert.equal((await current.execute({ action: "add", texts: ["Wrong session"] })).isError, true);
  const response = await current.tool().execute("call", { action: "read" }, undefined, undefined, next.ctx);
  assert.equal(response.isError, undefined);
  assert.match(JSON.stringify(response.structuredContent), /"total":0/);
  current.runtime.stopSession(next.ctx);
  assert.equal(
    (await current.tool().execute("call", { action: "read" }, undefined, undefined, next.ctx)).isError,
    true,
  );
});

test("tool supports semantic summaries with legacy adds, partial updates and stable definitions", async () => {
  const current = await setup();
  await current.command("on");
  const count = current.mock.tools.length;
  assert.equal(
    (await current.execute({ action: "add", items: [{ text: "Full note", summary: "Summary" }] })).isError,
    undefined,
  );
  assert.equal((await current.execute({ action: "add", texts: ["Legacy note"] })).isError, undefined);
  await current.execute({ action: "update", items: [{ id: 1, summary: "Updated summary" }] });
  const result = await current.execute({ action: "read" });
  assert.match(JSON.stringify(result.structuredContent), /Updated summary/);
  assert.doesNotMatch(JSON.stringify(result.structuredContent), /summaryTextHash/);
  assert.equal(current.mock.tools.length, count);
  await current.execute({ action: "update", items: [{ id: 1, text: "New full text" }] });
  assert.doesNotMatch(JSON.stringify((await current.execute({ action: "read" })).structuredContent), /Updated summary/);
  assert.deepEqual(current.mock.sentMessages, []);
  assert.deepEqual(current.mock.sentUserMessages, []);
});
