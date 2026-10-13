import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { formatUsageStatusline, formatUsageStatuslineWithCountdown } from "../src/format.js";
import { createUsageSettingsRuntime, loadUsageSettings, normalizeUsageSettings } from "../src/settings.js";
import type { UsageReport } from "../src/types.js";

const now = 1_000_000;
const defaults = {
  template: "{provider} {windows}",
  window: "{window}:{value}",
  countdown: "{value} ↻ {reset}",
  separator: " · ",
};
function report(providerId = "openai-codex"): UsageReport {
  const minimax = providerId.startsWith("minimax");
  const zen = providerId === "opencode-go";
  return {
    providerId,
    providerName: providerId,
    capturedAt: now,
    source: "synthetic-quota",
    semantics: { kind: "consumer-subscription", label: "Plan" },
    metrics: [],
    buckets: [
      {
        id: zen
          ? "rolling"
          : minimax
            ? "general:rolling"
            : providerId === "openai-codex"
              ? "codex:primary"
              : "five-hour",
        groupId: minimax ? "general" : "codex",
        label: "Rolling",
        unit: providerId === "command-code" ? "usd" : "percent",
        remaining: 89,
        used: 11,
        limit: 100,
        windowMinutes: 300,
        resetsAt: now / 1000 + 9000,
      },
      {
        id: minimax ? "general:weekly" : providerId === "openai-codex" ? "codex:secondary" : "weekly",
        groupId: minimax ? "general" : "codex",
        label: "Weekly",
        unit: providerId === "command-code" ? "usd" : "percent",
        remaining: 97,
        used: 3,
        limit: 100,
        windowMinutes: 10080,
      },
    ],
  };
}

test("display settings merge partial overrides with exact defaults", () => {
  assert.deepEqual(normalizeUsageSettings({})?.statuslineDisplay, defaults);
  assert.deepEqual(normalizeUsageSettings({ statuslineDisplay: { separator: " / " } })?.statuslineDisplay, {
    ...defaults,
    separator: " / ",
  });
});

for (const [provider, prefix] of [
  ["openai-codex", "codex"],
  ["command-code", "cmd"],
  ["kimi-coding", "kimi"],
  ["minimax", "minimax"],
  ["minimax-cn", "minimax cn"],
  ["zai", "zai"],
  ["zai-coding-cn", "zai"],
  ["opencode-go", "zen"],
]) {
  test(`${provider} supports custom mixed windows and reordered provider`, () => {
    const value = report(provider);
    const before = structuredClone(value);
    const display = {
      template: "[{windows}] {provider}",
      countdown: "{window}:{value} ↻ {reset}",
      window: "{value} ({window})",
      separator: " / ",
    };
    const expected =
      provider === "opencode-go" ? `[r:11% ↻ 2h30m / 3% (w)] ${prefix}` : `[5h:89% ↻ 2h30m / 97% (wk)] ${prefix}`;
    assert.deepEqual(formatUsageStatuslineWithCountdown(value, undefined, now, true, "remaining", display), {
      value: expected,
      hasCountdown: provider !== "openai-codex",
    });
    assert.deepEqual(value, before);
    value.buckets[0].remaining = undefined;
    value.buckets[0].used = undefined;
    assert.equal(
      formatUsageStatusline(value, undefined, now, true, "remaining", display),
      provider === "opencode-go" ? `[3% (w)] ${prefix}` : `[97% (wk)] ${prefix}`,
    );
  });
}

test("explicit defaults preserve current output for every scoped provider", () => {
  for (const provider of [
    "openai-codex",
    "command-code",
    "kimi-coding",
    "minimax",
    "minimax-cn",
    "zai",
    "zai-coding-cn",
    "opencode-go",
  ]) {
    const value = report(provider);
    for (const reset of [undefined, NaN, Infinity, now / 1000 - 1, now / 1000 + 9000]) {
      value.buckets[0].resetsAt = reset;
      for (const countdown of [true, false]) {
        assert.equal(
          formatUsageStatusline(value, undefined, now, countdown, "remaining", defaults),
          formatUsageStatusline(value, undefined, now, countdown),
        );
      }
    }
  }
});

test("custom templates leave companion, Copilot, balances, and missing-quota fallback unchanged", () => {
  const display = {
    template: "custom {windows} {provider}",
    window: "[{value}]",
    countdown: "[{reset}]",
    separator: " / ",
  };
  const values = [
    report("github-copilot"),
    report("deepseek"),
    report("openrouter"),
    report("minimax-cn"),
    report("openai"),
  ];
  values[3].source = "minimax-account-balance";
  values[3].metrics = [{ id: "available-balance", label: "Balance", currency: "CNY", value: 23 }];
  values[4].source = "openai-chatgpt-companion";
  for (const bucket of values[4].buckets) bucket.groupId = "chatgpt-plan";
  for (const value of values)
    assert.equal(
      formatUsageStatusline(value, undefined, now, true, "remaining", display),
      formatUsageStatusline(value, undefined, now),
    );
  const missing = report();
  missing.buckets = [];
  assert.equal(formatUsageStatusline(missing, undefined, now, true, "remaining", display), "codex usage unavailable");
  missing.providerId = "kimi-coding";
  assert.equal(formatUsageStatusline(missing, undefined, now, true, "remaining", display), undefined);
});

