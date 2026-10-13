import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { formatUsageStatusline, formatUsageStatuslineWithCountdown } from "../src/format.js";
import { DEFAULT_USAGE_SETTINGS, type UsageSettingsRuntime, type UsageSettingsState } from "../src/settings.js";
import type { UsageReport } from "../src/types.js";

const now = Date.parse("2026-10-12T00:00:00Z");
const providers = [
  ["kimi-coding", "kimi", "https://api.kimi.com/coding"],
  ["minimax", "minimax", "https://api.minimax.io/anthropic"],
  ["minimax-cn", "minimax cn", "https://api.minimaxi.com/anthropic"],
  ["zai", "zai", "https://api.z.ai/api/coding/paas/v4"],
  ["zai-coding-cn", "zai", "https://open.bigmodel.cn/api/coding/paas/v4"],
  ["command-code", "cmd", "https://api.commandcode.ai/provider"],
  ["opencode-go", "zen", "https://opencode.ai/zen/go/v1"],
  ["github-copilot", "copilot", "https://api.individual.githubcopilot.com"],
] as const;

function quotaReport(provider: string, resetsAt = now / 1_000 + 150): UsageReport {
  const minimax = provider.startsWith("minimax");
  const copilot = provider === "github-copilot";
  return {
    providerId: provider,
    providerName: provider,
    capturedAt: now,
    source: "synthetic-quota",
    semantics: { kind: "consumer-subscription", label: "Plan quota" },
    buckets: [
      {
        id: copilot
          ? "premium-requests"
          : minimax
            ? "general:rolling"
            : provider === "opencode-go"
              ? "rolling"
              : "five-hour",
        label: "Rolling window",
        ...(minimax ? { groupId: "general" } : {}),
        unit: provider === "command-code" ? "usd" : "count",
        limit: copilot ? 300 : 100,
        remaining: copilot ? 245 : 80,
        used: copilot ? 55 : 20,
        windowMinutes: 300,
        resetsAt,
      },
    ],
    metrics: [],
  };
}

function staticStatus(provider: string, prefix: string): string {
  return provider === "github-copilot"
    ? "copilot 245/300 82%"
    : `${prefix} ${provider === "opencode-go" ? "r:20" : "5h:80"}%`;
}

function countdownStatus(provider: string, prefix: string, time: string): string {
  return provider === "github-copilot"
    ? `copilot 245/300 82% ↻ ${time}`
    : `${prefix} ${provider === "opencode-go" ? 20 : 80}% ↻ ${time}`;
}

for (const [provider, prefix] of providers) {
  test(`${provider} adds a countdown without changing quota semantics`, () => {
    const value = quotaReport(provider);
    const before = structuredClone(value);
    // Codex preferences do not control these providers.
    assert.equal(formatUsageStatusline(value, undefined, now, false, "used"), countdownStatus(provider, prefix, "3m"));
    assert.deepEqual(value, before);
    assert.equal(formatUsageStatusline(value, undefined, now + 60_000), countdownStatus(provider, prefix, "2m"));
  });

  for (const [name, reset] of [
    ["missing", undefined],
    ["invalid", NaN],
    ["infinite", Infinity],
    ["expired", now / 1_000 - 1],
    ["at reset", now / 1_000],
  ] as const) {
    test(`${provider} preserves static fallback for ${name} reset`, () => {
      const value = quotaReport(provider);
      const bucket = value.buckets[0];
      assert.ok(bucket);
      bucket.resetsAt = reset;
      assert.equal(formatUsageStatusline(value, undefined, now), staticStatus(provider, prefix));
    });
  }
}

