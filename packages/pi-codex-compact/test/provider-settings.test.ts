import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { afterEach, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  compactionSettingsKey,
  createCodexCompactSettingsRuntime,
  DEFAULT_CODEX_COMPACT_SETTINGS,
  effectiveCodexCompactSettings,
  MAX_PROVIDER_OVERRIDES,
  normalizeCodexCompactSettings,
} from "../src/settings.js";
import { createCodexCompactMenu, showCodexCompactMenu } from "../src/settings-menu.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(document?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "provider-settings-"));
  directories.push(directory);
  const path = join(directory, "settings.json");
  if (document !== undefined) await writeFile(path, JSON.stringify(document));
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.reload();
  return { path, runtime };
}

test("provider overrides inherit each missing field and do not affect other provider fingerprints", () => {
  const settings = normalizeCodexCompactSettings({
    protocol: "remote-v2",
    providerOverrides: { custom: { compactionMode: "text-summary" }, other: { protocol: "context-management" } },
  });
  assert.ok(settings);
  const custom = effectiveCodexCompactSettings(settings, "custom");
  assert.equal(custom.compactionMode, "text-summary");
  assert.equal(custom.protocol, "remote-v2");
  assert.equal(effectiveCodexCompactSettings(settings, "openai").compactionMode, "provider-checkpoint");
  assert.equal(effectiveCodexCompactSettings(settings, "other").protocol, "context-management");
  const key = compactionSettingsKey(custom);
  settings.providerOverrides.other = { compactionMode: "text-summary", protocol: "responses-compact" };
  assert.equal(compactionSettingsKey(effectiveCodexCompactSettings(settings, "custom")), key);
  settings.providerOverrides.custom.protocol = "auto";
  assert.notEqual(compactionSettingsKey(effectiveCodexCompactSettings(settings, "custom")), key);
  assert.equal(DEFAULT_CODEX_COMPACT_SETTINGS.compactionMode, "provider-checkpoint");
});

test("provider override validation rejects malformed maps, unsafe keys and invalid recognized fields", () => {
  for (const providerOverrides of [
    null,
    [],
    "custom",
    { custom: null },
    { custom: [] },
    { custom: { protocol: "invalid" } },
    { custom: { compactionMode: false } },
    { "": {} },
    { " custom": {} },
    { "bad\nkey": {} },
    { ["x".repeat(257)]: {} },
    JSON.parse('{"__proto__":{"compactionMode":"text-summary"}}'),
    { constructor: {} },
    { prototype: {} },
    Object.fromEntries(Array.from({ length: MAX_PROVIDER_OVERRIDES + 1 }, (_, n) => [`p${n}`, {}])),
  ])
    assert.equal(normalizeCodexCompactSettings({ providerOverrides }), undefined);
  const value = normalizeCodexCompactSettings({
    providerOverrides: { "custom provider": { protocol: "auto", future: 1 } },
  });
  assert.deepEqual(value?.providerOverrides, { "custom provider": { protocol: "auto" } });
  assert.equal(
    effectiveCodexCompactSettings({ ...DEFAULT_CODEX_COMPACT_SETTINGS }, "constructor").compactionMode,
    "provider-checkpoint",
  );
});

test("queued provider saves merge latest nested fields, reset only known overrides and preserve global fields", async () => {
  const h = await fixture({
    compactionMode: "provider-checkpoint",
    untouched: "keep",
    providerOverrides: { custom: { protocol: "auto", future: { keep: true } }, other: { protocol: "remote-v2" } },
  });
  // An external edit between load and update must survive the scoped save.
  const document = JSON.parse(await readFile(h.path, "utf8"));
  document.providerOverrides.external = { protocol: "responses-compact", future: 2 };
  await writeFile(h.path, JSON.stringify(document));
  await Promise.all([
    h.runtime.update({ compactionMode: "text-summary" }, undefined, "custom"),
    h.runtime.update({ protocol: "context-management" }, undefined, "other"),
    h.runtime.update({ protocol: "remote-v2" }, undefined, "custom"),
    h.runtime.update({ notifyOnFallback: false }),
  ]);
  await h.runtime.flush();
  let saved = JSON.parse(await readFile(h.path, "utf8"));
  assert.equal(saved.compactionMode, "provider-checkpoint");
  assert.equal(saved.untouched, "keep");
  assert.deepEqual(saved.providerOverrides.custom, {
    protocol: "remote-v2",
    compactionMode: "text-summary",
    future: { keep: true },
  });
  assert.deepEqual(saved.providerOverrides.external, document.providerOverrides.external);
  assert.deepEqual(saved.providerOverrides.other, { protocol: "context-management" });
  assert.equal(
    effectiveCodexCompactSettings((await h.runtime.reload()).settings, "custom").compactionMode,
    "text-summary",
  );
  await h.runtime.update({}, undefined, "custom");
  saved = JSON.parse(await readFile(h.path, "utf8"));
  assert.deepEqual(saved.providerOverrides.custom, { future: { keep: true } });
  assert.equal(effectiveCodexCompactSettings(h.runtime.get().settings, "custom").compactionMode, "provider-checkpoint");
  await h.runtime.update({}, undefined, "other");
  saved = JSON.parse(await readFile(h.path, "utf8"));
  assert.equal(Object.hasOwn(saved.providerOverrides, "other"), false);
});

