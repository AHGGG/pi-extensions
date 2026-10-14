import assert from "node:assert/strict";
import type { Model, Provider } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { checkpointMarker, createCheckpointDetails, fallbackSummary } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";

const rejection = {
  message: "This ChatPass credential is not authorized for the requested operation.",
  type: "rejected_by_hardened_oauth_boundary",
  code: "hardened_oauth_rule_missing",
  param: null,
};
const model: Model<"openai-responses"> = {
  id: "gpt-5.5",
  name: "GPT-5.5 fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};

async function providerFor(): Promise<Provider> {
  // This provider subpath has no Pi AI root export; Pi can misresolve static subpath imports.
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const module = (await import(specifier)) as { openaiProvider: () => Provider };
  return module.openaiProvider();
}

function runtime(overrides: Partial<CodexCompactSettings>): CodexCompactSettingsRuntime {
  const state = {
    kind: "loaded" as const,
    path: "/tmp/unused-codex-compact.json",
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, ...overrides },
    document: {},
  };
  return {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async () => structuredClone(state),
    flush: async () => {},
  };
}

function branch(): SessionEntry[] {
  const entry: SessionEntry = {
    type: "message",
    id: "user",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "synthetic history" }], timestamp: 1 },
  };
  const details = createCheckpointDetails({
    provider: model.provider,
    api: model.api,
    profile: "openai-responses-v1",
    modelId: model.id,
    protocol: "responses-compact",
    checkpointId: "existing-checkpoint",
    replacementHistory: [{ type: "compaction", encrypted_content: "existing-opaque" }],
    keptMessages: [entry.message],
  });
  return [
    entry,
    {
      type: "compaction",
      id: "compact",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      summary: fallbackSummary(details.checkpointId),
      firstKeptEntryId: "user",
      tokensBefore: 123,
      details,
    },
  ];
}

function event(entries: SessionEntry[], signal: AbortSignal): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "user",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 123,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: entries,
    reason: "manual",
    willRetry: false,
    signal,
  };
}

