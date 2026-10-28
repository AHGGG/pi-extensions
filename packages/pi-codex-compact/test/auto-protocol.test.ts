import assert from "node:assert/strict";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { latestCheckpoint, parseCheckpointDetails } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { COMPACTION_ENGINE_REQUEST, type CompactionEngineV1 } from "../src/prepared-compaction-protocol.js";
import type { JsonObject } from "../src/protocol.js";
import { type CodexCompactSettings, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

const proxyModel: Model<"openai-responses"> = {
  id: "fixture",
  name: "Proxy fixture",
  provider: "custom",
  api: "openai-responses",
  baseUrl: "https://proxy.example.test/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const checkpoint = { type: "compaction", id: "cmp_auto", encrypted_content: "synthetic-opaque" };

function managedResponse(includeCheckpoint = true): Response {
  const events = [
    ...(includeCheckpoint ? [{ type: "response.output_item.done", output_index: 0, item: checkpoint }] : []),
    {
      type: "response.completed",
      response: {
        id: "resp_auto",
        status: "completed",
        output: [],
        usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function fixture(
  options: {
    model?: Model<"openai-responses">;
    settings?: Partial<CodexCompactSettings>;
    status?: number;
    error?: JsonObject;
    inference?: () => Response;
    beforeResponse?: (url: string) => void;
    endpoint?: () => string;
  } = {},
) {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
  const native = openaiProvider();
  const provider: Provider = options.endpoint
    ? {
        ...native,
        stream: (model, context, requestOptions) =>
          native.stream(
            model,
            context,
            Object.assign({}, requestOptions, {
              fetch: (input: RequestInfo | URL, init?: RequestInit) =>
                (requestOptions?.fetch ?? fetch)(options.endpoint?.() ?? input, init),
            }),
          ),
      }
    : native;
  const model = options.model ?? structuredClone(proxyModel);
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Preserve the original task and its constraints.", timestamp: 1 });
  const keptId = manager.appendMessage({ role: "user", content: "Keep the latest question.", timestamp: 2 });
  const original = structuredClone(manager.getBranch());
  const mock = createMockPi();
  const calls: { url: string; body: JsonObject; authorization: string | null }[] = [];
  let apiKey = "synthetic-key";
  const state = {
    kind: "loaded" as const,
    path: "/unused/pi-codex-compact.json",
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, maxRetries: 0, ...options.settings },
    document: {},
  };
  const context = createMockContext({
    model,
    mode: "rpc",
    sessionManager: manager,
    getSystemPrompt: () => "Original instructions.",
    getContextUsage: () => ({ tokens: 65_000, contextWindow: 100_000, percent: 65 }),
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey, headers: { "X-Proxy-Route": "synthetic" } }),
      getProvider: () => provider,
    },
  });
  createCodexCompactExtension({
    settingsRuntime: {
      get: () => state,
      reload: async () => state,
      update: async () => state,
      flush: async () => {},
    },
    fetch: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-proxy-route"), "synthetic");
      calls.push({ url, body: JSON.parse(String(init?.body)), authorization: headers.get("authorization") });
      options.beforeResponse?.(url);
      if (!url.endsWith("/compact")) return options.inference?.() ?? managedResponse();
      if (options.status === 200) return Response.json({ invalid: "not a checkpoint" });
      return Response.json(
        { error: options.error ?? { message: "synthetic denied operation" } },
        {
          status: options.status ?? 403,
        },
      );
    },
  })(mock.pi);
  let engine: CompactionEngineV1 | undefined;
  mock.eventBus.emit(COMPACTION_ENGINE_REQUEST, {
    accept: (value: CompactionEngineV1) => {
      engine = value;
    },
  });
  assert.ok(engine);
  const controller = new AbortController();
  const event: SessionBeforeCompactEvent = {
    type: "session_before_compact",
    reason: "manual",
    willRetry: false,
    signal: controller.signal,
    branchEntries: manager.getBranch(),
    preparation: {
      firstKeptEntryId: keptId,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 65_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 1000 },
    },
  };
  const compact = async () => mock.events.get("session_before_compact")?.[0]?.(event, context.ctx);
  return {
    ...context,
    ...mock,
    manager,
    original,
    calls,
    controller,
    event,
    engine,
    compact,
    setApiKey(value: string) {
      apiKey = value;
    },
  };
}

for (const status of [403, 404, 405, 501]) {
  test(`auto proxy compaction falls back after HTTP ${status} and remembers the successful protocol`, async () => {
    const h = await fixture({ status });
    const result = (await h.compact()) as { compaction?: { details?: unknown } };
    assert.equal(parseCheckpointDetails(result?.compaction?.details)?.protocol, "context-management");
    assert.deepEqual(
      h.calls.map(({ url }) => new URL(url).pathname),
      ["/v1/responses/compact", "/v1/responses"],
    );
    assert.deepEqual(h.calls[1].body.context_management, [{ type: "compaction", compact_threshold: 1024 }]);
    assert.equal(h.calls[1].body.tool_choice, "none");
    assert.ok(h.calls.every(({ authorization }) => authorization === "Bearer synthetic-key"));
    assert.deepEqual(h.manager.getBranch(), h.original);
    await h.compact();
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[2].url.endsWith("/responses"), true);
    h.setApiKey("replacement-key");
    await h.compact();
    assert.equal(h.calls.length, 5);
    assert.equal(h.calls[3].url.endsWith("/responses/compact"), true);
    assert.equal(h.calls[4].authorization, "Bearer replacement-key");
  });
}

