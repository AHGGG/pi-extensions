import assert from "node:assert/strict";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
  normalizeCodexCompactSettings,
} from "../src/settings.js";
import { createCodexCompactMenu } from "../src/settings-menu.js";

test("fork menu reports resolved OAuth protocol and offers five-minute steps up to thirty minutes", async () => {
  let state: CodexCompactSettingsState = {
    kind: "loaded",
    path: "/unused/pi-codex-compact.json",
    document: {},
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
  };
  const runtime: CodexCompactSettingsRuntime = {
    get: () => state,
    reload: async () => state,
    update: async (patch) => {
      const settings = normalizeCodexCompactSettings({ ...state.settings, ...patch });
      assert.ok(settings);
      state = { ...state, settings };
      return state;
    },
    flush: async () => {},
  };
  const menu = createCodexCompactMenu(runtime, {
    status: { model: "openai/fixture", api: "openai-responses" },
    lastProtocol: () => "context-management",
  });
  const main = resolveMenuScreen(menu, "main", runtime.get());
  assert.match(main.lines?.join("\n") ?? "", /Last resolved protocol: Context Management \(experimental\)/);
  const settings = resolveMenuScreen(menu, "settings", runtime.get());
  assert.equal(settings.kind, "settings");
  if (settings.kind !== "settings") assert.fail("Expected settings screen");
  const choices = ["5 min", "10 min", "15 min", "20 min", "25 min", "30 min"];
  assert.deepEqual(settings.items.find((item) => item.id === "requestTimeoutMs")?.values, choices);
  for (const value of choices) {
    await menu.actions["set-timeout"]({
      ctx: createMockContext({ mode: "tui" }).ctx,
      state: runtime.get(),
      signal: new AbortController().signal,
      itemId: "requestTimeoutMs",
      value,
    });
    assert.equal(runtime.get().settings.requestTimeoutMs, Number.parseInt(value, 10) * 60_000);
    const updated = resolveMenuScreen(menu, "settings", runtime.get());
    if (updated.kind !== "settings") assert.fail("Expected settings screen");
    assert.equal(updated.items.find((item) => item.id === "requestTimeoutMs")?.currentValue, value);
  }
  assert.equal(DEFAULT_CODEX_COMPACT_SETTINGS.requestTimeoutMs, 300_000);
});
