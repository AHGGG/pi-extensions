import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { afterEach, test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
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

test("settings distinguish active provider overrides, inherited fields, and editable global defaults", async () => {
  const h = await fixture({
    protocol: "remote-v2",
    providerOverrides: {
      both: { compactionMode: "text-summary", protocol: "responses-compact" },
      modeOnly: { compactionMode: "text-summary" },
      protocolOnly: { protocol: "context-management" },
      empty: {},
    },
  });
  const cases = [
    {
      provider: "both",
      lines: [
        "Provider override active: Text summary",
        "Effective protocol preference: Responses Compact (provider override)",
        "Protocol preference is unused in Text summary mode.",
      ],
    },
    {
      provider: "modeOnly",
      lines: [
        "Provider override active: Text summary",
        "Effective protocol preference: Remote V2 (from global default)",
        "Protocol preference is unused in Text summary mode.",
      ],
    },
    {
      provider: "protocolOnly",
      lines: [
        "Provider override active: Provider checkpoint (from global default)",
        "Effective protocol preference: Context Management (experimental) (provider override)",
      ],
    },
    { provider: "empty", lines: ["Provider preferences: Global defaults"] },
    { provider: "unconfigured", lines: ["Provider preferences: Global defaults"] },
    { provider: undefined, lines: ["Provider preferences: Global defaults"] },
  ];
  for (const { provider, lines } of cases) {
    const menu = createCodexCompactMenu(h.runtime, { status: { provider, model: `${provider ?? "none"}/model` } });
    const screen = resolveMenuScreen(menu, "settings", h.runtime.get());
    assert.equal(screen.kind, "settings");
    if (screen.kind !== "settings") assert.fail("Expected settings");
    assert.equal(screen.lines?.[1], `Current provider: ${provider ?? "none"}`);
    assert.deepEqual(screen.lines?.slice(3), lines, provider ?? "none");
    assert.deepEqual(
      screen.items
        .filter((row) => ["compactionMode", "protocol"].includes(row.id))
        .map((row) => [row.label, row.currentValue]),
      [
        ["Global default mode", "Provider checkpoint"],
        ["Global default protocol", "Remote V2"],
      ],
      provider ?? "none",
    );
  }
});

test("partial override headers refresh inherited values after global edits and clear after reset", async () => {
  const h = await fixture({
    protocol: "remote-v2",
    providerOverrides: {
      custom: { protocol: "context-management" },
      other: { compactionMode: "text-summary" },
    },
  });
  const menu = createCodexCompactMenu(h.runtime, { status: { provider: "custom", model: "custom/model" } });
  const args = {
    ctx: createMockContext({ mode: "tui" }).ctx,
    state: h.runtime.get(),
    signal: new AbortController().signal,
    itemId: "setting",
  };
  const lines = () => resolveMenuScreen(menu, "settings", h.runtime.get()).lines?.slice(3);
  assert.deepEqual(lines(), [
    "Provider override active: Provider checkpoint (from global default)",
    "Effective protocol preference: Context Management (experimental) (provider override)",
  ]);
  await menu.actions["set-mode"]({ ...args, value: "Text summary" });
  assert.deepEqual(lines(), [
    "Provider override active: Text summary (from global default)",
    "Effective protocol preference: Context Management (experimental) (provider override)",
    "Protocol preference is unused in Text summary mode.",
  ]);
  await menu.actions["reset-provider"](args);
  assert.deepEqual(lines(), ["Provider preferences: Global defaults"]);
  assert.deepEqual(h.runtime.get().settings.providerOverrides, { other: { compactionMode: "text-summary" } });
  const other = createCodexCompactMenu(h.runtime, { status: { provider: "other", model: "other/model" } });
  await menu.actions["set-protocol"]({ ...args, value: "Responses Compact" });
  assert.deepEqual(resolveMenuScreen(other, "settings", h.runtime.get()).lines?.slice(3), [
    "Provider override active: Text summary",
    "Effective protocol preference: Responses Compact (from global default)",
    "Protocol preference is unused in Text summary mode.",
  ]);
});

test("provider menu edits global defaults, snapshots both fields, and resets only the active override", async () => {
  const h = await fixture({
    untouched: true,
    apiProfiles: { "custom-responses": "codex-responses-v1" },
    providerOverrides: {
      custom: { compactionMode: "provider-checkpoint", protocol: "auto", future: { keep: true } },
      other: { protocol: "context-management" },
    },
  });
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
  assert.equal(
    screen().items.some((row) => row.id === "scope"),
    false,
  );
  assert.match(screen().lines?.join("\n") ?? "", /Editing global defaults.*overrides remain active/);
  await menu.actions["set-mode"](args("Text summary"));
  await menu.actions["set-protocol"](args("Responses Compact"));
  assert.equal(h.runtime.get().settings.compactionMode, "text-summary");
  assert.equal(h.runtime.get().settings.protocol, "responses-compact");
  assert.deepEqual(h.runtime.get().settings.providerOverrides.custom, {
    compactionMode: "provider-checkpoint",
    protocol: "auto",
  });
  assert.equal(screen().items.find((row) => row.id === "compactionMode")?.currentValue, "Text summary");
  assert.equal(screen().items.find((row) => row.id === "protocol")?.currentValue, "Responses Compact");
  assert.match(screen().lines?.join("\n") ?? "", /Provider override active: Provider checkpoint/);
  assert.match(
    resolveMenuScreen(menu, "main", h.runtime.get()).lines?.join("\n") ?? "",
    /Compaction mode: Provider checkpoint/,
  );
  await menu.actions["save-provider"](args());
  let saved = JSON.parse(await readFile(h.path, "utf8"));
  assert.deepEqual(saved.providerOverrides.custom, {
    compactionMode: "text-summary",
    protocol: "responses-compact",
    future: { keep: true },
  });
  assert.deepEqual(saved.providerOverrides.other, { protocol: "context-management" });
  assert.equal(saved.untouched, true);
  assert.deepEqual(saved.apiProfiles, { "custom-responses": "codex-responses-v1" });
  assert.match(
    resolveMenuScreen(menu, "main", h.runtime.get()).lines?.join("\n") ?? "",
    /Compaction mode: Text summary/,
  );
  await menu.actions["set-mode"](args("Provider checkpoint"));
  await menu.actions["reset-provider"](args());
  saved = JSON.parse(await readFile(h.path, "utf8"));
  assert.deepEqual(saved.providerOverrides.custom, { future: { keep: true } });
  assert.deepEqual(saved.providerOverrides.other, { protocol: "context-management" });
  assert.equal(
    screen().items.some((row) => row.id === "resetProvider"),
    false,
  );
  assert.match(screen().lines?.join("\n") ?? "", /Provider preferences: Global defaults/);
  assert.equal(effectiveCodexCompactSettings(h.runtime.get().settings, "custom").compactionMode, "provider-checkpoint");
  assert.equal(effectiveCodexCompactSettings(h.runtime.get().settings, "custom").protocol, "responses-compact");
});

for (const activation of ["enter", "space", "remapped"] as const) {
  test(`TUI ${activation} snapshots rapid queued global edits and refreshes provider status`, async () => {
    const h = await fixture({
      providerOverrides: { custom: { compactionMode: "provider-checkpoint", protocol: "auto" } },
    });
    let calls = 0;
    const captures: string[][] = [];
    const confirm = activation === "space" ? " " : activation === "remapped" ? "\u0019" : "\r";
    const keybindings =
      activation === "remapped"
        ? {
            matches: (data: string, action: string) =>
              action === "tui.select.confirm"
                ? data === "\u0019"
                : action === "tui.select.down"
                  ? matchesKey(data, Key.down)
                  : action === "tui.select.cancel" && matchesKey(data, Key.escape),
            getKeys: (action: string) =>
              action === "tui.select.confirm" ? ["ctrl+y"] : action === "tui.select.down" ? ["down"] : ["escape"],
          }
        : undefined;
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      model: { provider: "custom", id: "model", api: "openai-responses" },
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 100, keybindings, 36);
        try {
          const step = calls++;
          captures.push(harness.render());
          if (step === 0) {
            harness.handleInput("tui.select.down");
            harness.handleInput(activation === "remapped" ? "\u0019" : "\r");
          } else if (step === 1) {
            harness.handleInput("tui.select.down"); // mode
            harness.handleInput(confirm);
            harness.handleInput("tui.select.down"); // scratchpad
            harness.handleInput("tui.select.down"); // protocol
            harness.handleInput(confirm);
            harness.handleInput("tui.select.down"); // snapshot
            harness.handleInput(confirm);
          } else {
            captures.push(harness.render(12));
            captures.push(harness.render(0));
            harness.handleInput("\u0003");
          }
          await harness.waitForPending();
          return await harness.resultPromise;
        } finally {
          harness.dispose();
        }
      },
    });
    await showCodexCompactMenu(h.runtime, ctx, { signal: new AbortController().signal, isCurrent: () => true });
    assert.equal(calls, 3);
    assert.deepEqual(
      notifications.filter((entry) => entry.level === "error"),
      [],
    );
    const saved = JSON.parse(await readFile(h.path, "utf8"));
    assert.equal(saved.compactionMode, "text-summary");
    assert.equal(saved.protocol, "remote-v2");
    assert.deepEqual(saved.providerOverrides.custom, { compactionMode: "text-summary", protocol: "remote-v2" });
    assert.match(captures[2].join("\n"), /Provider override active: Text summary/);
    assert.match(captures[2].join("\n"), /Effective protocol preference: Remote V2 \(provider override\)/);
    assert.ok(captures[3].every((line) => visibleWidth(line) <= 12));
    assert.ok(captures[4].every((line) => visibleWidth(line) <= 1));
  });
}

