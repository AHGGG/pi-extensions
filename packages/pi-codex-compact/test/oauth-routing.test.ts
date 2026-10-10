import assert from "node:assert/strict";
import type { AuthResult, Model, Provider } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { checkpointMarker, createCheckpointDetails, fallbackSummary } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { COMPACTION_MAINTENANCE_MESSAGE } from "../src/context-management.js";
import type { RemoteCompactionProtocolSetting } from "../src/model-api.js";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

const model: Model<"openai-responses"> = {
  id: "gpt-5.5",
  name: "OpenAI fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
const checkpoint = { type: "compaction", id: "cmp_new", encrypted_content: "opaque-new" };
const reasoning = { type: "reasoning", id: "rs_new", summary: [], encrypted_content: "signed-new" };
const acknowledgement = {
  type: "message",
  id: "msg_maintenance",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "OK", annotations: [] }],
};
const usage = { input_tokens: 3000, output_tokens: 10, total_tokens: 3010 };

function streaming(items: unknown[]): Response {
  const events = [
    ...items.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    {
      type: "response.completed",
      response: { id: "resp_compaction", status: "completed", output: items, usage },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function harness(options: {
  protocol: RemoteCompactionProtocolSetting;
  oauth?: boolean;
  prior?: boolean;
  resolveAuth?: () => Promise<AuthResult | undefined>;
}) {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
  const provider = openaiProvider();
  const apiKey = options.oauth === false ? "sk-fixture-key" : "fixture-chatgpt-access";
  const providerAuth: AuthResult = {
    source: options.oauth === false ? "stored credential" : "OAuth",
    auth: { apiKey },
  };
  let settings = { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol: options.protocol, maxRetries: 0 };
  const state = () => ({ kind: "loaded" as const, path: "/unused/pi-codex-compact.json", settings });
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Finish the pending task and report its result.", timestamp: 1 },
    },
  ];
  if (options.prior) {
    const details = createCheckpointDetails({
      provider: model.provider,
      api: model.api,
      profile: "openai-responses-v1",
      modelId: model.id,
      protocol: "remote-v2",
      checkpointId: "existing",
      replacementHistory: [{ type: "compaction", encrypted_content: "opaque-existing" }],
      keptMessages: [entries[0].type === "message" ? entries[0].message : assert.fail()],
    });
    entries.push({
      type: "compaction",
      id: "old-compaction",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      summary: fallbackSummary(details.checkpointId),
      firstKeptEntryId: "user",
      tokensBefore: 3000,
      details,
    });
  }
  const original = structuredClone(entries);
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const mock = createMockPi();
  createCodexCompactExtension({
    settingsRuntime: {
      get: state,
      reload: async () => state(),
      update: async (patch) => {
        settings = { ...settings, ...patch };
        return state();
      },
      flush: async () => {},
    },
    fetch: async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      requests.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/responses/compact")) return Response.json({ output: [checkpoint], usage });
      return streaming(body.context_management ? [checkpoint, reasoning, acknowledgement] : [checkpoint]);
    },
  })(mock.pi);
  let sessionId = "session";
  const context = createMockContext({
    mode: "tui",
    model,
    getSystemPrompt: () => "Complete the user's task.",
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    modelRegistry: {
      getProvider: () => provider,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
      getProviderAuth: options.resolveAuth ?? (async () => providerAuth),
      isUsingOAuth: () => assert.fail("routing must not rely on a credential snapshot"),
    },
  });
  const controller = new AbortController();
  const event: SessionBeforeCompactEvent = {
    type: "session_before_compact",
    branchEntries: entries,
    reason: "threshold",
    willRetry: false,
    signal: controller.signal,
    preparation: {
      firstKeptEntryId: "user",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 3000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
  };
  const handler = mock.events.get("session_before_compact")?.[0];
  assert.ok(handler);
  return {
    ...context,
    mock,
    entries,
    original,
    requests,
    controller,
    settings: () => settings,
    run: () => handler(event, context.ctx),
    replaceSession: () => {
      sessionId = "replacement";
    },
    changeSettings: () => {
      settings = { ...settings, maxRetries: 1 };
    },
  };
}

for (const protocol of ["auto", "remote-v2", "responses-compact", "context-management"] as const) {
  for (const prior of [false, true]) {
    test(`${protocol}, prior=${prior}: resolved ChatGPT OAuth compacts once through normal Responses`, async () => {
      const h = await harness({ protocol, prior });
      const result = (await h.run()) as {
        compaction: { details: { protocol: string; replacementHistory: unknown[] } };
      };
      assert.equal(result.compaction.details.protocol, "context-management");
      assert.deepEqual(result.compaction.details.replacementHistory, [checkpoint, reasoning, acknowledgement]);
      assert.equal(h.requests.length, 1, "successful OAuth compaction does not make a readable-summary request");
      const request = h.requests[0];
      assert.equal(request.url, "https://api.openai.com/v1/responses");
      assert.equal(request.authorization, "Bearer fixture-chatgpt-access");
      assert.deepEqual(request.body.context_management, [{ type: "compaction", compact_threshold: 1024 }]);
      assert.equal(request.body.tool_choice, "none");
      assert.doesNotMatch(JSON.stringify(request.body), /compaction_trigger/);
      assert.ok(JSON.stringify(request.body).includes(COMPACTION_MAINTENANCE_MESSAGE));
      if (prior) {
        assert.match(JSON.stringify(request.body), /opaque-existing/);
        assert.ok(!JSON.stringify(request.body).includes(checkpointMarker("existing")));
      }
      assert.deepEqual(h.notifications, []);
      assert.deepEqual(h.entries, h.original);
      assert.equal(h.settings().protocol, protocol, "auth routing does not rewrite the user's settings");
    });
  }
}

for (const protocol of ["auto", "remote-v2", "responses-compact", "context-management"] as const) {
  test(`${protocol}: API-key requests retain their selected wire protocol`, async () => {
    const h = await harness({ protocol, oauth: false });
    const result = (await h.run()) as { compaction: { details: { protocol: string } } };
    const expected = protocol === "auto" ? "responses-compact" : protocol;
    assert.equal(result.compaction.details.protocol, expected);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].authorization, "Bearer sk-fixture-key");
    assert.equal(
      h.requests[0].url,
      `https://api.openai.com/v1/responses${expected === "responses-compact" ? "/compact" : ""}`,
    );
    assert.equal(h.requests[0].body.context_management !== undefined, expected === "context-management");
    assert.equal(JSON.stringify(h.requests[0].body).includes("compaction_trigger"), expected === "remote-v2");
    assert.deepEqual(h.notifications, []);
  });
}

for (const transition of ["cancel", "replacement", "shutdown", "settings", "model"] as const) {
  test(`${transition}: delayed auth provenance cannot dispatch or publish into a stale operation`, async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (result: AuthResult) => void;
    const auth = new Promise<AuthResult>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      protocol: "auto",
      resolveAuth: () => {
        started();
        return auth;
      },
    });
    const pending = h.run();
    await ready;
    if (transition === "cancel") h.controller.abort();
    else if (transition === "replacement") h.replaceSession();
    else if (transition === "settings") h.changeSettings();
    else if (transition === "model") {
      await h.mock.events.get("model_select")?.[0]({ type: "model_select", model: { ...model, id: "other" } }, h.ctx);
    } else await h.mock.events.get("session_shutdown")?.[0]({ type: "session_shutdown", reason: "reload" }, h.ctx);
    release({ auth: { apiKey: "fixture-chatgpt-access" }, source: "OAuth" });
    assert.deepEqual(await pending, { cancel: true });
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.entries, h.original);
    assert.deepEqual(h.notifications, []);
  });
}
