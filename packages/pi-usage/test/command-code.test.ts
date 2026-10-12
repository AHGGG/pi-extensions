import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  adapterForProvider,
  commandCodeOrgId,
  formatUsageReport,
  formatUsageStatusline,
  normalizeCommandCodeUsagePayload,
  queryProviderUsage,
  type ResolvedUsageAuth,
  resolveUsageAuth,
} from "../src/index.js";
import usageExtension from "../src/usage.js";

// Keep adapter assertions focused on static fallback after every fixture reset has expired.
const STATIC_STATUS_NOW = Date.parse("2031-01-01T00:00:00Z");

const TEST_AUTH: ResolvedUsageAuth = {
  headers: { Authorization: "Bearer test-key" },
  fingerprint: "test",
  secrets: ["test-key"],
  model: {
    id: "test",
    name: "Test",
    provider: "command-code",
    baseUrl: "https://api.commandcode.ai/provider",
    api: "anthropic-messages",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  },
};

const ACCOUNT = {
  success: true,
  user: {
    id: "8c9d210f-0000-0000-0000-000da6d7fdec",
    name: "yanjieee",
    email: "yanjieee@example.test",
    userName: "yanjieee",
  },
  org: null,
};

const CREDITS = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 67.3314357964,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.08658048, cap: 14, exceeded: false, resetAt: 1_790_666_524_172 },
    weekly: { used: 2.6685642036, cap: 35, exceeded: false, resetAt: 1_790_663_250_022 },
  },
  sandboxAccess: false,
  sandboxMinutes: null,
};

const SUBSCRIPTION = {
  success: true,
  data: {
    id: "sub_1UIN1JDSZgxV3MJKFicsVwdg",
    status: "active",
    planId: "individual-goat",
    currentPeriodStart: "2026-09-22T06:17:06.000Z",
    currentPeriodEnd: "2026-10-22T06:17:06.000Z",
  },
};

const USAGE = {
  totalCount: 1245,
  totalCost: 2.6721871936000006,
  totalTokensIn: 109_291_728,
  totalTokensOut: 883_023,
  totalTokens: 110_174_751,
  periodBasis: "billing-period",
};

const PERIOD_END_SECONDS = Math.floor(Date.parse("2026-10-22T06:17:06.000Z") / 1000);

test("Command Code adapter normalizes rolling USD windows, plan credits, and period totals", () => {
  const report = normalizeCommandCodeUsagePayload(
    { account: ACCOUNT, credits: CREDITS, subscription: SUBSCRIPTION, usage: USAGE },
    500,
  );

  assert.equal(report.providerId, "command-code");
  assert.equal(report.providerName, "Command Code");
  assert.equal(report.accountLabel, "yanjieee");
  assert.equal(report.semantics.kind, "consumer-subscription");
  assert.deepEqual(
    report.buckets.map((bucket) => bucket.id),
    ["five-hour", "weekly", "monthly"],
  );

  const fiveHour = report.buckets[0];
  assert.equal(fiveHour?.unit, "usd");
  assert.equal(fiveHour?.windowMinutes, 300);
  assert.equal(fiveHour?.used, 0.08658048);
  assert.equal(fiveHour?.limit, 14);
  assert.equal(fiveHour?.remaining, 14 - 0.08658048);
  // Command Code reports `resetAt` in milliseconds; buckets keep epoch seconds.
  assert.equal(fiveHour?.resetsAt, 1_790_666_524);

  const weekly = report.buckets[1];
  assert.equal(weekly?.windowMinutes, 10_080);
  assert.equal(weekly?.resetsAt, 1_790_663_250);

  const monthly = report.buckets[2];
  assert.equal(monthly?.used, USAGE.totalCost);
  assert.equal(monthly?.remaining, CREDITS.credits.monthlyCredits);
  assert.equal(monthly?.limit, USAGE.totalCost + CREDITS.credits.monthlyCredits);
  assert.equal(monthly?.period, "billing-period");
  assert.equal(monthly?.resetsAt, PERIOD_END_SECONDS);

  assert.deepEqual(
    report.metrics.map((metric) => [metric.id, metric.value]),
    [
      ["plan", "GOAT (active)"],
      ["requests", 1245],
      ["tokens", 110_174_751],
    ],
  );
  assert.equal(report.notes, undefined);

  assert.equal(formatUsageStatusline(report, undefined, STATIC_STATUS_NOW), "cmd 5h:99% · wk:92% · mo:96%");
  const text = formatUsageReport(report, "current");
  assert.match(text, /Command Code Usage · Current/);
  assert.match(text, /Semantics: Command Code plan credits and rolling limits/);
  assert.match(text, /Five-hour window:\s+\$0\.09 of \$14\.00 used · 99% left/);
  assert.match(text, /Weekly window:\s+\$2\.67 of \$35\.00 used · 92% left/);
  assert.match(text, /Monthly credits:\s+\$2\.67 of \$70\.00 used · 96% left/);
  assert.match(text, /Plan:\s+GOAT \(active\)/);
  assert.match(text, /Tokens this period:\s+110174751/);
});