test("provider snapshot uses displayed globals, not unseen reloaded values or effective overrides", async () => {
  const h = await fixture({
    compactionMode: "text-summary",
    protocol: "remote-v2",
    providerOverrides: { custom: { protocol: "auto" } },
  });
  const menu = createCodexCompactMenu(h.runtime, { status: { provider: "custom", model: "custom/model" } });
  resolveMenuScreen(menu, "settings", h.runtime.get());
  await h.runtime.update({ compactionMode: "provider-checkpoint", protocol: "responses-compact" });
  await menu.actions["save-provider"]({
    ctx: createMockContext({ mode: "tui" }).ctx,
    state: h.runtime.get(),
    signal: new AbortController().signal,
    itemId: "saveProvider",
  });
  assert.deepEqual(h.runtime.get().settings.providerOverrides.custom, {
    compactionMode: "text-summary",
    protocol: "remote-v2",
  });
  assert.equal(h.runtime.get().settings.protocol, "responses-compact");
});

test("no active provider keeps global controls and omits snapshot and reset actions", async () => {
  const h = await fixture();
  const menu = createCodexCompactMenu(h.runtime);
  const screen = resolveMenuScreen(menu, "settings", h.runtime.get());
  assert.equal(screen.kind, "settings");
  if (screen.kind !== "settings") assert.fail("Expected settings");
  assert.equal(
    screen.items.some((item) => ["scope", "saveProvider", "resetProvider"].includes(item.id)),
    false,
  );
  const args = {
    ctx: createMockContext({ mode: "tui" }).ctx,
    state: h.runtime.get(),
    signal: new AbortController().signal,
    itemId: "setting",
  };
  assert.deepEqual(await menu.actions["save-provider"](args), { kind: "rejected" });
  assert.deepEqual(await menu.actions["reset-provider"](args), { kind: "rejected" });
  await menu.actions["set-mode"]({ ...args, value: "Text summary" });
  assert.equal(h.runtime.get().settings.compactionMode, "text-summary");
  assert.deepEqual(h.runtime.get().settings.providerOverrides, {});
});

