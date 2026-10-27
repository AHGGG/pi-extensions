import assert from "node:assert/strict";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { captureCheckpointPreparation } from "../src/prepared-compaction.js";
import { RejectedRoutes } from "../src/rejection-state.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

const model: Model<Api> = {
  id: "eof-binding-fixture",
  name: "Fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const checkpoint = { type: "compaction", encrypted_content: "complete-second-attempt" };
function response(complete: boolean) {
  const events = complete
    ? [
        { type: "response.output_item.done", output_index: 0, item: checkpoint },
        {
          type: "response.completed",
          response: {
            id: "fixture",
            status: "completed",
            output: [checkpoint],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]
    : [];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
async function fixture(responseMode: "retry-success" | "always-eof" | "healthy" | "hung" = "retry-success") {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const native: Provider = (await import(specifier)).openaiProvider();
  const mock = createMockPi();
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "History to compact", timestamp: 1 });
  const state = {
    provider: native,
    apiKey: "fixture-initial-token",
    account: "fixture-account",
    authBaseUrl: undefined as string | undefined,
    authError: undefined as string | undefined,
    ownerCurrent: true,
    settings: {
      ...DEFAULT_CODEX_COMPACT_SETTINGS,
      protocol: "context-management" as const,
      scratchpadEnabled: false,
      requestTimeoutMs: 2000,
      maxRetries: 0,
    },
  };
  const loaded = () => ({
    kind: "loaded" as const,
    path: "/tmp/fixture-settings.json",
    settings: state.settings,
    document: {},
  });
  const runtime: CodexCompactSettingsRuntime = {
    get: loaded,
    reload: async () => loaded(),
    update: async () => loaded(),
    flush: async () => {},
  };
  const mockCtx = createMockContext({
    model: structuredClone(model),
    sessionManager: manager,
    hasUI: true,
    getSystemPrompt: () => "Fixture system",
    getContextUsage: () => ({ tokens: 65_000, contextWindow: 100_000, percent: 65 }),
    modelRegistry: {
      getApiKeyAndHeaders: async () =>
        state.authError
          ? { ok: false, error: state.authError }
          : {
              ok: true,
              apiKey: state.apiKey,
              headers: { "ChatGPT-Account-Id": state.account },
              ...(state.authBaseUrl ? { baseUrl: state.authBaseUrl } : {}),
            },
      getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: state.apiKey } }),
      getProvider: () => state.provider,
    },
  });
  const requests: Array<{ authorization: string | null; url: string }> = [];
  const controller = new AbortController();
  const preparation = captureCheckpointPreparation(
    mock.pi,
    mockCtx.ctx as ExtensionContext,
    runtime,
    controller.signal,
    new RejectedRoutes(),
    () => state.ownerCurrent,
    () => {},
    async (input, init) => {
      requests.push({ authorization: new Headers(init?.headers).get("authorization"), url: String(input) });
      if (responseMode === "hung")
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      return response(responseMode === "healthy" || (responseMode === "retry-success" && requests.length > 1));
    },
  );
  assert.ok(preparation);
  return { state, ctx: mockCtx.ctx as ExtensionContext, mockCtx, requests, preparation, controller };
}

for (const mutation of ["provider", "account", "route", "model", "settings", "owner", "session", "cancel"] as const) {
  test(`background EOF retry does not dispatch after ${mutation} changes`, async () => {
    const h = await fixture();
    vi.useFakeTimers();
    try {
      const pending = h.preparation.start({
        signal: h.controller.signal,
        isCurrent: () => true,
        ownsStatus: () => true,
      });
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(h.requests.length, 1);
      assert.match(h.preparation.diagnostics?.().status ?? "", /retry-wait/);
      switch (mutation) {
        case "provider":
          h.state.provider = { ...h.state.provider };
          break;
        case "account":
          h.state.account = "different-account";
          break;
        case "route":
          h.state.authBaseUrl = "https://different.example/v1";
          break;
        case "model":
          h.ctx.model = { ...model, id: "different-model" };
          break;
        case "settings":
          h.state.settings = { ...h.state.settings, maintenanceMessage: "different maintenance" };
          break;
        case "owner":
          h.state.ownerCurrent = false;
          break;
        case "session":
          h.ctx.sessionManager = SessionManager.inMemory();
          break;
        case "cancel":
          h.controller.abort();
          break;
      }
      await vi.advanceTimersByTimeAsync(300);
      const result = await pending;
      assert.equal(result.usable, false);
      assert.equal(h.requests.length, 1, "stale preparation must not dispatch another HTTP request");
    } finally {
      vi.useRealTimers();
    }
  });
}