test("scoped writes reject invalid data and preserve file/runtime state after failure or cancellation", async () => {
  const h = await fixture({ providerOverrides: { custom: { compactionMode: "text-summary" } } });
  const before = await readFile(h.path, "utf8");
  const state = h.runtime.get();
  await assert.rejects(h.runtime.update({ enabled: false }, undefined, "custom"), /Invalid provider/);
  await assert.rejects(h.runtime.update({ protocol: "bad" as "auto" }, undefined, "custom"), /invalid Codex/);
  await assert.rejects(h.runtime.update({ protocol: "auto" }, undefined, "__proto__"), /Invalid provider/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(h.runtime.update({ protocol: "auto" }, cancelled.signal, "custom"), /aborted/);
  assert.equal(await readFile(h.path, "utf8"), before);
  assert.deepEqual(h.runtime.get(), state);
  await writeFile(h.path, '{"providerOverrides":{"custom":{"protocol":"bad"}}}');
  await assert.rejects(h.runtime.update({ compactionMode: "text-summary" }, undefined, "other"), /Cannot overwrite/);
  assert.equal(await readFile(h.path, "utf8"), '{"providerOverrides":{"custom":{"protocol":"bad"}}}');
});

test("provider menu displays inherited effective values, saves only selected scope and resets overrides", async () => {
  const h = await fixture();
  const { ctx } = createMockContext({ mode: "tui" });
  const menu = createCodexCompactMenu(h.runtime, {
    status: { provider: "custom", model: "custom/model", api: "openai-responses" },
  });
  const args = (value?: string) => ({
    ctx,
    state: h.runtime.get(),
    signal: new AbortController().signal,
    itemId: "setting",
    value,
  });
  const screen = () => {
    const result = resolveMenuScreen(menu, "settings", h.runtime.get());
    assert.equal(result.kind, "settings");
    if (result.kind !== "settings") assert.fail("Expected settings");
    return result;
  };
  assert.equal(screen().items.find((row) => row.id === "scope")?.currentValue, "This provider");
  assert.match(screen().items.find((row) => row.id === "compactionMode")?.description ?? "", /Inherited/);
  await menu.actions["set-mode"](args("Text summary"));
  assert.equal(h.runtime.get().settings.compactionMode, "provider-checkpoint");
  assert.equal(screen().items.find((row) => row.id === "compactionMode")?.currentValue, "Text summary");
  assert.match(
    resolveMenuScreen(menu, "main", h.runtime.get()).lines?.join("\n") ?? "",
    /Compaction mode: Text summary/,
  );
  await menu.actions["set-protocol"](args("Remote V2"));
  await menu.actions["set-scope"](args("Global defaults"));
  await menu.actions["set-mode"](args("Text summary"));
  await menu.actions["set-protocol"](args("Responses Compact"));
  assert.equal(h.runtime.get().settings.protocol, "responses-compact");
  assert.equal(h.runtime.get().settings.providerOverrides.custom.protocol, "remote-v2");
  await menu.actions["set-scope"](args("This provider"));
  await menu.actions["reset-provider"](args());
  assert.deepEqual(h.runtime.get().settings.providerOverrides, {});
  assert.equal(screen().items.find((row) => row.id === "protocol")?.currentValue, "Responses Compact");
});

test("provider captured by a pending menu save cannot be replaced by a new selection", async () => {
  const h = await fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = "first";
  const targets: (string | undefined)[] = [];
  const runtime = {
    ...h.runtime,
    update: async (...args: Parameters<typeof h.runtime.update>) => {
      targets.push(args[2]);
      await wait;
      return h.runtime.update(...args);
    },
  };
  const menu = createCodexCompactMenu(runtime, {
    status: { provider: active, model: "first/model", api: "openai-responses" },
    isCurrent: () => active === "first",
  });
  const { ctx, notifications } = createMockContext({ mode: "tui" });
  const args = {
    ctx,
    state: runtime.get(),
    signal: new AbortController().signal,
    itemId: "compactionMode",
    value: "Text summary",
  };
  const saving = menu.actions["set-mode"](args);
  active = "second";
  release();
  assert.deepEqual(await saving, { kind: "rejected" });
  assert.deepEqual(targets, ["first"]);
  assert.equal(runtime.get().settings.providerOverrides.first.compactionMode, "text-summary");
  assert.equal(runtime.get().settings.providerOverrides.second, undefined);
  assert.deepEqual(await menu.actions["set-mode"](args), { kind: "rejected" });
  assert.deepEqual(notifications, []);
});

test("provider changes before rendering close the stale menu without applying actions", async () => {
  const h = await fixture();
  let model = { provider: "first", id: "model", api: "openai-responses" };
  let rendered = false;
  const { ctx } = createMockContext({
    mode: "tui",
    custom: async () => {
      rendered = true;
    },
  });
  Object.defineProperty(ctx, "model", { get: () => model });
  const runtime = {
    ...h.runtime,
    get: () => {
      model = { ...model, provider: "second" };
      return h.runtime.get();
    },
  };
  await showCodexCompactMenu(runtime, ctx, { signal: new AbortController().signal, isCurrent: () => true });
  assert.equal(rendered, false);
  assert.deepEqual(h.runtime.get().settings.providerOverrides, {});
});