test("provider captured by a pending menu save cannot be replaced by a new selection", async () => {
  const h = await fixture({ compactionMode: "text-summary", protocol: "remote-v2" });
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
    itemId: "saveProvider",
  };
  const saving = menu.actions["save-provider"](args);
  active = "second";
  release();
  assert.deepEqual(await saving, { kind: "rejected" });
  assert.deepEqual(targets, ["first"]);
  assert.deepEqual(runtime.get().settings.providerOverrides.first, {
    compactionMode: "text-summary",
    protocol: "remote-v2",
  });
  assert.equal(runtime.get().settings.providerOverrides.second, undefined);
  assert.deepEqual(await menu.actions["save-provider"](args), { kind: "rejected" });
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

test("failed global edits leave the displayed snapshot unchanged and failed provider actions preserve overrides", async () => {
  const h = await fixture({ providerOverrides: { custom: { protocol: "context-management" } } });
  let fail = true;
  const runtime = {
    ...h.runtime,
    update: (...args: Parameters<typeof h.runtime.update>) => {
      if (fail) return Promise.reject(new Error("snapshot write failed"));
      return h.runtime.update(...args);
    },
  };
  const menu = createCodexCompactMenu(runtime, { status: { provider: "custom", model: "custom/model" } });
  const { ctx, notifications } = createMockContext({ mode: "tui" });
  const original = h.runtime.get();
  const before = await readFile(h.path, "utf8");
  resolveMenuScreen(menu, "settings", original);
  const args = { ctx, state: original, signal: new AbortController().signal, itemId: "setting" };
  assert.deepEqual(await menu.actions["set-mode"]({ ...args, value: "Text summary" }), { kind: "rejected" });
  assert.deepEqual(await menu.actions["save-provider"](args), { kind: "rejected" });
  assert.deepEqual(await menu.actions["reset-provider"](args), { kind: "rejected" });
  assert.deepEqual(h.runtime.get(), original);
  assert.equal(await readFile(h.path, "utf8"), before);
  assert.equal(notifications.filter((entry) => entry.level === "error").length, 3);
  fail = false;
  assert.deepEqual(await menu.actions["save-provider"](args), { kind: "stay" });
  assert.deepEqual(h.runtime.get().settings.providerOverrides.custom, {
    compactionMode: "provider-checkpoint",
    protocol: "auto",
  });
});
