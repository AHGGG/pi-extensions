import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  createCodexCompactSettingsRuntime,
  DEFAULT_CODEX_COMPACT_SETTINGS,
  loadCodexCompactSettings,
  normalizeCodexCompactSettings,
} from "../src/settings.js";

const temporaryDirectories: string[] = [];

async function tempSettingsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-compact-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "pi-codex-compact.json");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("normalizes defaults and bounded user settings", () => {
  assert.deepEqual(normalizeCodexCompactSettings({}), DEFAULT_CODEX_COMPACT_SETTINGS);
  assert.deepEqual(
    normalizeCodexCompactSettings({
      enabled: false,
      protocol: "responses-compact",
      apiProfiles: { "custom-responses": "codex-responses-v1" },
      maxRetries: 0,
    }),
    {
      ...DEFAULT_CODEX_COMPACT_SETTINGS,
      enabled: false,
      protocol: "responses-compact",
      apiProfiles: { "custom-responses": "codex-responses-v1" },
      maxRetries: 0,
    },
  );
  assert.equal(normalizeCodexCompactSettings({ protocol: "unknown" }), undefined);
  assert.equal(
    normalizeCodexCompactSettings({ apiProfiles: { "openai-codex-responses": "codex-responses-v1" } }),
    undefined,
  );
  assert.equal(
    normalizeCodexCompactSettings({ apiProfiles: { "anthropic-messages": "codex-responses-v1" } }),
    undefined,
  );
  assert.equal(normalizeCodexCompactSettings({ apiProfiles: { "custom-responses": "unknown" } }), undefined);
  assert.equal(normalizeCodexCompactSettings({ apiProfiles: { "custom responses": "codex-responses-v1" } }), undefined);
  assert.equal(normalizeCodexCompactSettings({ apiProfiles: [] }), undefined);
  assert.equal(normalizeCodexCompactSettings({ maxRetries: 3 }), undefined);
  assert.equal(normalizeCodexCompactSettings({ requestTimeoutMs: 10 }), undefined);
  assert.equal(normalizeCodexCompactSettings({ replacementTokenBudget: 1_000_000 }), undefined);
});

test("request timeout supports fifteen minutes while preserving defaults and validation", async () => {
  assert.equal(normalizeCodexCompactSettings({})?.requestTimeoutMs, 300_000);
  for (const requestTimeoutMs of [30_000, 600_000, 900_000])
    assert.equal(normalizeCodexCompactSettings({ requestTimeoutMs })?.requestTimeoutMs, requestTimeoutMs);
  for (const requestTimeoutMs of [29_999, 900_001])
    assert.equal(normalizeCodexCompactSettings({ requestTimeoutMs }), undefined);

  const path = await tempSettingsPath();
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.update({ requestTimeoutMs: 900_000 });
  assert.equal((await runtime.reload()).settings.requestTimeoutMs, 900_000);
  const saved = await readFile(path, "utf8");
  assert.equal(JSON.parse(saved).requestTimeoutMs, 900_000);
  await assert.rejects(runtime.update({ requestTimeoutMs: 900_001 }), /Refusing to save invalid/);
  assert.equal(runtime.get().settings.requestTimeoutMs, 900_000);
  assert.equal(await readFile(path, "utf8"), saved);
});

test("loads missing and valid files without consulting real user settings", async () => {
  const path = await tempSettingsPath();
  assert.equal((await loadCodexCompactSettings(path)).kind, "missing");
  await writeFile(path, '{"enabled":false,"futureField":"kept"}\n');
  const loaded = await loadCodexCompactSettings(path);
  assert.equal(loaded.kind, "loaded");
  assert.equal(loaded.settings.enabled, false);
  assert.equal(loaded.document?.futureField, "kept");
});

