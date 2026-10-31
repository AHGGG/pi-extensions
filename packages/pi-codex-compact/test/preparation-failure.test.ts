import assert from "node:assert/strict";
import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  PrematureCompactionEof,
  preparationFailureDetail,
  preparationFailureRetryable,
} from "../src/preparation-failure.js";
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
async function preparation(
  fetch: typeof globalThis.fetch,
  maxRetries = 0,
  contextManagement: boolean | "text-summary" = false,
) {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
  const provider = openaiProvider();
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "private conversation", timestamp: 1 },
    },
  ];
  if (contextManagement === "text-summary")
    entries.push({
      type: "message",
      id: "tail",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "Retain this tail", timestamp: 2 },
    });
  const state = {
    kind: "loaded" as const,
    path: "/unused",
    settings: {
      ...DEFAULT_CODEX_COMPACT_SETTINGS,
      protocol: contextManagement === true ? ("context-management" as const) : ("responses-compact" as const),
      compactionMode:
        contextManagement === "text-summary" ? ("text-summary" as const) : ("provider-checkpoint" as const),
      maxRetries,
    },
  };
  const runtime: CodexCompactSettingsRuntime = {
    get: () => state,
    reload: async () => state,
    update: async () => state,
    flush: async () => {},
  };
  let apiKey = "secret";
  const { pi } = createMockPi();
  const { ctx } = createMockContext({
    model,
    getSystemPrompt: () => "synthetic system prompt",
    getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
    sessionManager: { getSessionId: () => "session", getBranch: () => entries, getHeader: () => null },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
      getProvider: () => provider,
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
  return {
    captured,
    owner,
    setApiKey: (value: string) => {
      apiKey = value;
    },
  };
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
    if (cancelled) assert.equal(prepared.retryable, false);
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
  assert.equal(prepared.retryable, false);
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
  assert.equal(prepared.retryable, false);
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

test("prepared Context Management failure carries bounded metadata through the public handle", async () => {
  const { captured } = await preparation(
    async () =>
      new Response("", {
        headers: { "content-type": "text/event-stream", "x-private": "secret" },
      }),
    0,
    true,
  );
  const prepared = await captured.start({
    signal: new AbortController().signal,
    isCurrent: () => true,
    ownsStatus: () => false,
  });
  assert.equal(prepared.usable, false);
  assert.match(prepared.failure ?? "", /diag phase=stream|diag phase=headers/);
  assert.match(prepared.failure ?? "", /http=200 body=eof term=0\/0\/0\/0\/0 abort=0\/0\/0/);
  assert.ok((prepared.failure?.length ?? 0) <= 200);
  assert.ok(!prepared.failure?.includes("secret"));
});

test("prepared deadline preserves HTTP headers received before a stalled error body", async () => {
  let headers!: () => void;
  const received = new Promise<void>((resolve) => {
    headers = resolve;
  });
  const { captured } = await preparation(
    async () => {
      const response = new Response(
        new ReadableStream({
          start() {
            headers();
          },
        }),
        { status: 503 },
      );
      return response;
    },
    0,
    true,
  );
  const deadline = new AbortController();
  const pending = captured.start({
    signal: new AbortController().signal,
    deadlineSignal: deadline.signal,
    isCurrent: () => true,
    ownsStatus: () => false,
  });
  await received;
  // Let the fetch continuation observe headers, before cancelling its still-open body.
  await Promise.resolve();
  await Promise.resolve();
  deadline.abort(new Error("secret"));
  const prepared = await pending;
  assert.equal(prepared.usable, false);
  assert.match(prepared.failure ?? "", /^checkpoint request timed out \[diag phase=headers/);
  assert.match(prepared.failure ?? "", /http=503 body=open/);
  assert.match(prepared.failure ?? "", /abort=1\//);
  assert.ok((prepared.failure?.length ?? 0) <= 200);
});

test("retry hint uses typed transport facts and rejects permanent/unknown failures", () => {
  for (const status of [408, 429, 500, 502, 503, 504])
    assert.equal(preparationFailureRetryable(new Error("private"), { httpStatus: status }), true);
  for (const status of [400, 401, 403, 404, 409, 422])
    assert.equal(preparationFailureRetryable(new Error("private"), { httpStatus: status, timedOut: true }), false);
  for (const error of [
    new PrematureCompactionEof("eof"),
    new DOMException("timeout", "TimeoutError"),
    new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) }),
  ])
    assert.equal(preparationFailureRetryable(error), true);
  for (const error of [
    new Error("HTTP 503"),
    new Error("pipe-error"),
    new Error("OpenAI Responses stream ended before a terminal response event"),
    new CodexCompactionProtocolError("invalid"),
    new DOMException("cancelled", "AbortError"),
    { status: 503 },
    undefined,
  ])
    assert.equal(preparationFailureRetryable(error), false);
});

for (const mode of [false, true, "text-summary"] as const) {
  test(`prepared retry hint classifies HTTP failures in ${mode}`, async () => {
    for (const [status, retryable] of [
      [400, false],
      [401, false],
      [403, false],
      [408, true],
      [429, true],
      [503, true],
    ] as const) {
      const { captured } = await preparation(
        async () => Response.json({ error: { message: "private" } }, { status }),
        0,
        mode,
      );
      const result = await captured.start({
        signal: new AbortController().signal,
        isCurrent: () => true,
        ownsStatus: () => false,
      });
      assert.equal(result.usable, false);
      assert.equal(result.retryable, retryable, `status ${status}`);
    }
  });
  test(`prepared retry hint preserves fetch causes in ${mode}`, async () => {
    const { captured } = await preparation(
      async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) });
      },
      0,
      mode,
    );
    const result = await captured.start({
      signal: new AbortController().signal,
      isCurrent: () => true,
      ownsStatus: () => false,
    });
    assert.equal(result.retryable, true);
  });
}