test("background EOF retry accepts same-identity OAuth refresh and dispatches renewed credentials", async () => {
  const h = await fixture();
  vi.useFakeTimers();
  try {
    const pending = h.preparation.start({ signal: h.controller.signal, isCurrent: () => true, ownsStatus: () => true });
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(h.requests.length, 1);
    assert.match(h.preparation.diagnostics?.().status ?? "", /retry-wait/);
    h.state.apiKey = "fixture-refreshed-token";
    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;
    assert.equal(result.usable, true);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(
      h.requests.map((request) => request.authorization),
      ["Bearer fixture-initial-token", "Bearer fixture-refreshed-token"],
    );
    assert.doesNotMatch(
      h.mockCtx.notifications.map((notice) => notice.message).join("\n"),
      /fixture-(?:initial|refreshed)-token/,
    );
  } finally {
    vi.useRealTimers();
  }
});

for (const [mode, expectedUsable, expectedReports] of [
  ["retry-success", true, 1],
  ["always-eof", false, 1],
  ["healthy", true, 0],
] as const) {
  for (const owner of [undefined, "consumer"] as const)
    test(`${mode} automatic reporting with owner ${owner ?? "producer"}`, async () => {
      const h = await fixture(mode);
      vi.useFakeTimers();
      try {
        const pending = h.preparation.start({
          signal: h.controller.signal,
          isCurrent: () => true,
          ownsStatus: () => true,
          failureReportOwner: owner,
        });
        await vi.advanceTimersByTimeAsync(300);
        const result = await pending;
        assert.equal(result.usable, expectedUsable);
        const reports = h.mockCtx.notifications.filter(({ message }) =>
          message.includes("Compaction diagnostics schema=2"),
        );
        const reportCount = owner === "consumer" && !expectedUsable ? 0 : expectedReports;
        assert.equal(reports.length, reportCount);
        const snapshot = h.preparation.diagnostics?.();
        assert.ok(snapshot?.report);
        if (!expectedUsable) assert.match(snapshot.report, /outcome=failed/);
        if (mode === "retry-success") assert.match(reports[0].message, /streamOutcome=recovered-after-retry/);
        if (mode === "always-eof" && reportCount) assert.match(reports[0].message, /streamOutcome=failed/);
        if (reportCount) {
          assert.match(reports[0].message, /attempt=1[\s\S]*attempt=2/);
          assert.doesNotMatch(reports[0].message, /fixture-initial-token|History to compact|complete-second-attempt/);
        }
      } finally {
        vi.useRealTimers();
      }
    });
}

test("pre-dispatch authentication rejection automatically reports zero HTTP attempts without error prose", async () => {
  const h = await fixture();
  h.state.authError = "private-upstream-secret-error";
  const result = await h.preparation.start({
    signal: h.controller.signal,
    isCurrent: () => true,
    ownsStatus: () => true,
  });
  assert.equal(result.usable, false);
  assert.equal(h.requests.length, 0);
  const reports = h.mockCtx.notifications.filter(({ message }) => message.includes("Compaction diagnostics schema=2"));
  assert.equal(reports.length, 1);
  assert.match(reports[0].message, /attempts=0/);
  assert.doesNotMatch(reports[0].message, /private-upstream-secret-error|fixture-initial-token/);
});

test("background deadline is reported separately from caller cancellation", async () => {
  const h = await fixture("hung");
  const deadline = new AbortController();
  vi.useFakeTimers();
  try {
    const pending = h.preparation.start({
      signal: h.controller.signal,
      deadlineSignal: deadline.signal,
      isCurrent: () => true,
      ownsStatus: () => true,
    });
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(h.requests.length, 1);
    deadline.abort(new Error("Background compaction request timed out"));
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    assert.equal(result.usable, false);
    assert.equal(h.controller.signal.aborted, false);
    const reports = h.mockCtx.notifications.filter(({ message }) =>
      message.includes("Compaction diagnostics schema=2"),
    );
    assert.equal(reports.length, 1);
    assert.match(reports[0].message, /abort\(d\/c\/p\)=1\/0\//);
  } finally {
    vi.useRealTimers();
  }
});

for (const failure of ["auth", "deadline"] as const)
  test(`consumer owns ${failure} preparation failure but receives finalized diagnostics`, async () => {
    const h = await fixture(failure === "deadline" ? "hung" : "healthy");
    const deadline = new AbortController();
    if (failure === "auth") h.state.authError = "private-auth-error";
    vi.useFakeTimers();
    try {
      const pending = h.preparation.start({
        signal: h.controller.signal,
        deadlineSignal: deadline.signal,
        isCurrent: () => true,
        ownsStatus: () => false,
        failureReportOwner: "consumer",
      });
      await vi.advanceTimersByTimeAsync(1);
      if (failure === "deadline") deadline.abort(new Error("deadline"));
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      assert.equal(result.usable, false);
      assert.equal(
        h.mockCtx.notifications.filter(({ message }) => message.includes("Compaction diagnostics")).length,
        0,
      );
      const report = h.preparation.diagnostics?.().report ?? "";
      assert.match(report, /outcome=failed/);
      assert.match(report, failure === "auth" ? /attempts=0/ : /abort\(d\/c\/p\)=1\/0\//);
      assert.doesNotMatch(report, /private-auth-error|fixture-initial-token/);
    } finally {
      vi.useRealTimers();
    }
  });