test("rejects invalid, oversized, and symbolic-link settings without overwriting", async () => {
  const path = await tempSettingsPath();
  await writeFile(path, "{invalid");
  assert.equal((await loadCodexCompactSettings(path)).kind, "invalid");
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.reload();
  await assert.rejects(runtime.update({ enabled: false }), /Cannot overwrite an invalid/);
  assert.equal(await readFile(path, "utf8"), "{invalid");

  const oversized = await tempSettingsPath();
  await writeFile(oversized, JSON.stringify({ padding: "x".repeat(70 * 1024) }));
  assert.match((await loadCodexCompactSettings(oversized)).issue ?? "", /64 KiB/);

  const target = await tempSettingsPath();
  const link = await tempSettingsPath();
  await writeFile(target, "{}");
  await symlink(target, link);
  assert.match((await loadCodexCompactSettings(link)).issue ?? "", /symbolic links/);
});

test("first explicit save creates a private settings file", async () => {
  const path = await tempSettingsPath();
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.update({ enabled: false });
  assert.equal(JSON.parse(await readFile(path, "utf8")).enabled, false);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("serialized updates reread latest content, preserve unknown fields, and publish atomically", async () => {
  const path = await tempSettingsPath();
  await writeFile(path, '{"enabled":true,"external":"first"}\n');
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.reload();
  await writeFile(path, '{"enabled":true,"external":"newer"}\n');
  await Promise.all([
    runtime.update({ enabled: false }),
    runtime.update({ maxRetries: 0 }),
    runtime.update({ protocol: "context-management" }),
  ]);
  await runtime.flush();
  const document = JSON.parse(await readFile(path, "utf8"));
  assert.equal(document.enabled, false);
  assert.equal(document.maxRetries, 0);
  assert.equal(document.external, "newer");
  assert.equal(document.protocol, "context-management");
  assert.equal((await runtime.reload()).settings.protocol, "context-management");
  assert.deepEqual(
    (await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("aborted settings operations do not publish", async () => {
  const path = await tempSettingsPath();
  const runtime = createCodexCompactSettingsRuntime(path);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.update({ enabled: false }, controller.signal), /aborted/i);
  assert.equal((await loadCodexCompactSettings(path)).kind, "missing");
});

test("checkpoint recovery defaults, validation, queued persistence and failed writes", async () => {
  assert.equal(normalizeCodexCompactSettings({})?.checkpointRecovery, "summarize");
  for (const value of ["cancel", "summarize"] as const)
    assert.equal(normalizeCodexCompactSettings({ checkpointRecovery: value })?.checkpointRecovery, value);
  for (const value of [null, false, 0, "native", {}, []])
    assert.equal(normalizeCodexCompactSettings({ checkpointRecovery: value }), undefined);
  const path = await tempSettingsPath();
  await writeFile(path, '{"future":{"keep":true}}');
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.reload();
  await Promise.all([
    runtime.update({ checkpointRecovery: "cancel" }),
    runtime.update({ checkpointRecovery: "summarize" }),
  ]);
  await runtime.flush();
  assert.equal((await runtime.reload()).settings.checkpointRecovery, "summarize");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).future, { keep: true });
  await assert.rejects(runtime.update({ checkpointRecovery: "invalid" as "cancel" }));
  assert.equal(runtime.get().settings.checkpointRecovery, "summarize");
  await runtime.update({ checkpointRecovery: "cancel" });
  assert.equal((await runtime.reload()).settings.checkpointRecovery, "cancel");
  await writeFile(path, '{"checkpointRecovery":"unknown"}');
  await runtime.reload();
  await assert.rejects(runtime.update({ checkpointRecovery: "cancel" }), /Cannot overwrite/);
  assert.equal(await readFile(path, "utf8"), '{"checkpointRecovery":"unknown"}');
});

test("warm-ahead defaults off and accepts only boolean enablement and integer percentage bounds", () => {
  assert.equal(normalizeCodexCompactSettings({})?.asyncEnabled, false);
  assert.equal(normalizeCodexCompactSettings({})?.asyncThresholdPercent, 65);
  assert.equal(normalizeCodexCompactSettings({ asyncEnabled: true })?.asyncEnabled, true);
  for (const asyncEnabled of [null, 0, 1, "true", {}, []])
    assert.equal(normalizeCodexCompactSettings({ asyncEnabled }), undefined);
  for (const asyncThresholdPercent of [1, 65, 99])
    assert.equal(
      normalizeCodexCompactSettings({ asyncThresholdPercent })?.asyncThresholdPercent,
      asyncThresholdPercent,
    );
  for (const asyncThresholdPercent of [0, 100, 65.5, NaN, Infinity, null, "65", true, {}, []])
    assert.equal(normalizeCodexCompactSettings({ asyncThresholdPercent }), undefined);
});

test("warm-ahead settings persist in order with unknown fields and invalid writes preserve prior state", async () => {
  const path = await tempSettingsPath();
  await writeFile(path, '{"future":{"keep":true}}');
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.reload();
  await Promise.all([
    runtime.update({ asyncEnabled: true }),
    runtime.update({ asyncThresholdPercent: 99 }),
    runtime.reload(),
  ]);
  assert.equal(runtime.get().settings.asyncEnabled, true);
  assert.equal(runtime.get().settings.asyncThresholdPercent, 99);
  const saved = await readFile(path, "utf8");
  assert.deepEqual(JSON.parse(saved), { future: { keep: true }, asyncEnabled: true, asyncThresholdPercent: 99 });
  await assert.rejects(runtime.update({ asyncThresholdPercent: 100 }), /Refusing to save invalid/);
  assert.equal(runtime.get().settings.asyncThresholdPercent, 99);
  assert.equal(await readFile(path, "utf8"), saved);
  await runtime.update({ asyncEnabled: false, asyncThresholdPercent: 1 });
  const reloaded = await runtime.reload();
  assert.equal(reloaded.settings.asyncEnabled, false);
  assert.equal(reloaded.settings.asyncThresholdPercent, 1);
  await writeFile(path, '{"asyncEnabled":true,"asyncThresholdPercent":0}');
  assert.equal((await runtime.reload()).kind, "invalid");
  await assert.rejects(runtime.update({ asyncThresholdPercent: 65 }), /Cannot overwrite/);
  assert.equal(await readFile(path, "utf8"), '{"asyncEnabled":true,"asyncThresholdPercent":0}');
});

test("compaction logging defaults off, validates booleans, and persists explicit changes", async () => {
  assert.equal(DEFAULT_CODEX_COMPACT_SETTINGS.logCompaction, false);
  for (const logCompaction of [true, false])
    assert.equal(normalizeCodexCompactSettings({ logCompaction })?.logCompaction, logCompaction);
  for (const logCompaction of ["true", 1, null])
    assert.equal(normalizeCodexCompactSettings({ logCompaction }), undefined);
  const path = await tempSettingsPath();
  await writeFile(path, '{"futureField":"kept"}\n');
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.reload();
  await runtime.update({ logCompaction: true });
  assert.equal((await runtime.reload()).settings.logCompaction, true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { futureField: "kept", logCompaction: true });
  await runtime.update({ logCompaction: false });
  assert.equal((await runtime.reload()).settings.logCompaction, false);
});

test("auto-apply is opt-in, strictly boolean, and persists without losing unknown fields", async () => {
  assert.equal(DEFAULT_CODEX_COMPACT_SETTINGS.asyncAutoApply, false);
  for (const asyncAutoApply of [true, false])
    assert.equal(normalizeCodexCompactSettings({ asyncAutoApply })?.asyncAutoApply, asyncAutoApply);
  for (const asyncAutoApply of [null, 0, "true", {}, []])
    assert.equal(normalizeCodexCompactSettings({ asyncAutoApply }), undefined);
  const path = await tempSettingsPath();
  await writeFile(path, '{"future":"keep"}');
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.update({ asyncAutoApply: true });
  assert.equal((await runtime.reload()).settings.asyncAutoApply, true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { future: "keep", asyncAutoApply: true });
  await runtime.update({ asyncAutoApply: false });
  assert.equal((await runtime.reload()).settings.asyncAutoApply, false);
});