test("Kimi preserves monthly labels and mixed countdown segments", () => {
  const value = quotaReport("kimi-coding", now / 1_000 + 172 * 60);
  const rolling = value.buckets[0];
  assert.ok(rolling);
  rolling.remaining = 77;
  value.buckets.push({
    id: "monthly",
    label: "Monthly",
    unit: "percent",
    remaining: 87,
    resetsAt: now / 1_000 + (29 * 24 + 20) * 3600,
  });
  assert.equal(formatUsageStatusline(value, undefined, now), "kimi 77% ↻ 2h52m · 87% ↻ 29d20h");
  value.buckets[1].resetsAt = undefined;
  assert.equal(formatUsageStatusline(value, undefined, now), "kimi 77% ↻ 2h52m · mo:87%");
  rolling.resetsAt = undefined;
  assert.equal(formatUsageStatusline(value, undefined, now), "kimi 5h:77% · mo:87%");
});

test("Command Code shows three countdowns in existing window order", () => {
  const value = quotaReport("command-code");
  value.buckets = (
    [
      ["five-hour", 100, 9000],
      ["weekly", 97, 6 * 86400],
      ["monthly", 98, 20 * 86400],
    ] as const
  ).map(([id, remaining, seconds]) => ({
    id,
    label: id,
    unit: "usd",
    limit: 100,
    remaining,
    resetsAt: now / 1000 + seconds,
  }));
  assert.equal(formatUsageStatusline(value, undefined, now), "cmd 100% ↻ 2h30m · 97% ↻ 6d · 98% ↻ 20d");
});

test("OpenCode Go preserves used percentage, mixed windows, and custom duration fallback", () => {
  const value = quotaReport("opencode-go", now / 1000 + 9000);
  value.buckets.push({ id: "weekly", label: "Weekly", unit: "percent", used: 10, resetsAt: now / 1000 + 6 * 86400 });
  assert.equal(formatUsageStatusline(value, undefined, now), "zen 20% ↻ 2h30m · 10% ↻ 6d");
  const kimi = quotaReport("kimi-coding", now / 1000);
  kimi.buckets[0].windowMinutes = 90;
  assert.equal(formatUsageStatusline(kimi, undefined, now), "kimi 90m:80%");
});

test("Copilot preserves AI credits, Free chat, overage, and unlimited output", () => {
  const value = quotaReport("github-copilot", now / 1000 + 6 * 86400);
  assert.equal(formatUsageStatusline(value, undefined, now), "copilot 245/300 82% ↻ 6d");
  value.metrics.push({ id: "overage-used", label: "Overage", value: 100 });
  value.buckets[0].id = "ai-credits";
  assert.equal(formatUsageStatusline(value, undefined, now), "copilot credits 245/300 82% +100 over ↻ 6d");
  value.buckets[0].id = "chat-requests";
  assert.equal(formatUsageStatusline(value, undefined, now), "copilot chat 245/300 82% +100 over ↻ 6d");
  value.buckets[0].limit = undefined;
  assert.equal(formatUsageStatusline(value, undefined, now), "copilot chat unlimited");
});

let directory: string;
let previousAgentDir: string | undefined;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  directory = await mkdtemp(join(tmpdir(), "usage-countdown-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(directory, { recursive: true, force: true });
});

