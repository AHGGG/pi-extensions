import assert from "node:assert/strict";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { test, vi } from "vitest";
import { requestContextManagement } from "../src/remote-context-management.js";
import type { RemoteCompactionRequest } from "../src/remote-types.js";
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
const checkpoint = (text: string) => ({
  type: "response.output_item.done",
  output_index: 0,
  item: { type: "compaction", encrypted_content: text },
});
const terminal = {
  type: "response.completed",
  response: {
    id: "fixture",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
};
const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
async function provider(): Promise<Provider> {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  return (await import(specifier)).openaiProvider();
}
function run(
  p: Provider,
  fetch: typeof globalThis.fetch,
  signal = new AbortController().signal,
  timeout = 2000,
  beforeStreamRetry?: RemoteCompactionRequest["beforeStreamRetry"],
) {
  return requestContextManagement({
    provider: p,
    model,
    context: { systemPrompt: "fixture", messages: [], tools: [] },
    profile: "codex-responses-v1",
    protocol: "context-management",
    apiKey: "fixture",
    signal,
    fetch,
    beforeStreamRetry,
    maxRetries: 0,
    requestTimeoutMs: timeout,
    diagnostics: new RequestDiagnostics(),
  });
}

test("premature EOF gets one fresh retry without carrying partial checkpoint output", async () => {
  const p = await provider();
  let calls = 0;
  const payloads: unknown[] = [];
  const result = await run(p, async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    calls += 1;
    return sse(calls === 1 ? [checkpoint("first-partial")] : [checkpoint("second-complete"), terminal]);
  });
  assert.equal(calls, 2);
  assert.equal(result.item.encrypted_content, "second-complete");
  assert.equal(result.replacementHistory?.length, 1);
  assert.deepEqual(payloads[1], payloads[0], "retry must preserve the same provider-visible request");
});

test("a second premature EOF stops instead of retrying indefinitely", async () => {
  const p = await provider();
  let calls = 0;
  await assert.rejects(
    run(p, async () => {
      calls += 1;
      return sse([]);
    }),
    /terminal response event/,
  );
  assert.equal(calls, 2);
});

for (const kind of ["terminal-error", "invalid-checkpoint", "http-auth", "body-error"] as const) {
  test(`${kind} does not enter the EOF retry path`, async () => {
    const p = await provider();
    let calls = 0;
    await assert.rejects(
      run(p, async () => {
        calls += 1;
        if (kind === "http-auth") return Response.json({ error: { message: "invalid credential" } }, { status: 401 });
        if (kind === "body-error")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("read failure"));
              },
            }),
          );
        if (kind === "terminal-error")
          return sse([
            {
              type: "response.failed",
              response: { status: "failed", error: { code: "server_error", message: "failed" } },
            },
          ]);
        return sse([checkpoint(""), terminal]);
      }),
    );
    assert.equal(calls, 1);
  });
}

test("cancellation during retry backoff does not send another request", async () => {
  const p = await provider();
  vi.useFakeTimers();
  const owner = new AbortController();
  let calls = 0;
  try {
    const result = run(
      p,
      async () => {
        calls += 1;
        return sse([]);
      },
      owner.signal,
    );
    const rejected = assert.rejects(result);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(calls, 1);
    owner.abort();
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    assert.equal(calls, 1);
  } finally {
    vi.useRealTimers();
  }
});

test("retry shares the original deadline rather than receiving a new timeout", async () => {
  const p = await provider();
  vi.useFakeTimers();
  let calls = 0;
  let secondCancelled = false;
  try {
    const result = run(
      p,
      async () => {
        calls += 1;
        if (calls === 1) return sse([]);
        return new Response(
          new ReadableStream({
            cancel() {
              secondCancelled = true;
            },
          }),
        );
      },
      new AbortController().signal,
      1000,
    );
    const rejected = assert.rejects(result, /timed out/);
    await vi.advanceTimersByTimeAsync(251);
    assert.equal(calls, 2);
    await vi.advanceTimersByTimeAsync(749);
    await rejected;
    assert.equal(calls, 2);
    assert.equal(secondCancelled, true);
  } finally {
    vi.useRealTimers();
  }
});

test("insufficient remaining budget does not start a retry", async () => {
  const p = await provider();
  let calls = 0;
  await assert.rejects(
    run(
      p,
      async () => {
        calls += 1;
        return sse([]);
      },
      new AbortController().signal,
      200,
    ),
    /terminal response event/,
  );
  assert.equal(calls, 1);
});

test("failed route revalidation prevents sending a retry", async () => {
  const p = await provider();
  let calls = 0;
  let validations = 0;
  await assert.rejects(
    run(
      p,
      async () => {
        calls += 1;
        return sse([]);
      },
      new AbortController().signal,
      2000,
      async () => {
        validations += 1;
        throw new Error("route changed");
      },
    ),
    /route changed/,
  );
  assert.equal(calls, 1);
  assert.equal(validations, 1);
});

test("shared deadline also bounds a retry revalidation that ignores cancellation", async () => {
  const p = await provider();
  vi.useFakeTimers();
  let calls = 0;
  let validations = 0;
  try {
    const result = run(
      p,
      async () => {
        calls += 1;
        return sse([]);
      },
      new AbortController().signal,
      1000,
      async () => {
        validations += 1;
        await new Promise<void>(() => {});
      },
    );
    const rejected = assert.rejects(result, /timed out/);
    await vi.advanceTimersByTimeAsync(251);
    assert.equal(validations, 1);
    await vi.advanceTimersByTimeAsync(749);
    await rejected;
    assert.equal(calls, 1);
  } finally {
    vi.useRealTimers();
  }
});

test("an overdue deadline blocks retry dispatch even before its timer callback runs", async () => {
  const p = await provider();
  const realNow = performance.now.bind(performance);
  let offset = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
  let calls = 0;
  let validations = 0;
  try {
    await assert.rejects(
      run(
        p,
        async () => {
          calls += 1;
          return sse([]);
        },
        new AbortController().signal,
        1000,
        async () => {
          validations += 1;
          // Simulate synchronous work advancing the monotonic clock while the deadline timer cannot run.
          offset = 2000;
        },
      ),
      /timed out/,
    );
    assert.equal(calls, 1);
    assert.equal(validations, 1);
  } finally {
    clock.mockRestore();
  }
});

test("successful binding revalidation refreshes credentials for the retry only", async () => {
  const p = await provider();
  const authorizations: (string | null)[] = [];
  let calls = 0;
  const result = await run(
    p,
    async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      calls += 1;
      return sse(calls === 1 ? [] : [checkpoint("complete"), terminal]);
    },
    new AbortController().signal,
    2000,
    async () => ({ apiKey: "refreshed-fixture" }),
  );
  assert.equal(result.item.encrypted_content, "complete");
  assert.deepEqual(authorizations, ["Bearer fixture", "Bearer refreshed-fixture"]);
});