for (const mode of [false, "text-summary"] as const) {
  test(`retry capture enforces original binding at dispatch in ${mode}`, async () => {
    let requests = 0;
    const h = await preparation(
      async () => {
        requests++;
        return Response.json({ error: { message: "busy" } }, { status: 503 });
      },
      0,
      mode,
    );
    const guard = { signal: new AbortController().signal, isCurrent: () => true, ownsStatus: () => false };
    const result = await h.captured.start(guard);
    assert.equal(result.retryable, true);
    const retry = result.retry?.(guard);
    assert.ok(retry);
    h.setApiKey("different-account");
    const refused = await retry.start(guard);
    assert.equal(refused.usable, false);
    assert.equal(refused.retryable, false);
    assert.equal(requests, 1);
    assert.equal(refused.retry?.(guard), undefined);
  });
  test(`retry capture stops on cancellation and allows unchanged binding in ${mode}`, async () => {
    let requests = 0;
    const h = await preparation(
      async () => {
        requests++;
        return Response.json({ error: { message: "busy" } }, { status: 503 });
      },
      0,
      mode,
    );
    const guard = { signal: new AbortController().signal, isCurrent: () => true, ownsStatus: () => false };
    const result = await h.captured.start(guard);
    const cancelled = AbortSignal.abort();
    assert.equal(result.retry?.({ ...guard, signal: cancelled }), undefined);
    assert.equal(result.retry?.({ ...guard, isCurrent: () => false }), undefined);
    const retry = result.retry?.(guard);
    assert.ok(retry);
    const next = await retry.start(guard);
    assert.equal(next.retryable, true);
    assert.equal(requests, 2);
    h.owner.abort();
    assert.equal(next.retry?.(guard), undefined);
  });
}

for (const mode of [true, "text-summary"] as const) {
  test(`only known network pipe failures are retryable in ${mode}`, async () => {
    for (const known of [false, true]) {
      const { captured } = await preparation(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.error(
                  known
                    ? new TypeError("terminated", { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) })
                    : new Error("unknown pipe error"),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        0,
        mode,
      );
      const result = await captured.start({
        signal: new AbortController().signal,
        isCurrent: () => true,
        ownsStatus: () => false,
      });
      assert.equal(result.retryable, known);
    }
  });
  test(`verified clean EOF without terminal is retryable in ${mode}`, async () => {
    const { captured } = await preparation(
      async () => new Response("", { headers: { "content-type": "text/event-stream" } }),
      0,
      mode,
    );
    const result = await captured.start({
      signal: new AbortController().signal,
      isCurrent: () => true,
      ownsStatus: () => false,
    });
    assert.equal(result.retryable, true);
  });
}
