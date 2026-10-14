import assert from "node:assert/strict";
import { test } from "vitest";
import { formatUsageStatusline } from "../src/format.js";
import type { UsageBucket, UsageReport } from "../src/types.js";

const now = 1_000_000;
const primaryReset = now / 1_000 + 9_000;
const weeklyReset = now / 1_000 + 493_200;

function report(providerId: string, buckets: UsageBucket[]): UsageReport {
  return {
    providerId,
    providerName: providerId,
    capturedAt: now,
    source: "synthetic-statusline",
    semantics: { kind: "consumer-subscription", label: "Plan windows" },
    buckets,
    metrics: [],
  };
}

function codex(primary: number | undefined, secondary: number | undefined): UsageReport {
  return report("openai-codex", [
    { id: "codex:primary", groupId: "codex", label: "5h", unit: "percent", remaining: 89, resetsAt: primary },
    { id: "codex:secondary", groupId: "codex", label: "Weekly", unit: "percent", remaining: 97, resetsAt: secondary },
  ]);
}

for (const [name, primary, secondary, countdown, expected] of [
  ["both countdowns", primaryReset, weeklyReset, true, "codex 89% ↻ 2h30m · 97% ↻ 5d17h"],
  ["primary countdown only", primaryReset, undefined, true, "codex 89% ↻ 2h30m · wk:97%"],
  ["weekly countdown only", undefined, weeklyReset, true, "codex 5h:89% · 97% ↻ 5d17h"],
  ["neither countdown", undefined, undefined, true, "codex 5h:89% · wk:97%"],
  ["countdowns disabled", primaryReset, weeklyReset, false, "codex 5h:89% · wk:97%"],
  ["invalid reset times", NaN, Infinity, true, "codex 5h:89% · wk:97%"],
] as const) {
  test(`Codex statusline separates windows with ${name}`, () => {
    const value = codex(primary, secondary);
    const before = structuredClone(value);
    assert.equal(formatUsageStatusline(value, undefined, now, countdown), expected);
    assert.deepEqual(value, before);
  });
}

test("Codex single and missing windows have no stray separator", () => {
  const value = codex(undefined, weeklyReset);
  const [primary, secondary] = value.buckets;
  assert.ok(primary && secondary);
  primary.remaining = undefined;
  assert.equal(formatUsageStatusline(value, undefined, now), "codex 97% ↻ 5d17h");
  assert.equal(formatUsageStatusline(value, undefined, now, false), "codex wk:97%");
  secondary.remaining = undefined;
  assert.equal(formatUsageStatusline(value, undefined, now), "codex usage unavailable");
});

test("Codex preserves used percentage, custom durations, and expired countdowns", () => {
  const value = codex(now / 1_000 - 60, undefined);
  const secondary = value.buckets[1];
  assert.ok(secondary);
  secondary.windowMinutes = 90;
  assert.equal(formatUsageStatusline(value, undefined, now, true, "used"), "codex 11% ↻ 0m · 90m:3%");
  assert.equal(formatUsageStatusline(value, undefined, now, false, "used"), "codex 5h:11% · 90m:3%");
});

for (const provider of [
  "command-code",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "zai",
  "zai-coding-cn",
  "opencode-go",
]) {
  test(`${provider} renders ordered label-first window segments`, () => {
    const minimax = provider.startsWith("minimax");
    const zen = provider === "opencode-go";
    const buckets: UsageBucket[] = [
      {
        id: zen ? "rolling" : minimax ? "general:rolling" : "five-hour",
        label: "Rolling",
        unit: provider === "command-code" ? "usd" : "count",
        used: 20,
        remaining: 80,
        limit: 100,
        windowMinutes: 300,
      },
      {
        id: zen ? "weekly" : minimax ? "general:weekly" : "weekly",
        label: "Weekly",
        unit: provider === "command-code" ? "usd" : "count",
        used: 10,
        remaining: 90,
        limit: 100,
        windowMinutes: 10080,
      },
    ];
    if (minimax) for (const bucket of buckets) bucket.groupId = "general";
    const prefix =
      provider === "command-code"
        ? "cmd"
        : provider === "kimi-coding"
          ? "kimi"
          : minimax
            ? provider === "minimax-cn"
              ? "minimax cn"
              : "minimax"
            : zen
              ? "zen"
              : "zai";
    const expected = zen ? "zen r:20% · w:10%" : `${prefix} 5h:80% · wk:90%`;
    const value = report(provider, buckets);
    assert.equal(formatUsageStatusline(value), expected);
    const [primary, secondary] = value.buckets;
    assert.ok(primary && secondary);
    primary.used = undefined;
    primary.remaining = undefined;
    assert.equal(formatUsageStatusline(value), zen ? "zen w:10%" : `${prefix} wk:90%`);
    secondary.used = undefined;
    secondary.remaining = undefined;
    assert.equal(formatUsageStatusline(value), undefined);
  });
}

test("Command Code uses the accepted three-window format", () => {
  const value = report(
    "command-code",
    (
      [
        ["five-hour", 100],
        ["weekly", 97],
        ["monthly", 98],
      ] as const
    ).map(([id, remaining]) => ({
      id,
      label: "Window",
      unit: "usd",
      remaining,
      limit: 100,
    })),
  );
  assert.equal(formatUsageStatusline(value), "cmd 5h:100% · wk:97% · mo:98%");
});

test("MiniMax unlimited windows retain their labels and regional prefix", () => {
  const value = report(
    "minimax-cn",
    ["rolling", "weekly"].map((id) => ({
      id: `general:${id}`,
      groupId: "general",
      label: id,
      unit: "count",
      period: "unlimited",
    })),
  );
  assert.equal(formatUsageStatusline(value), "minimax cn 5h:unlimited · wk:unlimited");
});

test("ChatGPT companion formatting remains unchanged", () => {
  const value = codex(primaryReset, weeklyReset);
  value.providerId = "openai";
  value.source = "openai-chatgpt-companion";
  for (const bucket of value.buckets) bucket.groupId = "chatgpt-plan";
  assert.equal(formatUsageStatusline(value, undefined, now), "chatgpt plan 89% ↻ 2h30m 97% ↻ 5d17h");
});