test("Command Code adapter degrades to plan and rolling windows when period usage is unavailable", () => {
  const report = normalizeCommandCodeUsagePayload(
    { account: ACCOUNT, credits: CREDITS, subscription: SUBSCRIPTION },
    600,
  );

  assert.deepEqual(
    report.buckets.map((bucket) => bucket.id),
    ["five-hour", "weekly"],
  );
  const metricIds = report.metrics.map((metric) => metric.id);
  assert.deepEqual(metricIds, ["plan", "monthly-credits"]);
  assert.equal(report.metrics[1]?.value, CREDITS.credits.monthlyCredits);
  assert.match(report.notes?.join(" ") ?? "", /billing-period usage was unavailable/);
  assert.equal(formatUsageStatusline(report, undefined, STATIC_STATUS_NOW), "cmd 5h:99% · wk:92%");
});

test("Command Code adapter reports unavailable sections and disabled rolling limits", () => {
  const report = normalizeCommandCodeUsagePayload(
    { account: ACCOUNT, credits: { ...CREDITS, windowLimits: { limited: false, fiveHour: null, weekly: null } } },
    700,
  );

  assert.equal(report.buckets.length, 0);
  assert.equal(formatUsageStatusline(report, undefined, STATIC_STATUS_NOW), undefined);
  assert.deepEqual(
    report.metrics.map((metric) => metric.id),
    ["monthly-credits"],
  );
  assert.match(report.notes?.join(" ") ?? "", /not enabled for this plan/);
  assert.match(report.notes?.join(" ") ?? "", /plan details were unavailable/);
  assert.match(report.notes?.join(" ") ?? "", /billing-period usage was unavailable/);
});

test("Command Code adapter keeps purchased, free, and input/output token metrics", () => {
  const report = normalizeCommandCodeUsagePayload(
    {
      account: ACCOUNT,
      credits: { credits: { monthlyCredits: 10, purchasedCredits: 5, freeCredits: 1 } },
      usage: { totalCost: 4, totalCount: 3, totalTokensIn: 20, totalTokensOut: 5 },
    },
    800,
  );

  const values = new Map(report.metrics.map((metric) => [metric.id, metric.value]));
  assert.equal(values.get("purchased-credits"), 5);
  assert.equal(values.get("free-credits"), 1);
  assert.equal(values.get("tokens-in"), 20);
  assert.equal(values.get("tokens-out"), 5);
  assert.equal(values.get("tokens"), undefined);
  const monthly = report.buckets.find((bucket) => bucket.id === "monthly");
  assert.equal(monthly?.limit, 20);
  assert.equal(monthly?.remaining, 16);
});

