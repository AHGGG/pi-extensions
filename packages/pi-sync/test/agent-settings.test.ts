import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig, syncConfigReviewFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { startupTransferEnabled } from "../src/sync/agent-policy.js";
import { saveAgentMode } from "../src/ui/agent-mode-setting.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

for (const version of [3, 4, 5])
  test(`Agent mode is additive in settings version ${version}`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settings = { ...v3S3Settings(), version, unknown: { keep: true } };
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const off = await loadConfig();
      assert.equal(off.agentMode, false);
      await updateLocalConfig((current) => {
        assert.ok(current.syncSetups.home);
        return {
          ...current,
          syncSetups: {
            ...current.syncSetups,
            home: { ...current.syncSetups.home, sync: { ...current.syncSetups.home.sync, agentMode: true } },
          },
        };
      });
      const on = await loadConfig();
      assert.equal(on.agentMode, true);
      assert.notEqual(syncConfigReviewFingerprint(off), syncConfigReviewFingerprint(on));
      const persisted = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      assert.equal(persisted.version, version);
      assert.deepEqual(persisted.unknown, { keep: true });
    }));

for (const bad of ["true", 1, null, {}, []])
  test(`Agent mode rejects non-boolean ${JSON.stringify(bad)}`, () => {
    const settings = v3S3Settings();
    Object.assign(settings.syncSetups.home.sync, { agentMode: bad });
    assert.throws(() => validateSettingsDocument(settings), /agentMode.*boolean/);
  });

for (const automatic of [false, true])
  for (const automaticTransfer of [false, true])
    for (const agentMode of [false, true])
      test(`startup authorization ${automatic}/${automaticTransfer}/${agentMode}`, () => {
        assert.equal(startupTransferEnabled({ automaticTransfer, agentMode }), automaticTransfer || agentMode);
      });

for (const decision of ["cancel", "approve", "stale", "abort"] as const)
  test(`one-time consent ${decision} preserves authorization boundaries`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(localConfigPath(), JSON.stringify({ ...v3S3Settings(), unknown: "keep" }));
      const controller = new AbortController();
      let summary = "";
      const mock = createMockContext({
        mode: "rpc",
        select: async (title: string) => {
          summary = title;
          if (decision === "stale")
            await updateLocalConfig((current) => {
              assert.ok(current.syncSetups.home);
              return {
                ...current,
                syncSetups: {
                  ...current.syncSetups,
                  home: { ...current.syncSetups.home, sync: { ...current.syncSetups.home.sync, automatic: true } },
                },
              };
            });
          if (decision === "abort") controller.abort();
          return decision === "cancel" ? "No, cancel" : "Yes, Enable Agent mode";
        },
      });
      if (decision === "stale")
        await assert.rejects(saveAgentMode(mock.ctx, "home", true, controller.signal), /changed/);
      else assert.equal(await saveAgentMode(mock.ctx, "home", true, controller.signal), decision === "approve");
      const persisted = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      assert.equal(Boolean(persisted.syncSetups.home.sync.agentMode), decision === "approve");
      assert.equal(persisted.unknown, "keep");
      assert.match(summary, /incur costs/);
      assert.match(summary, /No transfer starts from Settings/);
      assert.doesNotMatch(summary, /secret-key/);
    }));

test("TUI enablement supports hard cancel with non-default cancellation bindings", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
    let rendered: string[] = [];
    let callbackError: unknown;
    const mock = createMockContext({
      mode: "tui",
      custom: async (factory: unknown) => {
        try {
          let complete!: (value: unknown) => void;
          const result = new Promise<unknown>((resolve) => {
            complete = resolve;
          });
          const component = await (
            factory as (
              ...args: unknown[]
            ) => Promise<{ render(width: number): string[]; handleInput(input: string): void; dispose?(): void }>
          )(
            { terminal: { rows: 16 }, requestRender() {} },
            { fg: (_role: string, value: string) => value, bold: (value: string) => value },
            {
              matches: (input: string, action: string) => action === "tui.select.cancel" && input === "\u0011",
              getKeys: (action: string) => (action === "tui.select.cancel" ? ["ctrl+q"] : []),
            },
            complete,
          );
          rendered = component.render(48);
          component.handleInput("\u0003");
          try {
            return await result;
          } finally {
            component.dispose?.();
          }
        } catch (error) {
          callbackError = error;
          throw error;
        }
      },
    });
    const result = await saveAgentMode(mock.ctx, "home", true).catch((error) => {
      throw callbackError ?? error;
    });
    assert.equal(result, false);
    assert.ok(rendered.length > 0);
    assert.equal((await loadConfig()).agentMode, false);
  }));

test("disabling needs no confirmation and invalid documents are never replaced", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const settings = v3S3Settings();
    Object.assign(settings.syncSetups.home.sync, { agentMode: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const mock = createMockContext({
      mode: "rpc",
      select: async () => {
        throw new Error("unexpected consent");
      },
    });
    assert.equal(await saveAgentMode(mock.ctx, "home", false), true);
    assert.equal((await loadConfig()).agentMode, false);
    await fs.writeFile(localConfigPath(), "{broken");
    await assert.rejects(saveAgentMode(mock.ctx, "home", true));
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), "{broken");
  }));

test("failed atomic Agent mode save preserves prior bytes and permits retry", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const original = JSON.stringify({ ...v3S3Settings(), unknown: "preserve" });
    await fs.writeFile(localConfigPath(), original);
    const mock = createMockContext({ mode: "rpc", select: async () => "Yes, Enable Agent mode" });
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(new Error("simulated disk failure"));
    try {
      await assert.rejects(saveAgentMode(mock.ctx, "home", true), /failure/);
    } finally {
      rename.mockRestore();
    }
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), original);
    assert.equal((await loadConfig()).agentMode, false);
    assert.equal(await saveAgentMode(mock.ctx, "home", true), true);
    assert.equal((await loadConfig()).agentMode, true);
  }));