async function harness(
  options: {
    settings?: Partial<CodexCompactSettings>;
    withCheckpoint?: boolean;
    fetch?: typeof globalThis.fetch;
    mode?: "tui" | "rpc" | "print" | "json";
    body?: unknown;
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  } = {},
) {
  const provider = await providerFor();
  assert.ok(provider.auth.oauth);
  const auth = await provider.auth.oauth.toAuth({
    type: "oauth",
    access: options.apiKey ?? "synthetic-oauth-access",
    refresh: "synthetic-refresh-not-used",
    expires: Date.now() + 3_600_000,
  });
  const entries = options.withCheckpoint ? branch() : branch().slice(0, 1);
  const original = structuredClone(entries);
  const requests: string[] = [];
  const mock = createMockPi();
  createCodexCompactExtension({
    settingsRuntime: runtime(options.settings ?? {}),
    fetch: async (input, init) => {
      requests.push(String(input));
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${auth.apiKey}`);
      return options.fetch
        ? options.fetch(input, init)
        : Response.json({ error: options.body ?? rejection }, { status: 401 });
    },
  })(mock.pi);
  let sessionId = "session";
  const context = createMockContext({
    model,
    mode: options.mode ?? "tui",
    getSystemPrompt: () => "synthetic system prompt",
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, ...auth, headers: options.headers, env: options.env }),
      getProvider: () => provider,
      isUsingOAuth: () => assert.fail("credential snapshots must not determine routing or diagnosis"),
    },
  });
  context.statuses.set("other-extension", "keep me");
  const controller = new AbortController();
  const handler = mock.events.get("session_before_compact")?.[0];
  assert.ok(handler);
  return {
    ...context,
    mock,
    entries,
    original,
    requests,
    controller,
    run: () => handler(event(entries, controller.signal), context.ctx),
    setResolvedKey: (apiKey: string) => {
      auth.apiKey = apiKey;
    },
    replaceSession: () => {
      sessionId = "replacement";
    },
  };
}

for (const protocol of ["auto", "responses-compact", "remote-v2"] as const) {
  test(`${protocol}: real OpenAI adapter's HTTP 401 cancels unsafe native handoff and preserves checkpoint`, async () => {
    const h = await harness({
      withCheckpoint: true,
      settings: { protocol, maxRetries: 2, checkpointRecovery: "cancel" },
    });
    assert.deepEqual(await h.run(), { cancel: true }, "opaque history is not handed to native text-only compaction");
    assert.deepEqual(
      h.requests,
      [
        protocol === "remote-v2"
          ? "https://api.openai.com/v1/responses"
          : "https://api.openai.com/v1/responses/compact",
      ],
      "neither permission retries nor automatic alternate-protocol requests",
    );
    assert.deepEqual(h.entries, h.original);
    assert.deepEqual(h.mock.entries, []);
    assert.equal(h.statuses.get("codex-compact"), undefined);
    assert.equal(h.statuses.get("other-extension"), "keep me");
    assert.equal(h.notifications.length, 1);
    const notice = h.notifications[0];
    assert.equal(notice.level, "warning");
    assert.match(notice.message, /ChatGPT OAuth.*not authorized.*compaction operation/);
    assert.match(notice.message, /Without a checkpoint, using Pi compaction/);
    assert.match(notice.message, /hardened_oauth_rule_missing/);
    assert.match(notice.message, /rejected_by_hardened_oauth_boundary/);
    assert.match(notice.message, /route is paused for this session/);
    assert.match(notice.message, /Compatible checkpoint replay remains enabled/);
    assert.doesNotMatch(notice.message, /upgrade|expired|broken|synthetic-oauth-access|synthetic-refresh/);

    const replay = await h.mock.events.get("before_provider_request")?.[0](
      {
        type: "before_provider_request",
        payload: {
          input: [{ role: "user", content: [{ type: "input_text", text: checkpointMarker("existing-checkpoint") }] }],
        },
      },
      h.ctx,
    );
    assert.deepEqual(replay, { input: [{ type: "compaction", encrypted_content: "existing-opaque" }] });
  });
}

for (const reason of ["reload", "resume", "fork"] as const) {
  test(`${reason}: persisted replay survives rejection, a fresh factory, and changed resolved credentials`, async () => {
    const h = await harness({ withCheckpoint: true, settings: { checkpointRecovery: "cancel" } });
    assert.deepEqual(await h.run(), { cancel: true });
    h.setResolvedKey("sk-synthetic-api-key");
    assert.deepEqual(await h.run(), { cancel: true }, "rejected route cancels while preserving checkpoint replay");
    const fresh = createMockPi();
    createCodexCompactExtension({ settingsRuntime: runtime({}) })(fresh.pi);
    await fresh.events.get("session_start")?.[0]({ type: "session_start", reason }, h.ctx);
    const replay = fresh.events.get("before_provider_request")?.[0];
    assert.ok(replay);
    const first = (await replay(
      {
        type: "before_provider_request",
        payload: {
          input: [
            { role: "user", content: [{ type: "input_text", text: checkpointMarker("existing-checkpoint") }] },
            { role: "user", content: [{ type: "input_text", text: "ordinary turn" }] },
          ],
        },
      },
      h.ctx,
    )) as { input: unknown[] };
    const later = { role: "user", content: [{ type: "input_text", text: "new tail" }] };
    const second = (await replay(
      {
        type: "before_provider_request",
        payload: {
          input: [
            { role: "user", content: [{ type: "input_text", text: checkpointMarker("existing-checkpoint") }] },
            { role: "user", content: [{ type: "input_text", text: "ordinary turn" }] },
            later,
          ],
        },
      },
      h.ctx,
    )) as { input: unknown[] };
    assert.deepEqual(first.input[0], { type: "compaction", encrypted_content: "existing-opaque" });
    assert.deepEqual(second.input, [...first.input, later]);
    assert.deepEqual(h.entries, h.original);
    assert.equal(h.requests.length, 1, "rejected attempts and replay do not probe auth or backend capabilities");
  });
}

for (const mode of ["tui", "rpc", "print", "json"] as const) {
  test(`${mode}: fallback notification respects UI availability and notifyOnFallback`, async () => {
    for (const notifyOnFallback of [true, false]) {
      const h = await harness({ mode, settings: { notifyOnFallback } });
      assert.equal(await h.run(), undefined);
      assert.equal(h.notifications.length, notifyOnFallback && (mode === "tui" || mode === "rpc") ? 1 : 0);
    }
  });
}

test("fallback redacts resolved request credentials before terminal sanitization", async () => {
  const apiKey = 'synthetic-"secret\\with-controls';
  const headerSecret = "header-owned-secret";
  const envSecret = "provider-env-secret";
  const h = await harness({
    apiKey,
    headers: { "x-provider-token": headerSecret },
    env: { PROVIDER_TOKEN: envSecret },
    body: { ...rejection, message: `echo ${apiKey} ${headerSecret} ${envSecret}\u001b[31m` },
  });
  assert.equal(await h.run(), undefined);
  const notice = h.notifications[0]?.message ?? "";
  assert.match(notice, /\[redacted\]/);
  assert.doesNotMatch(notice, /synthetic-|header-owned-secret|provider-env-secret/);
  assert.equal(
    [...notice].every((char) => char.charCodeAt(0) >= 32 && !(char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)),
    true,
  );
  assert.match(notice, /hardened_oauth_rule_missing/);
});

for (const body of [
  { ...rejection, code: "another_error" },
  { ...rejection, type: "another_boundary" },
  { message: `mentions ${rejection.code} and ${rejection.type}` },
  rejection.code,
]) {
  test(`unrelated rejection remains a generic fallback: ${JSON.stringify(body)}`, async () => {
    const h = await harness({ body });
    assert.equal(await h.run(), undefined);
    assert.match(h.notifications[0]?.message ?? "", /Responses compaction failed; using Pi compaction/);
    assert.doesNotMatch(h.notifications[0]?.message ?? "", /ChatGPT OAuth.*not authorized/);
  });
}

for (const transition of ["cancel", "replacement", "shutdown"] as const) {
  test(`${transition}: delayed HTTP rejection cannot notify or publish into a stale session`, async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      fetch: async () => {
        started();
        return response;
      },
    });
    const pending = h.run();
    await ready;
    if (transition === "cancel") h.controller.abort();
    else if (transition === "replacement") h.replaceSession();
    else await h.mock.events.get("session_shutdown")?.[0]({ type: "session_shutdown", reason: "reload" }, h.ctx);
    if (transition === "replacement") h.statuses.set("codex-compact", "replacement owns this");
    release(Response.json({ error: rejection }, { status: 401 }));
    assert.deepEqual(await pending, { cancel: true });
    assert.deepEqual(h.notifications, []);
    assert.deepEqual(h.entries, h.original);
    assert.equal(h.statuses.get("codex-compact"), transition === "replacement" ? "replacement owns this" : undefined);
    assert.equal(h.statuses.get("other-extension"), "keep me");
  });
}