test("Command Code adapter treats second-valued reset timestamps as already seconds", () => {
  const report = normalizeCommandCodeUsagePayload(
    {
      account: ACCOUNT,
      credits: {
        credits: { monthlyCredits: 1, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: { limited: true, fiveHour: { used: 1, cap: 2, resetAt: 1_790_666_524 } },
      },
    },
    900,
  );

  assert.equal(report.buckets[0]?.resetsAt, 1_790_666_524);
});

test("Command Code adapter rejects responses without a safe account or displayable data", () => {
  assert.throws(() => normalizeCommandCodeUsagePayload({ account: { user: { userName: "   " } } }, 0), /account name/);
  assert.throws(
    () => normalizeCommandCodeUsagePayload({ account: ACCOUNT, credits: { credits: "nope" } }, 0),
    /no displayable usage data/,
  );
});

test("Command Code organisation ids are optional and bounded", () => {
  assert.equal(commandCodeOrgId(ACCOUNT), undefined);
  assert.equal(commandCodeOrgId({ org: { id: "org_abc-123" } }), "org_abc-123");
  assert.equal(commandCodeOrgId({ org: { id: "bad id" } }), undefined);
  assert.equal(commandCodeOrgId({ org: { id: "x".repeat(200) } }), undefined);
});

test("Command Code usage resolves stored Bearer auth and queries the alpha endpoints in order", async () => {
  const adapter = adapterForProvider("command-code");
  assert.ok(adapter);
  assert.equal(adapter.id, "command-code");
  const model = {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "command-code",
    baseUrl: "https://api.commandcode.ai/provider",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "runtime-key" }),
      getProviderAuth: async () => ({ auth: { apiKey: "stored-key", baseUrl: model.baseUrl } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes("/alpha/whoami")
      ? ACCOUNT
      : url.includes("/alpha/billing/credits")
        ? CREDITS
        : url.includes("/alpha/billing/subscriptions")
          ? SUBSCRIPTION
          : url.includes("/alpha/usage/summary")
            ? USAGE
            : undefined;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("not found", { status: 404 });
  });
  try {
    const auth = await resolveUsageAuth(ctx, adapter);
    assert.ok(auth);
    const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 2_000, async () => undefined);

    assert.deepEqual(
      fetchMock.mock.calls.map((call) => String(call[0])),
      [
        "https://api.commandcode.ai/alpha/whoami",
        "https://api.commandcode.ai/alpha/billing/credits",
        "https://api.commandcode.ai/alpha/billing/subscriptions",
        `https://api.commandcode.ai/alpha/usage/summary?since=${encodeURIComponent(SUBSCRIPTION.data.currentPeriodStart)}`,
      ],
    );
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer runtime-key");
    }
    assert.equal(report.providerId, "command-code");
    assert.equal(report.buckets.length, 3);
  } finally {
    fetchMock.mockRestore();
  }
});

for (const endpoint of ["credits", "subscriptions", "summary"] as const) {
  test(`Command Code preserves available sections when optional ${endpoint} exhausts the deadline`, async () => {
    vi.useFakeTimers();
    const adapter = adapterForProvider("command-code");
    assert.ok(adapter);
    const seen: string[] = [];
    const signals: AbortSignal[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (url.split("?")[0]?.endsWith(`/${endpoint}`)) {
        const signal = init?.signal;
        assert.ok(signal);
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })), {
            once: true,
          });
        });
      }
      const body = url.includes("/whoami")
        ? ACCOUNT
        : url.includes("/credits")
          ? CREDITS
          : url.includes("/subscriptions")
            ? SUBSCRIPTION
            : USAGE;
      return new Response(JSON.stringify(body));
    });
    const result = queryProviderUsage(adapter, TEST_AUTH, new AbortController().signal, 1_000, async () => undefined);
    // Attach rejection handling before advancing the request deadline.
    const settled = result.then(
      (report) => ({ report }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(1_001);
    const outcome = await settled;
    assert.ok("report" in outcome, "An optional timeout must not discard successful sections");
    const report = outcome.report;
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(vi.getTimerCount(), 0);
    if (endpoint === "credits") {
      assert.equal(report.metrics.find((metric) => metric.id === "plan")?.value, "GOAT (active)");
      assert.match(report.notes?.join(" ") ?? "", /credits were unavailable/);
    } else {
      assert.equal(report.buckets.find((bucket) => bucket.id === "five-hour")?.limit, 14);
      assert.equal(formatUsageStatusline(report, undefined, STATIC_STATUS_NOW), "cmd 5h:99% · wk:92%");
    }
    assert.match(report.notes?.join(" ") ?? "", /billing-period usage was unavailable/);
    assert.equal(
      seen.some((url) => url.includes("/usage/summary")),
      endpoint === "summary",
    );
    assert.equal(fetchMock.mock.calls.length, endpoint === "summary" ? 4 : 3);
  });
}

test("Command Code rejects cancellation racing the optional summary timeout", async () => {
  vi.useFakeTimers();
  const adapter = adapterForProvider("command-code");
  assert.ok(adapter);
  const controller = new AbortController();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/usage/summary")) {
      const signal = init?.signal;
      assert.ok(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            // Abort the caller in the same dispatch as the local transport deadline.
            controller.abort();
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
    }
    const body = url.includes("/whoami") ? ACCOUNT : url.includes("/credits") ? CREDITS : SUBSCRIPTION;
    return new Response(JSON.stringify(body));
  });
  const result = queryProviderUsage(adapter, TEST_AUTH, controller.signal, 1_000, async () => undefined);
  const settled = result.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(1_001);
  const error = await settled;
  assert.ok(error instanceof Error);
  assert.equal(error.name, "AbortError");
  assert.equal(controller.signal.aborted, true);
  assert.equal(vi.getTimerCount(), 0);
});