for (const status of [400, 401, 429, 500, 200]) {
  test(`auto does not negotiate after HTTP ${status}`, async () => {
    const h = await fixture({ status });
    assert.equal(await h.compact(), undefined);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.manager.getBranch(), h.original);
  });
}

test("explicit protocols and official OpenAI routes do not opt into proxy negotiation", async () => {
  for (const options of [
    { settings: { protocol: "responses-compact" as const } },
    { model: { ...proxyModel, provider: "openai", baseUrl: "https://api.openai.com/v1" } },
  ]) {
    const h = await fixture(options);
    assert.equal(await h.compact(), undefined);
    assert.equal(h.calls.length, 1);
  }
});

test("a hardened OAuth rejection cannot trigger protocol negotiation", async () => {
  const h = await fixture({
    error: { code: "hardened_oauth_rule_missing", type: "rejected_by_hardened_oauth_boundary" },
  });
  assert.equal(await h.compact(), undefined);
  assert.equal(h.calls.length, 1);
});

test("cancelling the rejected request prevents the fallback request", async () => {
  let cancel = () => {};
  const h = await fixture({ beforeResponse: () => cancel() });
  cancel = () => h.controller.abort();
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.equal(h.calls.length, 1);
});

test("a proxy ignoring context_management hands foreground compaction back to Pi without publishing a checkpoint", async () => {
  const h = await fixture({ inference: () => managedResponse(false) });
  assert.equal(await h.compact(), undefined);
  assert.equal(h.calls.length, 2);
  assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
  assert.deepEqual(h.manager.getBranch(), h.original);
});

test("a negotiated background checkpoint can be validated and adopted without another inference request", async () => {
  const h = await fixture();
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const prepared = await preparation.start({
    signal: h.controller.signal,
    isCurrent: () => true,
    ownsStatus: () => false,
  });
  assert.equal(prepared.usable, true);
  h.manager.appendMessage({ role: "user", content: "New work after the captured prefix.", timestamp: 3 });
  const draft = await prepared.draft(h.ctx, { signal: h.controller.signal, isCurrent: () => true });
  assert.ok(draft.draft);
  assert.equal(h.calls.length, 2);
  const value = draft.draft;
  h.manager.appendCompaction(value.summary, value.firstKeptEntryId, 65_000, value.details, true, value.usage);
  assert.equal(h.engine.checkpointId(h.ctx), draft.checkpointId);
  assert.equal(latestCheckpoint(h.manager.getBranch())?.details.protocol, "context-management");
  assert.match(JSON.stringify(h.manager.buildSessionContext().messages), /New work after the captured prefix/);
  const projected = (await h.events.get("context")?.[0]?.(
    {
      type: "context",
      messages: h.manager.buildSessionContext().messages,
    },
    h.ctx,
  )) as { messages: { content: string | { type: string; text?: string }[] }[] };
  const payload = {
    instructions: "Original instructions.",
    input: projected.messages.map((message) => ({
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => part.text ?? "").join("\n"),
        },
      ],
    })),
  };
  const replayed = await h.events.get("before_provider_request")?.[0]?.(
    { type: "before_provider_request", payload },
    h.ctx,
  );
  assert.match(JSON.stringify(replayed), /synthetic-opaque/);
  assert.match(JSON.stringify(replayed), /New work after the captured prefix/);
});

test("session reload clears the successful protocol observation", async () => {
  const h = await fixture();
  await h.compact();
  await h.events.get("session_start")?.[0]?.({ type: "session_start", reason: "reload" }, h.ctx);
  await h.compact();
  assert.deepEqual(
    h.calls.map(({ url }) => new URL(url).pathname),
    ["/v1/responses/compact", "/v1/responses", "/v1/responses/compact", "/v1/responses"],
  );
});

test("a rejected Context Management attempt uses the existing fallback without a third protocol request", async () => {
  const h = await fixture({
    inference: () => Response.json({ error: { message: "unsupported context_management" } }, { status: 400 }),
  });
  assert.equal(await h.compact(), undefined);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.manager.getBranch(), h.original);
});

for (const cached of [false, true]) {
  test(`a changed inference backend cannot receive automatic maintenance (cached=${cached})`, async () => {
    let endpoint = `${proxyModel.baseUrl}/responses`;
    const h = await fixture({
      endpoint: () => endpoint,
      beforeResponse: (url) => {
        if (!cached && url.endsWith("/compact")) endpoint = "https://different.example.test/v1/responses";
      },
    });
    if (cached) {
      await h.compact();
      endpoint = "https://different.example.test/v1/responses";
    }
    const before = h.calls.length;
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.equal(h.calls.length - before, cached ? 0 : 1);
    assert.deepEqual(h.manager.getBranch(), h.original);
  });
}