async function setup(provider: (typeof providers)[number], value = quotaReport(provider[0])) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const timerSpy = vi.spyOn(globalThis, "setTimeout");
  vi.stubGlobal("fetch", () => {
    throw new Error("Countdown repaint must not use transport");
  });
  vi.resetModules();
  const { adapterForProvider } = await import("../src/query.js");
  const adapter = adapterForProvider(provider[0]);
  assert.ok(adapter);
  const query = vi.spyOn(adapter, "query").mockImplementation(async () => structuredClone(value));
  const { default: usageExtension } = await import("../src/usage.js");
  const state: UsageSettingsState = {
    kind: "loaded",
    path: join(directory, "pi-usage.json"),
    settings: {
      ...DEFAULT_USAGE_SETTINGS,
      codexFastMode: false,
      codexStatusResetCountdown: false,
      codexStatusPercentage: "remaining",
      selectedTargets: {},
    },
    document: {},
  };
  const settingsRuntime: UsageSettingsRuntime = {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async () => {
      throw new Error("No settings writes expected");
    },
    updateSelectedTarget: async () => {
      throw new Error("No selection writes expected");
    },
    flush: async () => undefined,
  };
  let key = "synthetic-account-a";
  const mock = createMockPi();
  usageExtension(mock.pi, {
    settingsRuntime,
    credentialReader: () => ({
      type: "oauth",
      access: key,
      refresh: "synthetic-github-refresh",
      expires: now + 3600000,
    }),
  });
  const model = { id: "test", name: "Test", provider: provider[0], baseUrl: provider[2] };
  const { ctx, statuses } = createMockContext({
    mode: "rpc",
    model,
    modelRegistry: {
      getProviderAuth: async () => ({ source: "ApiKey", auth: { apiKey: key } }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: key }),
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderAuthStatus: () => ({ configured: true }),
    },
  });
  stop = async () => {
    for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
  };
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await vi.advanceTimersByTimeAsync(0);
  return {
    mock,
    ctx,
    statuses,
    query,
    model,
    value,
    timerSpy,
    rotateKey: () => {
      key = "synthetic-account-b";
    },
  };
}

for (const provider of providers) {
  test(`${provider[0]} repaints locally and stops countdown repaint at expiry`, async () => {
    const { statuses, query } = await setup(provider);
    assert.equal(statuses.get("usage"), countdownStatus(provider[0], provider[1], "3m"));
    assert.equal(query.mock.calls.length, 1);
    assert.equal(vi.getTimerCount(), 2);
    await vi.advanceTimersByTimeAsync(60000);
    assert.equal(statuses.get("usage"), countdownStatus(provider[0], provider[1], "2m"));
    assert.equal(query.mock.calls.length, 1);
    await vi.advanceTimersByTimeAsync(120000);
    assert.equal(statuses.get("usage"), staticStatus(provider[0], provider[1]));
    assert.equal(query.mock.calls.length, 1);
    assert.equal(vi.getTimerCount(), 1, "Only the existing five-minute network refresh remains");
    await vi.advanceTimersByTimeAsync(120000);
    assert.equal(query.mock.calls.length, 2, "Scheduled provider refresh interval is unchanged");
  });
}

const hiddenCases = [
  ["Kimi unselected sub-window", providers[0], "daily"],
  ["MiniMax unmatched group", providers[1], "other:rolling"],
  ["Z.AI hidden MCP window", providers[3], "mcp"],
  ["Command Code duplicate non-USD bucket", providers[5], "five-hour"],
  ["OpenCode missing used percentage", providers[6], "weekly"],
  ["Copilot unrelated bucket", providers[7], "unrelated"],
] as const;

for (const [name, provider, id] of hiddenCases) {
  test(`${name} cannot activate repaint`, async () => {
    const value = quotaReport(provider[0], now / 1000);
    const hidden = { ...value.buckets[0], id, label: "Hidden", unit: "percent" as const, resetsAt: now / 1000 + 86400 };
    if (provider[0] === "minimax") hidden.groupId = "other";
    if (provider[0] === "opencode-go") hidden.used = undefined;
    value.buckets.push(hidden);
    const output = formatUsageStatuslineWithCountdown(value, undefined, now);
    assert.equal(output.hasCountdown, false);
    assert.equal(output.value, staticStatus(provider[0], provider[1]));
    const { query, statuses } = await setup(provider, value);
    assert.equal(statuses.get("usage"), output.value);
    assert.equal(vi.getTimerCount(), 1);
    await vi.advanceTimersByTimeAsync(60000);
    assert.equal(query.mock.calls.length, 1);
    assert.equal(vi.getTimerCount(), 1);
  });
}