for (const [endpoint, guardState] of [
  ["credits", "stable"],
  ["subscriptions", "stable"],
  ["summary", "stable"],
  ["summary", "rotated"],
  ["summary", "shutdown"],
  ["summary", "too-slow"],
] as const) {
  test(`Command Code handles ${endpoint} timeout with ${guardState} asynchronous production guards`, async (t) => {
    vi.useFakeTimers();
    let timedOut = false;
    let postTimeoutAuthReads = 0;
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (url.split("?")[0]?.endsWith(`/${endpoint}`)) {
        const signal = init?.signal;
        assert.ok(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              timedOut = true;
              reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            },
            { once: true },
          );
        });
      }
      const body = url.includes("/whoami") ? ACCOUNT : url.includes("/credits") ? CREDITS : SUBSCRIPTION;
      return new Response(JSON.stringify(body));
    });
    const mock = createMockPi();
    usageExtension(mock.pi);
    const { ctx, statuses } = createMockContext({
      model: TEST_AUTH.model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => {
          if (timedOut) postTimeoutAuthReads += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, timedOut && guardState === "too-slow" ? 2_000 : 5));
          if (timedOut && guardState === "shutdown") {
            await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
          }
          return { ok: true, apiKey: timedOut && guardState === "rotated" ? "rotated-key" : "test-key" };
        },
        getProviderAuth: async () => ({ auth: { apiKey: "test-key", baseUrl: TEST_AUTH.model.baseUrl } }),
        getAvailable: () => [TEST_AUTH.model],
        getAll: () => [TEST_AUTH.model],
        getProviderAuthStatus: () => ({ configured: true }),
        getProviderDisplayName: () => "Command Code",
      },
    });
    t.onTestFinished(async () => {
      await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    });
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    await vi.advanceTimersByTimeAsync(15_000);
    assert.equal(timedOut, true);
    if (guardState === "stable") {
      assert.ok(postTimeoutAuthReads >= 2, "Adapter and publication guards must finish after the transport timeout");
      assert.equal(statuses.get("usage"), endpoint === "credits" ? undefined : "cmd 5h:99% · wk:92%");
    } else if (guardState === "too-slow") {
      // The query guard has already timed out within 15 s. The status layer separately
      // checks auth before displaying even a failure, so allow that check to settle.
      assert.equal(postTimeoutAuthReads, 2);
      await vi.advanceTimersByTimeAsync(2_000);
      assert.match(statuses.get("usage") ?? "", /^usage err: Timed out/);
    } else {
      assert.equal(postTimeoutAuthReads, 1);
      assert.equal(statuses.get("usage"), guardState === "shutdown" ? undefined : "checking");
    }
    assert.equal(
      seen.some((url) => url.includes("/usage/summary")),
      endpoint === "summary",
    );
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    // Pi auth reads cannot be cancelled; let a late read settle without publishing its result.
    await vi.advanceTimersByTimeAsync(1_001);
    assert.equal(statuses.get("usage"), undefined);
    assert.equal(vi.getTimerCount(), 0);
  });
}

for (const cancelledBoundary of [3, 4]) {
  test(`Command Code rejects cancellation at guard ${cancelledBoundary} after the optional deadline expires`, async () => {
    vi.useFakeTimers();
    const adapter = adapterForProvider("command-code");
    assert.ok(adapter);
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes("/whoami") ? ACCOUNT : url.includes("/credits") ? CREDITS : SUBSCRIPTION;
      return new Response(JSON.stringify(body));
    });
    let boundaries = 0;
    const guard = async () => {
      boundaries += 1;
      if (boundaries === 3) vi.setSystemTime(Date.now() + 1_001);
      if (boundaries === cancelledBoundary) {
        controller.abort();
      }
    };
    await assert.rejects(() => queryProviderUsage(adapter, TEST_AUTH, controller.signal, 1_000, guard), {
      name: "AbortError",
    });
  });
}

test("Command Code usage rejects custom model origins before fetching", async () => {
  const adapter = adapterForProvider("command-code");
  assert.ok(adapter);
  const model = {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "command-code",
    baseUrl: "https://proxy.example.test/provider",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "runtime-key" }),
      getProviderAuth: async () => ({ auth: { apiKey: "runtime-key" } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });

  await assert.rejects(() => resolveUsageAuth(ctx, adapter), /custom provider base URL/);
});
