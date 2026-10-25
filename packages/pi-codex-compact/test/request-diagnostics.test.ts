import assert from "node:assert/strict";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { test, vi } from "vitest";
import { requestContextManagement } from "../src/remote-context-management.js";
import { RequestDiagnostics } from "../src/request-diagnostics.js";

const model = {
  id: "fixture",
  name: "fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1000,
} as Model<Api>;
async function run(
  fetch: typeof globalThis.fetch,
  diagnostics: RequestDiagnostics,
  signal = new AbortController().signal,
  timeout = 1000,
) {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const provider: Provider = (await import(specifier)).openaiProvider();
  return requestContextManagement({
    provider,
    model,
    profile: "codex-responses-v1",
    protocol: "context-management",
    context: { systemPrompt: "SECRET prompt", messages: [], tools: [] },
    apiKey: "SECRET credential",
    signal,
    requestTimeoutMs: timeout,
    maxRetries: 0,
    diagnostics,
    fetch,
  });
}
function response(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream; private=SECRET", "x-secret": "SECRET" },
  });
}
const checkpoint = {
  type: "response.output_item.done",
  output_index: 0,
  item: { type: "compaction", id: "SECRET id", encrypted_content: "SECRET checkpoint" },
};
const terminal = (type: string) => ({
  type,
  response: {
    id: "SECRET response",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
});

for (const kind of ["empty", "early-eof", "done", "completed"] as const) {
  test(`native adapter diagnostics distinguish ${kind} without changing completion acceptance`, async () => {
    const diagnostics = new RequestDiagnostics();
    const events =
      kind === "empty" ? [] : [checkpoint, ...(kind === "early-eof" ? [] : [terminal(`response.${kind}`)])];
    const result = run(async () => response(events), diagnostics);
    if (kind === "completed") await result;
    else await assert.rejects(result, /terminal response event/);
    const summary = diagnostics.summary();
    assert.match(summary, /attempts=1 headers=200@\d+s mime=sse body=eof/);
    assert.match(
      summary,
      kind === "done"
        ? /terminal\(c\/d\/i\/f\/e\)=0\/1\/0\/0\/0/
        : kind === "completed"
          ? /terminal\(c\/d\/i\/f\/e\)=1\/0\/0\/0\/0/
          : /terminal\(c\/d\/i\/f\/e\)=0\/0\/0\/0\/0/,
    );
    assert.match(summary, /abort\(d\/c\/p\)=0\/0\/0/);
    assert.ok(!summary.includes("SECRET"));
    const snapshot = diagnostics.summary();
    await Promise.resolve();
    assert.equal(diagnostics.summary(), snapshot, "cleanup must not rewrite a frozen failure snapshot");
  });
}

test("body read exception is a pipe failure, not inferred network cause", async () => {
  const diagnostics = new RequestDiagnostics();
  await assert.rejects(
    run(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("SECRET body"));
            },
          }),
        ),
      diagnostics,
    ),
  );
  assert.match(diagnostics.summary(), /body=pipe-error/);
  assert.ok(!diagnostics.summary().includes("SECRET"));
});

for (const ownerCancel of [false, true]) {
  test(`stalled body records ${ownerCancel ? "caller cancellation" : "local deadline"} before cleanup`, async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const diagnostics = new RequestDiagnostics();
    let ready!: () => void;
    const opened = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let cancelled = false;
    try {
      const result = run(
        async () => {
          ready();
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          );
        },
        diagnostics,
        owner.signal,
      );
      const rejected = assert.rejects(result);
      await opened;
      if (ownerCancel) owner.abort();
      else await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      assert.match(diagnostics.summary(), ownerCancel ? /abort\(d\/c\/p\)=0\/1\// : /abort\(d\/c\/p\)=1\/0\//);
      await Promise.resolve();
      assert.equal(cancelled, true);
    } finally {
      vi.useRealTimers();
    }
  });
}

test("attempt counters reset while attempt count persists and old callbacks cannot contaminate current attempt", () => {
  const d = new RequestDiagnostics();
  const first = d.beginAttempt();
  d.headers(Response.json({ secret: "SECRET" }, { status: 503 }), first);
  d.chunk(100, first);
  d.observe(terminal("response.failed"));
  d.providerAborted(first);
  const second = d.beginAttempt();
  d.headers(response([]), second);
  d.chunk(2, second);
  d.chunk(99, first);
  d.end(first);
  d.pipeError(first, true);
  d.providerAborted(first);
  d.observe({ type: "SECRET unknown", payload: "SECRET" });
  assert.match(d.summary(), /attempts=2 headers=200@\d+s mime=sse body=open bytes=2 chunks=1/);
  assert.match(d.summary(), /terminal\(c\/d\/i\/f\/e\)=0\/0\/0\/0\/0 abort\(d\/c\/p\)=0\/0\/0/);
  assert.ok(!d.summary().includes("SECRET"));
});

test("diagnostics classify absent bodies and remain bounded for arbitrary content types and event data", () => {
  const d = new RequestDiagnostics();
  const attempt = d.beginAttempt();
  d.headers(new Response(null, { status: 204, headers: { "content-type": "SECRET/arbitrary" } }), attempt);
  for (const type of ["response.completed", "response.done", "response.incomplete", "response.failed", "error"])
    d.observe({ type, secret: "SECRET".repeat(10000) });
  assert.match(d.summary(), /mime=other body=absent/);
  assert.match(d.summary(), /terminal\(c\/d\/i\/f\/e\)=1\/1\/1\/1\/1/);
  assert.ok(d.summary().length < 1000);
  assert.ok(d.compact().length < 140);
  assert.ok(!d.summary().includes("SECRET"));
});

test("safe milestone and output-category diagnostics include successful checkpoint timing", () => {
  const d = new RequestDiagnostics();
  d.configure("remote-v2", "context-management", false);
  const attempt = d.beginAttempt();
  d.headers(response([]), attempt);
  d.chunk(12, attempt);
  d.observe(checkpoint);
  d.observe({ type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "SECRET" } });
  d.observe({ type: "response.output_item.done", item: { type: "message", content: "SECRET" } });
  d.observe({ type: "response.output_item.done", item: { type: "SECRET type" } });
  d.observe(terminal("response.completed"));
  d.seal();
  assert.match(d.summary(), /requested=remote-v2 resolved=context-management append=off/);
  assert.match(d.summary(), /items\(compaction\/reasoning\/message\/other\)=1\/1\/1\/1/);
  assert.match(
    d.summary(),
    /milestones-ms\(firstByte\/firstEvent\/firstCompaction\/terminal\/lastByte\)=\d+\/\d+\/\d+\/\d+\/\d+/,
  );
  assert.ok(!d.summary().includes("SECRET"));
});
