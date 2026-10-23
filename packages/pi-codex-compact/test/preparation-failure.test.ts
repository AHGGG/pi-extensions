import assert from "node:assert/strict";
import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { preparationFailureDetail } from "../src/preparation-failure.js";
import { captureCheckpointPreparation } from "../src/prepared-compaction.js";
import { CodexCompactionProtocolError } from "../src/protocol.js";
import { RejectedRoutes } from "../src/rejection-state.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

for (const [status, reason] of [
  [401, "authentication rejected"],
  [403, "access denied"],
  [429, "rate limited"],
  [503, "provider service error"],
  [400, "request rejected"],
] as const) {
  test(`preparation diagnostic exposes only observed HTTP ${status}`, () => {
    assert.equal(
      preparationFailureDetail(new Error("Bearer SECRET private prompt"), { httpStatus: status }),
      `HTTP ${status}: ${reason}`,
    );
  });
}

test("untrusted error messages, names, codes and malformed bodies are never echoed", () => {
  for (const error of [
    new Error("secret prompt\u001b[31m\n".repeat(100_000)),
    new Error('{"error":{"code":"SECRET","message":"private conversation"}}'),
    Object.assign(new Error("secret"), { name: "SECRET", code: "SECRET" }),
    { message: "private text", status: 429 },
    {
      toString() {
        throw new Error("must not stringify arbitrary errors");
      },
    },
    "secret",
    undefined,
  ]) {
    const detail = preparationFailureDetail(error);
    assert.equal(detail, "checkpoint preparation failed before provider dispatch (no safe error details available)");
    assert.ok(detail.length < 240);
  }
});

test("trusted deadline, protocol type and allowlisted network cause get fixed diagnostics", () => {
  assert.equal(
    preparationFailureDetail(new Error("aborted"), { timedOut: true, httpStatus: 500 }),
    "checkpoint request timed out",
  );
  assert.equal(preparationFailureDetail(new DOMException("secret", "TimeoutError")), "checkpoint request timed out");
  assert.equal(
    preparationFailureDetail(new CodexCompactionProtocolError("private checkpoint")),
    "invalid compaction response or checkpoint",
  );
  const cause = Object.assign(new Error("secret address"), { code: "ECONNRESET" });
  assert.equal(
    preparationFailureDetail(new TypeError("fetch failed", { cause })),
    "network request failed (ECONNRESET)",
  );
  assert.equal(
    preparationFailureDetail(new DOMException("secret", "AbortError")),
    "provider or transport aborted the checkpoint request",
  );
  assert.equal(
    preparationFailureDetail(new Error("failed"), { remoteAttempted: true }),
    "provider checkpoint preparation failed (no safe error details available)",
  );
});

test("exact OAuth rejection is useful without echoing any provider prose", () => {
  const error = new Error(
    JSON.stringify({
      error: { code: "hardened_oauth_rule_missing", type: "rejected_by_hardened_oauth_boundary", message: "secret" },
    }),
  );
  assert.equal(
    preparationFailureDetail(error, { httpStatus: 401 }),
    "ChatGPT OAuth rejected this compaction operation",
  );
});

const model: Model<"openai-responses"> = {
  id: "synthetic-model",
  name: "fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
async function preparation(fetch: typeof globalThis.fetch, maxRetries = 0) {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "private conversation", timestamp: 1 },
    },
  ];
  const state = {
    kind: "loaded" as const,
    path: "/unused",
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol: "responses-compact" as const, maxRetries },
  };
  const runtime: CodexCompactSettingsRuntime = {
    get: () => state,
    reload: async () => state,
    update: async () => state,
    flush: async () => {},
  };
  const { pi } = createMockPi();
  const { ctx } = createMockContext({
    model,
    getSystemPrompt: () => "synthetic system prompt",
    getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
    sessionManager: { getSessionId: () => "session", getBranch: () => entries },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
      getProvider: () => openaiProvider(),
    },
  });
  const owner = new AbortController();
  const captured = captureCheckpointPreparation(
    pi as ExtensionAPI,
    ctx,
    runtime,
    owner.signal,
    new RejectedRoutes(),
    () => true,
    () => {},
    fetch,
  );
  assert.ok(captured);
  return { captured, owner };
}

test("prepared handle carries observed HTTP failure without provider response text", async () => {
  const { captured } = await preparation(async () =>
    Response.json({ error: { message: "secret prompt or credential", code: "private-code" } }, { status: 429 }),
  );
  const result = await captured.start({
    signal: new AbortController().signal,
    isCurrent: () => true,
    ownsStatus: () => false,
  });
  assert.equal(result.usable, false);
  assert.equal(result.failure, "HTTP 429: rate limited");
});

test("prepared deadline identifies timeout while owner cancellation remains cancellation", async () => {
  for (const cancelled of [false, true]) {
    const { captured, owner } = await preparation(
      async (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        ),
    );
    const deadline = new AbortController();
    const result = captured.start({
      signal: new AbortController().signal,
      deadlineSignal: deadline.signal,
      isCurrent: () => true,
      ownsStatus: () => false,
    });
    if (cancelled) owner.abort();
    else deadline.abort(new DOMException("deadline", "TimeoutError"));
    const prepared = await result;
    assert.equal(prepared.usable, false);
    assert.equal(prepared.failure, cancelled ? "checkpoint preparation failed" : "checkpoint request timed out");
    assert.equal(captured.isCurrent(), !cancelled);
  }
});

test("fetch-boundary network cause survives provider error formatting", async () => {
  const { captured } = await preparation(async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("private endpoint"), { code: "ECONNRESET" }),
    });
  });
  const prepared = await captured.start({
    signal: new AbortController().signal,
    isCurrent: () => true,
    ownsStatus: () => false,
  });
  assert.equal(prepared.failure, "network request failed (ECONNRESET)");
});

test("malformed response produces a safe checkpoint diagnostic", async () => {
  const { captured } = await preparation(async () => Response.json({ output: [{ type: "private conversation" }] }));
  const prepared = await captured.start({
    signal: new AbortController().signal,
    isCurrent: () => true,
    ownsStatus: () => false,
  });
  assert.equal(prepared.failure, "invalid compaction response or checkpoint");
});

test("HTTP status from an earlier retry does not mask a later invalid response", async () => {
  let requests = 0;
  const { captured } = await preparation(
    async () =>
      ++requests === 1
        ? Response.json({ error: { message: "secret" } }, { status: 503, headers: { "retry-after-ms": "1" } })
        : Response.json({ output: [] }),
    1,
  );
  const prepared = await captured.start({
    signal: new AbortController().signal,
    isCurrent: () => true,
    ownsStatus: () => false,
  });
  assert.equal(requests, 2);
  assert.equal(prepared.failure, "invalid compaction response or checkpoint");
});

test("provider-owned fetch timeout retains its category before the preparation deadline", async () => {
  const { captured } = await preparation(async () => {
    throw new DOMException("private endpoint", "TimeoutError");
  });
  const prepared = await captured.start({
    signal: new AbortController().signal,
    isCurrent: () => true,
    ownsStatus: () => false,
  });
  assert.equal(prepared.failure, "checkpoint request timed out");
});