test("empty templates and separator are literal choices, not missing settings", () => {
  assert.equal(formatUsageStatusline(report(), undefined, now, false, "remaining", { template: "" }), "");
  assert.equal(
    formatUsageStatusline(report(), undefined, now, false, "remaining", { window: "{value}", separator: "" }),
    "codex 89%97%",
  );
});

test("untrusted provider qualifiers cannot inject controls or expand replacement placeholders", () => {
  const value = report();
  for (const bucket of value.buckets) {
    bucket.groupId = "other";
    bucket.groupLabel = "Codex \u001b[31m{windows}\u001b[0m\u0007";
  }
  assert.equal(
    formatUsageStatusline(value, undefined, now, false, "remaining", { template: "[{windows}] {provider}" }),
    "[5h:89% · wk:97%] codex {windows}",
  );
});

test("Codex preserves percentage and expired countdown policy with custom templates", () => {
  const value = report();
  value.buckets[0].resetsAt = now / 1000 - 1;
  const display = { countdown: "{window} {value} {reset}", window: "{window} {value}" };
  assert.equal(formatUsageStatusline(value, undefined, now, true, "used", display), "codex 5h 11% 0m · wk 3%");
  assert.equal(formatUsageStatusline(value, undefined, now, false, "used", display), "codex 5h 11% · wk 3%");
});

test("unlimited windows use static templates even with a future reset", () => {
  const value = report("minimax-cn");
  value.buckets[0].period = "unlimited";
  value.buckets.splice(1);
  assert.equal(
    formatUsageStatusline(value, undefined, now, true, "remaining", { window: "{value} ({window})" }),
    "minimax cn unlimited (5h)",
  );
});

test("literal spacing, braces in separators, and replacement text are not reinterpreted", () => {
  assert.equal(
    formatUsageStatusline(report(), undefined, now, false, "remaining", {
      template: "  {windows}  {provider}  ",
      window: "{value}",
      separator: "{value}",
    }),
    "  89%{value}97%  codex  ",
  );
});

for (const [name, display] of [
  ["null", null],
  ["array", []],
  ["wrong template type", { template: 1 }],
  ["wrong window type", { window: false }],
  ["wrong countdown type", { countdown: [] }],
  ["wrong separator type", { separator: {} }],
  ["unknown placeholder", { window: "{unknown}" }],
  ["wrong outer placeholder", { template: "{value}" }],
  ["wrong static placeholder", { window: "{reset}" }],
  ["wrong countdown placeholder", { countdown: "{provider}" }],
  ["unclosed brace", { template: "{provider" }],
  ["unopened brace", { window: "value}" }],
  ["nested braces", { countdown: "{{value}}" }],
  ["expression", { window: "{value + 1}" }],
  ["ANSI", { template: "\u001b[31m{provider}" }],
  ["OSC", { separator: "\u001b]52;c;payload\u0007" }],
  ["C1", { window: "\u009b31m{value}" }],
  ["newline", { countdown: "{value}\n{reset}" }],
  ["tab", { separator: "\t" }],
  ["line separator", { template: "{provider}\u2028{windows}" }],
] as const) {
  test(`invalid display ${name} is observable and cannot overwrite the file`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "usage-display-"));
    try {
      const path = join(directory, "pi-usage.json");
      const text = JSON.stringify({ statuslineDisplay: display });
      await writeFile(path, text);
      const state = await loadUsageSettings(path);
      assert.equal(state.kind, "invalid");
      assert.match(state.issue ?? "", /statuslineDisplay/);
      const runtime = createUsageSettingsRuntime(path);
      await runtime.reload();
      await assert.rejects(runtime.update({ codexFastMode: true }), /Cannot overwrite an invalid/);
      assert.equal(await readFile(path, "utf8"), text);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("an invalid template save retains the prior file and effective settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-display-"));
  try {
    const path = join(directory, "pi-usage.json");
    const text = JSON.stringify({ statuslineDisplay: { separator: " / " } });
    await writeFile(path, text);
    const runtime = createUsageSettingsRuntime(path);
    const previous = await runtime.reload();
    await assert.rejects(
      runtime.update({ statuslineDisplay: { ...defaults, window: "{reset}" } }),
      /invalid pi-usage settings/,
    );
    assert.deepEqual(runtime.get(), previous);
    assert.equal(await readFile(path, "utf8"), text);
    await runtime.update({ codexFastMode: true });
    assert.equal(runtime.get().settings.statuslineDisplay.separator, " / ");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordinary saves retain partial display configuration and unknown nested fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-display-"));
  try {
    const path = join(directory, "pi-usage.json");
    const statuslineDisplay = { separator: " / ", future: "kept" };
    await writeFile(path, JSON.stringify({ statuslineDisplay, future: true }));
    const runtime = createUsageSettingsRuntime(path);
    await runtime.update({ codexFastMode: true });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      statuslineDisplay,
      future: true,
      codexFastMode: true,
    });
    assert.deepEqual(runtime.get().settings.statuslineDisplay, { ...defaults, separator: " / " });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