test("MiniMax selected model groups share formatter and repaint selection", () => {
  const value = quotaReport("minimax");
  value.buckets.push({
    ...value.buckets[0],
    id: "other:rolling",
    groupId: "other",
    groupLabel: "Other",
    modelKeys: ["other"],
    remaining: 60,
    resetsAt: undefined,
  });
  const model = { provider: "minimax", id: "other", name: "Other" };
  assert.deepEqual(formatUsageStatuslineWithCountdown(value, model, now), {
    value: "minimax 5h:60%",
    hasCountdown: false,
  });
  assert.equal(
    formatUsageStatuslineWithCountdown(value, { ...model, id: "test", name: "Test" }, now).hasCountdown,
    true,
  );
});

for (const provider of providers) {
  test(`${provider[0]} missing quota values do not schedule countdown repaint`, async () => {
    const value = quotaReport(provider[0]);
    for (const bucket of value.buckets) {
      bucket.remaining = undefined;
      bucket.used = undefined;
    }
    assert.equal(formatUsageStatuslineWithCountdown(value, undefined, now).hasCountdown, false);
    await setup(provider, value);
    assert.equal(vi.getTimerCount(), 1);
  });
}

for (const provider of [providers[1], providers[2], providers[7]]) {
  test(`${provider[0]} unlimited quota ignores future resets`, async () => {
    const value = quotaReport(provider[0]);
    const bucket = value.buckets[0];
    assert.ok(bucket);
    if (provider[0] === "github-copilot") bucket.limit = undefined;
    else bucket.period = "unlimited";
    assert.equal(formatUsageStatuslineWithCountdown(value, undefined, now).hasCountdown, false);
    const { statuses } = await setup(provider, value);
    assert.equal(
      statuses.get("usage"),
      `${provider[1]} ${provider[0] === "github-copilot" ? "premium unlimited" : "5h:unlimited"}`,
    );
    assert.equal(vi.getTimerCount(), 1);
  });
}

for (const provider of [providers[0], providers[1], providers[2]]) {
  test(`${provider[0]} percent quotas retain rounding and do not require count limits`, () => {
    const value = quotaReport(provider[0]);
    const bucket = value.buckets[0];
    assert.ok(bucket);
    bucket.unit = "percent";
    bucket.limit = 0;
    bucket.remaining = 38.5;
    assert.deepEqual(formatUsageStatuslineWithCountdown(value, undefined, now), {
      value: `${provider[1]} ${provider[0] === "kimi-coding" ? "39" : "38.5"}% ↻ 3m`,
      hasCountdown: true,
    });
  });
}

for (const [name, provider, unit, limit] of [
  ["Command Code missing limit", providers[5], "usd", undefined],
  ["Command Code non-USD window", providers[5], "percent", 100],
  ["Z.AI zero limit", providers[3], "count", 0],
] as const) {
  test(`${name} cannot activate countdown`, () => {
    const value = quotaReport(provider[0]);
    const bucket = value.buckets[0];
    assert.ok(bucket);
    bucket.unit = unit;
    bucket.limit = limit;
    assert.deepEqual(formatUsageStatuslineWithCountdown(value, undefined, now), {
      value: undefined,
      hasCountdown: false,
    });
  });
}

test("MiniMax pay-as-you-go ignores unrelated future-reset buckets", () => {
  const value = quotaReport("minimax");
  value.source = "minimax-account-balance";
  value.metrics = [{ id: "available-balance", label: "Balance", value: "10.00001", currency: "USD" }];
  assert.deepEqual(formatUsageStatuslineWithCountdown(value, undefined, now), {
    value: "minimax USD 10.00001",
    hasCountdown: false,
  });
});

test("Nonfinite current time and overflowing timestamps cannot activate countdown", () => {
  const value = quotaReport("kimi-coding", Number.MAX_VALUE);
  assert.equal(formatUsageStatuslineWithCountdown(value, undefined, now).hasCountdown, false);
  assert.equal(formatUsageStatusline(value, undefined, now), "kimi 5h:80%");
  assert.equal(formatUsageStatuslineWithCountdown(quotaReport("kimi-coding"), undefined, NaN).hasCountdown, false);
});

test("Mixed countdown windows stop independently and preserve remaining static segments", async () => {
  const value = quotaReport("kimi-coding", now / 1000 + 60);
  value.buckets.push({
    id: "weekly",
    label: "Weekly",
    unit: "percent",
    remaining: 90,
    windowMinutes: 10080,
    resetsAt: now / 1000 + 150,
  });
  const { statuses, query } = await setup(providers[0], value);
  assert.equal(statuses.get("usage"), "kimi 80% ↻ 1m · 90% ↻ 3m");
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(statuses.get("usage"), "kimi 5h:80% · 90% ↻ 2m");
  assert.equal(vi.getTimerCount(), 2);
  await vi.advanceTimersByTimeAsync(120000);
  assert.equal(statuses.get("usage"), "kimi 5h:80% · wk:90%");
  assert.equal(vi.getTimerCount(), 1);
  assert.equal(query.mock.calls.length, 1);
});

test("Countdown is cleared on model change, session replacement, and shutdown", async () => {
  const { mock, ctx, statuses, query, model } = await setup(providers[0]);
  Object.assign(ctx, { model: undefined });
  mock.events.get("model_select")?.[0]?.({ model: undefined }, ctx);
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(statuses.get("usage"), undefined);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(query.mock.calls.length, 1);
  Object.assign(ctx, { model });
  mock.events.get("model_select")?.[0]?.({ model }, ctx);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(statuses.get("usage"), "kimi 80% ↻ 2m");
  Object.assign(ctx, { model: undefined });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(statuses.get("usage"), undefined);
  assert.equal(vi.getTimerCount(), 0);
  Object.assign(ctx, { model });
  mock.events.get("model_select")?.[0]?.({ model }, ctx);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(statuses.get("usage"), "kimi 80% ↻ 1m");
  const beforeShutdown = query.mock.calls.length;
  await stop?.();
  await vi.advanceTimersByTimeAsync(300000);
  assert.equal(statuses.get("usage"), undefined);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(query.mock.calls.length, beforeShutdown);
});

test("Account rotation revalidates before publishing a new countdown", async () => {
  const { mock, ctx, statuses, query, value, rotateKey } = await setup(providers[0]);
  rotateKey();
  value.buckets[0].remaining = 50;
  mock.events.get("turn_start")?.[0]?.({}, ctx);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(query.mock.calls.length, 2);
  assert.equal(statuses.get("usage"), "kimi 50% ↻ 3m");
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(statuses.get("usage"), "kimi 50% ↻ 2m");
  assert.equal(query.mock.calls.length, 2);
});

test("Queued stale countdown callback cannot detach the new owner's timer", async () => {
  const { mock, ctx, statuses, timerSpy, rotateKey } = await setup(providers[0]);
  const callback = timerSpy.mock.calls.find((call) => call[1] === 60000)?.[0];
  assert.ok(typeof callback === "function");
  rotateKey();
  mock.events.get("turn_start")?.[0]?.({}, ctx);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(vi.getTimerCount(), 2);
  callback();
  assert.equal(statuses.get("usage"), "kimi 80% ↻ 3m");
  await stop?.();
  assert.equal(vi.getTimerCount(), 0, "Shutdown must retain ownership of the new countdown timer");
});

test("Stale countdown callback cannot publish or reschedule", async () => {
  const { ctx, statuses, query } = await setup(providers[0]);
  const error = new Error("This extension ctx is stale after session replacement or reload.");
  let uiReads = 0;
  Object.defineProperty(ctx, "ui", {
    configurable: true,
    get() {
      uiReads++;
      throw error;
    },
  });
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(uiReads, 1);
  assert.equal(statuses.get("usage"), "kimi 80% ↻ 3m");
  assert.equal(vi.getTimerCount(), 1);
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(uiReads, 1);
  assert.equal(query.mock.calls.length, 1);
  Object.defineProperty(ctx, "ui", { configurable: true, value: { setStatus: () => undefined } });
});
