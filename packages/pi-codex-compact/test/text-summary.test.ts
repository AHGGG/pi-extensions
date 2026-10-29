import assert from "node:assert/strict";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  latestCheckpoint,
  parseCheckpointDetails,
} from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { COMPACTION_ENGINE_REQUEST, type CompactionEngineV1 } from "../src/prepared-compaction-protocol.js";
import { ScratchpadStore } from "../src/scratchpad-store.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";
import {
  activeCompactionId,
  matchedToolPairs,
  parseTextSummaryDetails,
  summaryFileOps,
  textSummaryCut,
} from "../src/text-summary.js";

const usage = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model: Model<"openai-responses"> = {
  id: "gpt-5.5",
  name: "Fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 12_000,
};
const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  stopReason: "stop",
  timestamp: 2,
});
function response(text = "Summary of the earlier task.") {
  const item = {
    type: "message",
    id: "summary",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
function checkpointResponse() {
  return Response.json({
    id: "compact-fixture",
    object: "response.compaction",
    output: [{ type: "compaction", encrypted_content: "provider-override-checkpoint" }],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
  });
}
async function fixture() {
  const name = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(name)) as { openaiProvider(): Provider };
  const provider = openaiProvider();
  const outputBudgets: (number | undefined)[] = [];
  let afterTerminal: (() => void) | undefined;
  const originalStream = provider.stream;
  provider.stream = (active, context, options) => {
    outputBudgets.push(options?.maxTokens);
    if (options) {
      const observe = options.onProviderStreamEvent;
      options.onProviderStreamEvent = (event, activeModel) => {
        void observe?.(event, activeModel);
        if (event && typeof event === "object" && "type" in event && event.type === "response.completed")
          afterTerminal?.();
      };
    }
    return originalStream(active, context, options);
  };
  const tool = {
    name: "read",
    description: "Original tool",
    parameters: { type: "object", properties: { path: { type: "string", description: "Original schema" } } },
  };
  const host = createMockPi({ activeTools: ["read"], allTools: [tool] });
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Earlier task", timestamp: 1 });
  const tailId = manager.appendMessage(assistant("Retained detail"));
  const settings: CodexCompactSettings = {
    ...DEFAULT_CODEX_COMPACT_SETTINGS,
    compactionMode: "text-summary" as const,
    maxRetries: 0,
  };
  const runtime: CodexCompactSettingsRuntime = {
    get: () => ({ kind: "loaded", path: "/unused", settings }),
    reload: async () => runtime.get(),
    update: async (patch) => {
      Object.assign(settings, patch);
      return runtime.get();
    },
    flush: async () => {},
  };
  const context = createMockContext({
    model: structuredClone(model),
    sessionManager: manager,
    getSystemPrompt: () => "Stable system",
    getContextUsage: () => ({ tokens: 65_000, contextWindow: 100_000, percent: 65 }),
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
      getProvider: () => provider,
      getProviderAuth: async () => ({ source: "API Key", auth: { apiKey: "fixture" } }),
    },
  });
  const payloads: Record<string, unknown>[] = [];
  const requestUrls: string[] = [];
  let reply: (signal?: AbortSignal | null) => Response | Promise<Response> = () => response();
  createCodexCompactExtension({
    settingsRuntime: runtime,
    fetch: async (input, init) => {
      requestUrls.push(input instanceof Request ? input.url : String(input));
      payloads.push(JSON.parse(String(init?.body)));
      return reply(init?.signal);
    },
  })(host.pi);
  const emit = async (type: string, event: unknown = {}) => {
    let result: unknown;
    for (const handler of host.events.get(type) ?? []) {
      const next = await handler(event, context.ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  await emit("session_start");
  let engine!: CompactionEngineV1;
  host.eventBus.emit(COMPACTION_ENGINE_REQUEST, {
    accept: (value: CompactionEngineV1) => {
      engine = value;
    },
  });
  const guard = { signal: new AbortController().signal, isCurrent: () => true, ownsStatus: () => true };
  const event = (): SessionBeforeCompactEvent => ({
    type: "session_before_compact",
    reason: "manual",
    willRetry: false,
    signal: guard.signal,
    branchEntries: manager.getBranch(),
    preparation: {
      firstKeptEntryId: tailId,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 65_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 0 },
    },
  });
  return {
    host,
    notifications: context.notifications,
    manager,
    tailId,
    settings,
    ctx: context.ctx as ExtensionContext,
    emit,
    engine,
    guard,
    event,
    payloads,
    requestUrls,
    outputBudgets,
    tool,
    setAfterTerminal: (callback: () => void) => {
      afterTerminal = callback;
    },
    setReply: (value: typeof reply) => {
      reply = value;
    },
  };
}

function useProviderOverrides(h: Awaited<ReturnType<typeof fixture>>) {
  h.ctx.model = { ...model, provider: "work-proxy", baseUrl: "https://proxy.example.test/v1" };
  h.settings.compactionMode = "provider-checkpoint";
  h.settings.protocol = "responses-compact";
  h.settings.providerOverrides = {
    "work-proxy": { compactionMode: "text-summary", protocol: "context-management" },
  };
}

for (const execution of ["foreground", "prepared"] as const) {
  test(`${execution} uses the custom provider's text-summary override instead of global checkpoint mode`, async () => {
    const h = await fixture();
    useProviderOverrides(h);
    assert.equal(h.engine.available(h.ctx), true);
    let details: unknown;
    if (execution === "foreground") {
      const result = (await h.emit("session_before_compact", h.event())) as {
        compaction?: { details: unknown };
      };
      details = result.compaction?.details;
    } else {
      const preparation = h.engine.capture(h.ctx);
      assert.ok(preparation);
      const prepared = await preparation.start(h.guard);
      assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
      details = (await prepared.draft(h.ctx, h.guard)).draft?.details;
    }
    assert.ok(parseTextSummaryDetails(details));
    assert.deepEqual(h.requestUrls, ["https://proxy.example.test/v1/responses"]);
    assert.doesNotMatch(JSON.stringify(h.payloads), /context_management|compaction_trigger|Retained detail/);
    assert.match(JSON.stringify(h.payloads), /Earlier task/);
    assert.equal(h.settings.compactionMode, "provider-checkpoint");
    assert.equal(h.settings.protocol, "responses-compact");
  });

  test(`${execution} uses the custom provider's checkpoint mode and protocol overrides together`, async () => {
    const h = await fixture();
    useProviderOverrides(h);
    h.settings.compactionMode = "text-summary";
    h.settings.protocol = "context-management";
    h.settings.providerOverrides["work-proxy"] = {
      compactionMode: "provider-checkpoint",
      protocol: "responses-compact",
    };
    h.setReply(checkpointResponse);
    let details: unknown;
    if (execution === "foreground") {
      const result = (await h.emit("session_before_compact", h.event())) as {
        compaction?: { details: unknown };
      };
      details = result.compaction?.details;
    } else {
      const preparation = h.engine.capture(h.ctx);
      assert.ok(preparation);
      const prepared = await preparation.start(h.guard);
      assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
      details = (await prepared.draft(h.ctx, h.guard)).draft?.details;
    }
    const checkpoint = parseCheckpointDetails(details);
    assert.ok(checkpoint);
    assert.equal(checkpoint.provider, "work-proxy");
    assert.equal(checkpoint.protocol, "responses-compact");
    assert.deepEqual(h.requestUrls, ["https://proxy.example.test/v1/responses/compact"]);
    assert.doesNotMatch(JSON.stringify(h.payloads), /context_management|compaction_trigger/);
  });
}

test("prepared summary survives unrelated provider edits and changes to overridden global defaults", async () => {
  const h = await fixture();
  useProviderOverrides(h);
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const prepared = await preparation.start(h.guard);
  assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
  h.settings.providerOverrides = {
    ...h.settings.providerOverrides,
    "unrelated-proxy": { compactionMode: "provider-checkpoint", protocol: "remote-v2" },
  };
  h.settings.compactionMode = "text-summary";
  h.settings.protocol = "auto";
  assert.equal(preparation.isCurrent(), true);
  const result = await prepared.draft(h.ctx, h.guard);
  assert.ok(result.draft, result.reason ?? "draft unavailable");
  assert.ok(parseTextSummaryDetails(result.draft.details));
  assert.equal(h.payloads.length, 1);
});

for (const change of ["mode", "protocol", "reset"] as const) {
  test(`changing the active provider ${change} invalidates a prepared summary without another request`, async () => {
    const h = await fixture();
    useProviderOverrides(h);
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const prepared = await preparation.start(h.guard);
    assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
    if (change === "reset") delete h.settings.providerOverrides["work-proxy"];
    else if (change === "mode") h.settings.providerOverrides["work-proxy"].compactionMode = "provider-checkpoint";
    else h.settings.providerOverrides["work-proxy"].protocol = "remote-v2";
    assert.equal(preparation.isCurrent(), false);
    assert.equal(preparation.reason, "compaction settings changed");
    const result = await prepared.draft(h.ctx, h.guard);
    assert.equal(result.draft, undefined);
    assert.equal(h.payloads.length, 1);
  });
}

test("switching providers invalidates the old preparation and selects global or provider-specific settings", async () => {
  const h = await fixture();
  useProviderOverrides(h);
  h.settings.providerOverrides["other-proxy"] = { compactionMode: "text-summary" };
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const prepared = await preparation.start(h.guard);
  assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
  const previousModel = h.ctx.model;
  h.ctx.model = structuredClone(model);
  await h.emit("model_select", { model: h.ctx.model, previousModel });
  assert.equal(preparation.isCurrent(), false);
  assert.equal((await prepared.draft(h.ctx, h.guard)).draft, undefined);
  h.setReply(checkpointResponse);
  const fallback = (await h.emit("session_before_compact", h.event())) as {
    compaction?: { details: unknown };
  };
  assert.equal(parseCheckpointDetails(fallback.compaction?.details)?.protocol, "responses-compact");
  h.ctx.model = { ...model, provider: "other-proxy", baseUrl: "https://other.example.test/v1" };
  await h.emit("model_select", { model: h.ctx.model, previousModel: model });
  h.setReply(() => response());
  const next = h.engine.capture(h.ctx);
  assert.ok(next);
  const nextPrepared = await next.start(h.guard);
  assert.equal(nextPrepared.usable, true, nextPrepared.failure ?? "preparation failed");
  assert.ok(parseTextSummaryDetails((await nextPrepared.draft(h.ctx, h.guard)).draft?.details));
  assert.deepEqual(h.requestUrls, [
    "https://proxy.example.test/v1/responses",
    "https://api.openai.com/v1/responses/compact",
    "https://other.example.test/v1/responses",
  ]);
});

test("provider selection aborts an in-flight foreground summary selected by its override", async () => {
  const h = await fixture();
  useProviderOverrides(h);
  let started!: (signal: AbortSignal | null | undefined) => void;
  const requestStarted = new Promise<AbortSignal | null | undefined>((resolve) => {
    started = resolve;
  });
  let release!: (value: Response) => void;
  const responseReady = new Promise<Response>((resolve) => {
    release = resolve;
  });
  h.setReply((signal) => {
    started(signal);
    return responseReady;
  });
  const pending = h.emit("session_before_compact", h.event());
  try {
    const signal = await requestStarted;
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    const previousModel = h.ctx.model;
    h.ctx.model = structuredClone(model);
    await h.emit("model_select", { model: h.ctx.model, previousModel });
    assert.equal(signal.aborted, true);
  } finally {
    release(response());
  }
  assert.deepEqual(await pending, { cancel: true });
  assert.equal(h.payloads.length, 1);
  assert.equal(
    h.manager.getBranch().some((entry) => entry.type === "compaction"),
    false,
  );
});

test("selecting text-summary for a provider preserves its existing opaque checkpoint until replacement", async () => {
  const h = await fixture();
  useProviderOverrides(h);
  const details = createCheckpointDetails({
    provider: "work-proxy",
    api: model.api,
    profile: "openai-responses-v1",
    modelId: model.id,
    protocol: "responses-compact",
    replacementHistory: [{ type: "compaction", encrypted_content: "existing-provider-checkpoint" }],
    keptMessages: h.manager.buildSessionContext().messages.slice(1),
  });
  h.manager.appendCompaction(fallbackSummary(details.checkpointId), h.tailId, 65_000, details, true);
  const payload = {
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: checkpointMarker(details.checkpointId) }] }],
  };
  const replay = await h.emit("before_provider_request", { payload });
  assert.match(JSON.stringify(replay), /existing-provider-checkpoint/);
  assert.doesNotMatch(JSON.stringify(replay), /PI_CODEX_REMOTE_CHECKPOINT/);
  assert.equal(h.engine.checkpointId(h.ctx), details.checkpointId);
  h.manager.appendMessage({ role: "user", content: "Continue after checkpoint", timestamp: 5 });
  h.manager.appendMessage(assistant("Latest retained detail"));
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const prepared = await preparation.start(h.guard);
  assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
  assert.match(JSON.stringify(h.payloads), /existing-provider-checkpoint/);
  assert.doesNotMatch(JSON.stringify(h.payloads), /context_management|compaction_trigger/);
  const { draft } = await prepared.draft(h.ctx, h.guard);
  assert.ok(draft);
  h.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 65_000, draft.details, true);
  assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
  assert.doesNotMatch(JSON.stringify(h.manager.buildSessionContext()), /existing-provider-checkpoint/);
});

test("direct foreground summary keeps native tail and persists plaintext identity", async () => {
  const h = await fixture();
  const result = (await h.emit("session_before_compact", h.event())) as {
    compaction: { summary: string; firstKeptEntryId: string; details: unknown; tokensBefore: number };
  };
  assert.ok(parseTextSummaryDetails(result.compaction.details));
  assert.equal(result.compaction.firstKeptEntryId, h.tailId);
  assert.equal(h.payloads.length, 1);
  assert.doesNotMatch(JSON.stringify(h.payloads), /context_management|compaction_trigger|Retained detail/);
  h.manager.appendCompaction(result.compaction.summary, h.tailId, 65_000, result.compaction.details, true);
  assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
  assert.equal(activeCompactionId(h.manager.getBranch()), h.engine.checkpointId(h.ctx));
  assert.equal(
    buildSessionContext(h.manager.getBranch()).messages.filter((message) => message.role === "assistant").length,
    1,
  );
  await h.emit("session_start");
  assert.equal(activeCompactionId(h.manager.getBranch()), h.engine.checkpointId(h.ctx));
  assert.equal(await h.emit("context", { messages: h.manager.buildSessionContext().messages }), undefined);
});

test("prepared text summary retains last tool group once and preserves appended tool results", async () => {
  const h = await fixture();
  const tool = {
    ...assistant(""),
    content: [{ type: "toolCall" as const, id: "read-call", name: "read", arguments: { path: "tail.ts" } }],
  };
  const toolId = h.manager.appendMessage(tool);
  h.manager.appendMessage({
    role: "toolResult",
    toolCallId: "read-call",
    toolName: "read",
    content: [{ type: "text", text: "file" }],
    isError: false,
    timestamp: 3,
  });
  const capture = h.engine.capture(h.ctx);
  assert.ok(capture);
  const prepared = await capture.start(h.guard);
  assert.equal(prepared.usable, true);
  assert.doesNotMatch(JSON.stringify(h.payloads), /tail.ts/);
  const drafted = await prepared.draft(h.ctx, h.guard);
  assert.ok(drafted.draft);
  assert.equal(drafted.draft.firstKeptEntryId, toolId);
  h.manager.appendCompaction(drafted.draft.summary, toolId, 65_000, drafted.draft.details, true);
  const messages = h.manager.buildSessionContext().messages;
  assert.equal(messages.filter((message) => message.role === "toolResult").length, 1);
  assert.ok(matchedToolPairs(messages));
  assert.equal(h.payloads.length, 1);
});

test("provider checkpoint converts to a prepared plaintext summary through the same provider", async () => {
  const h = await fixture();
  const details = createCheckpointDetails({
    provider: model.provider,
    api: model.api,
    profile: "openai-responses-v1",
    modelId: model.id,
    protocol: "context-management",
    replacementHistory: [{ type: "compaction", encrypted_content: "issuer-secret-history" }],
    keptMessages: h.manager.buildSessionContext().messages.slice(1),
  });
  h.manager.appendCompaction(fallbackSummary(details.checkpointId), h.tailId, 65_000, details, true);
  h.manager.appendMessage({ role: "user", content: "New task after old checkpoint", timestamp: 5 });
  h.manager.appendMessage(assistant("Newest detail"));
  const capture = h.engine.capture(h.ctx);
  assert.ok(capture);
  const prepared = await capture.start(h.guard);
  assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
  assert.match(JSON.stringify(h.payloads), /issuer-secret-history/);
  assert.doesNotMatch(JSON.stringify(h.payloads), /PI_CODEX_REMOTE_CHECKPOINT|context_management|compaction_trigger/);
  const result = await prepared.draft(h.ctx, h.guard);
  assert.ok(result.draft, result.reason ?? "draft unavailable");
  h.manager.appendCompaction(result.draft.summary, result.draft.firstKeptEntryId, 65_000, result.draft.details, true);
  assert.equal(latestCheckpoint(h.manager.getBranch()), undefined);
  assert.doesNotMatch(
    JSON.stringify(h.manager.buildSessionContext()),
    /issuer-secret-history|PI_CODEX_REMOTE_CHECKPOINT/,
  );
});

test("summary output budget and unsupported APIs fail closed without native fallback", async () => {
  const h = await fixture();
  h.settings.replacementTokenBudget = 8_000;
  h.setReply(() => response("x".repeat(33_000)));
  assert.deepEqual(await h.emit("session_before_compact", h.event()), { cancel: true });
  assert.equal(h.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  h.ctx.model = { ...model, api: "anthropic-messages" };
  assert.equal(h.engine.available(h.ctx), false);
  assert.deepEqual(await h.emit("session_before_compact", h.event()), { cancel: true });
  assert.equal(h.payloads.length, 1);
});

test("file metadata includes previous summary and nested read/write/edit calls", () => {
  const manager = SessionManager.inMemory();
  const id = manager.appendMessage({ role: "user", content: "task", timestamp: 1 });
  manager.appendCompaction("older", id, 1, { readFiles: ["old.ts"], modifiedFiles: ["prior.ts"] }, true);
  const message = {
    ...assistant(""),
    content: [{ type: "toolCall" as const, id: "read", name: "read", arguments: { path: "new.ts" } }],
  };
  const nested = {
    role: "toolResult",
    toolCallId: "code",
    toolName: "code",
    content: [],
    timestamp: 1,
    isError: false,
    nestedCalls: { calls: [{ name: "edit", arguments: { path: "edited.ts" } }] },
  } as never;
  const ops = summaryFileOps([message, nested], manager.getBranch());
  assert.deepEqual([...ops.read], ["old.ts", "new.ts"]);
  assert.deepEqual([...ops.edited], ["prior.ts", "edited.ts"]);
  assert.equal(matchedToolPairs([nested]), false);
  assert.equal(textSummaryCut([], []), undefined);
  assert.equal(parseTextSummaryDetails({ kind: "pi-codex-text-summary", version: 1, resultId: "x" }), undefined);
});

for (const appendMaintenanceMessage of [true, false]) {
  test(`direct summary captures scratchpad once (append=${appendMaintenanceMessage})`, async () => {
    const read = vi
      .spyOn(ScratchpadStore.prototype, "readSnapshot")
      .mockResolvedValue([
        { id: 1, text: "Stable scratchpad fact", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" },
      ]);
    const h = await fixture();
    h.settings.scratchpadEnabled = true;
    h.settings.appendMaintenanceMessage = appendMaintenanceMessage;
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const prepared = await preparation.start(h.guard);
    assert.equal(prepared.usable, true);
    read.mockResolvedValue([
      { id: 1, text: "Changed later", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:01Z" },
    ]);
    const drafted = await prepared.draft(h.ctx, h.guard);
    assert.ok(drafted.draft);
    const payload = JSON.stringify(h.payloads);
    assert.equal(payload.split("Stable scratchpad fact").length - 1, appendMaintenanceMessage ? 1 : 0);
    assert.doesNotMatch(payload, /Changed later/);
    assert.match(payload, /Summarize the preceding conversation/);
    assert.equal(read.mock.calls.length, appendMaintenanceMessage ? 1 : 0);
  });
}

test("text result survives a fresh session projection and old opaque ID does not return", async () => {
  const h = await fixture();
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const prepared = await preparation.start(h.guard);
  const { draft } = await prepared.draft(h.ctx, h.guard);
  assert.ok(draft);
  h.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 65_000, draft.details, true);
  const header = h.manager.getHeader();
  assert.ok(header);
  const saved = JSON.parse(JSON.stringify([header, ...h.manager.getBranch()]));
  const reloaded = SessionManager.inMemory(h.ctx.cwd, undefined, saved);
  assert.equal(h.engine.checkpointId({ ...h.ctx, sessionManager: reloaded }), prepared.checkpointId);
  assert.equal(reloaded.buildSessionContext().messages[0].role, "compactionSummary");
  reloaded.appendCompaction("Native summary", draft.firstKeptEntryId, 1, {}, false);
  assert.equal(h.engine.checkpointId({ ...h.ctx, sessionManager: reloaded }), undefined);
});

test("a rejected checkpoint endpoint does not disable direct text summary inference", async () => {
  const h = await fixture();
  h.settings.compactionMode = "provider-checkpoint";
  h.setReply(() =>
    Response.json(
      { error: { code: "hardened_oauth_rule_missing", type: "rejected_by_hardened_oauth_boundary" } },
      { status: 403 },
    ),
  );
  await h.emit("session_before_compact", h.event());
  h.settings.compactionMode = "text-summary";
  h.setReply(() => response());
  assert.equal(h.engine.available(h.ctx), true);
  const result = (await h.emit("session_before_compact", h.event())) as { compaction?: { details: unknown } };
  assert.ok(parseTextSummaryDetails(result?.compaction?.details));
});

test("too-small model output limit cancels before spending a summary request", async () => {
  const h = await fixture();
  h.ctx.model = { ...model, maxTokens: 1 };
  assert.deepEqual(await h.emit("session_before_compact", h.event()), { cancel: true });
  assert.equal(h.payloads.length, 0);
});

test("small-context model can prepare and apply with bounded reserve", async () => {
  const h = await fixture();
  h.ctx.model = { ...model, contextWindow: 8192, maxTokens: 8192 };
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const prepared = await preparation.start(h.guard);
  assert.equal(prepared.usable, true, prepared.failure ?? "summary unavailable");
  const result = await prepared.draft(h.ctx, h.guard);
  assert.ok(result.draft, result.reason ?? "draft unavailable");
  assert.equal(h.payloads.length, 1);
  assert.ok(Number(h.outputBudgets[0]) <= 2048);
});

test("background thinking selection is captured without invalidating a completed text summary", async () => {
  const h = await fixture();
  h.ctx.model = { ...model, reasoning: true, thinkingLevelMap: { max: "xhigh" } };
  h.host.rawPi.setThinkingLevel("max");
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const prepared = await preparation.start(h.guard);
  assert.equal(prepared.usable, true, prepared.failure ?? "summary unavailable");
  assert.equal((h.payloads[0].reasoning as { effort?: string }).effort, "xhigh");
  h.host.rawPi.setThinkingLevel("high");
  h.manager.appendThinkingLevelChange("high");
  await h.emit("thinking_level_select", { thinkingLevel: "high" });
  assert.equal(preparation.isCurrent(), true);
  assert.ok((await prepared.draft(h.ctx, h.guard)).draft);
  assert.equal(h.payloads.length, 1);
});

test("text summary HTTP errors report safe status without provider response content", async () => {
  const h = await fixture();
  h.ctx.hasUI = true;
  h.setReply(() => Response.json({ error: { message: "SECRET prompt and bearer fixture" } }, { status: 400 }));
  assert.deepEqual(await h.emit("session_before_compact", h.event()), { cancel: true });
  const logs = JSON.stringify(h.notifications);
  assert.match(logs, /HTTP 400: request rejected/);
  assert.doesNotMatch(logs, /SECRET|bearer fixture/);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const phase of ["captured", "binding", "request", "ready"] as const) {
  test(`text summary survives prompt, tool, and thinking changes while ${phase}`, async () => {
    const h = await fixture();
    h.ctx.model = { ...model, reasoning: true, thinkingLevelMap: { max: "xhigh" } };
    h.host.rawPi.setThinkingLevel("max");
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const started = deferred<void>();
    const release = deferred<void>();
    if (phase === "binding") {
      h.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
        started.resolve();
        await release.promise;
        return { ok: true, apiKey: "fixture" };
      };
    }
    if (phase === "request")
      h.setReply(async () => {
        started.resolve();
        await release.promise;
        return response();
      });
    const mutate = async () => {
      h.ctx.getSystemPrompt = () => "New instructions after capture";
      h.tool.description = "Changed tool";
      h.tool.parameters.properties.path.description = "Changed nested schema";
      h.host.rawPi.setActiveTools([]);
      h.host.rawPi.setThinkingLevel("high");
      h.manager.appendThinkingLevelChange("high");
      await h.emit("thinking_level_select", { thinkingLevel: "high" });
    };
    if (phase === "captured") await mutate();
    const pending = preparation.start(h.guard);
    if (phase === "binding" || phase === "request") {
      await started.promise;
      await mutate();
      release.resolve();
    }
    const prepared = await pending;
    assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
    if (phase === "ready") await mutate();
    assert.equal(preparation.isCurrent(), true, preparation.reason ?? "preparation stale");
    const drafted = await prepared.draft(h.ctx, h.guard);
    assert.ok(drafted.draft, drafted.reason ?? "draft unavailable");
    assert.equal(h.payloads.length, 1);
    const input = JSON.stringify(h.payloads[0]);
    assert.match(input, /Stable system/);
    assert.match(input, /Original tool/);
    assert.match(input, /Original schema/);
    assert.doesNotMatch(input, /New instructions|Changed tool|Changed nested/);
    assert.equal((h.payloads[0].reasoning as { effort?: string }).effort, "xhigh");
  });
}

test("foreground text summary survives in-flight prompt, tool, and thinking changes", async () => {
  const h = await fixture();
  const started = deferred<void>();
  const release = deferred<void>();
  h.setReply(async () => {
    started.resolve();
    await release.promise;
    return response();
  });
  const pending = h.emit("session_before_compact", h.event());
  await started.promise;
  h.ctx.getSystemPrompt = () => "New foreground instructions";
  h.host.rawPi.setActiveTools([]);
  h.host.rawPi.setThinkingLevel("high");
  h.manager.appendThinkingLevelChange("high");
  await h.emit("thinking_level_select", { thinkingLevel: "high" });
  release.resolve();
  const result = (await pending) as { compaction?: { details: unknown } };
  assert.ok(parseTextSummaryDetails(result.compaction?.details));
  assert.equal(h.payloads.length, 1);
});

for (const mutation of ["prompt", "tools"] as const) {
  test(`prepared text summary uses the current ${mutation} overhead for its application budget`, async () => {
    const h = await fixture();
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const prepared = await preparation.start(h.guard);
    if (mutation === "prompt") h.ctx.getSystemPrompt = () => "x".repeat(400_000);
    else h.tool.parameters.properties.path.description = "x".repeat(400_000);
    assert.equal(preparation.isCurrent(), true);
    const drafted = await prepared.draft(h.ctx, h.guard);
    assert.equal(drafted.draft, undefined);
    assert.equal(drafted.failure, true);
    assert.match(drafted.reason ?? "", /token budget exceeded/);
    assert.equal(h.payloads.length, 1);
  });
}

test("foreground final handoff rechecks current overhead after reentrant status cleanup", async () => {
  const h = await fixture();
  h.ctx.hasUI = true;
  let cleared = 0;
  h.ctx.ui.setStatus = (_key, value) => {
    if (value === undefined && ++cleared === 2) h.ctx.getSystemPrompt = () => "x".repeat(400_000);
  };
  assert.deepEqual(await h.emit("session_before_compact", h.event()), { cancel: true });
  assert.equal(cleared, 2);
  assert.match(JSON.stringify(h.notifications), /current context token budget exceeded at final handoff/);
  assert.equal(h.payloads.length, 1);
});

test("successful summary invalidated after its terminal response reports discarded, not failed/none", async () => {
  const h = await fixture();
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  h.setAfterTerminal(() =>
    h.manager.appendContextEdit(h.manager.getBranch()[0].id, { content: "SECRET changed history" }),
  );
  const prepared = await preparation.start(h.guard);
  assert.equal(prepared.usable, false);
  const diagnostic = preparation.diagnostics?.();
  assert.equal(diagnostic?.outcome, "discarded");
  assert.equal(diagnostic?.reason, "text summary ownership or captured history changed");
  assert.match(
    diagnostic?.report ?? "",
    /outcome=discarded failure=text summary ownership or captured history changed/,
  );
  assert.doesNotMatch(diagnostic?.report ?? "", /outcome=failed failure=none|SECRET changed history/);
  assert.equal(h.payloads.length, 1);
});

test("cancelled summary retains a terminal cancellation diagnostic without a failed disposition", async () => {
  const h = await fixture();
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const controller = new AbortController();
  const started = deferred<void>();
  const release = deferred<void>();
  h.setReply(async () => {
    started.resolve();
    await release.promise;
    return response();
  });
  const pending = preparation.start({ ...h.guard, signal: controller.signal });
  await started.promise;
  controller.abort();
  release.resolve();
  const prepared = await pending;
  assert.equal(prepared.usable, false);
  assert.equal(preparation.diagnostics?.().outcome, "cancelled");
  assert.equal(preparation.diagnostics?.().reason, "text summary operation was cancelled");
});

for (const change of ["model", "provider", "mode", "disable", "history", "session"] as const) {
  test(`text summary still rejects ${change} changes after becoming ready`, async () => {
    const h = await fixture();
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const prepared = await preparation.start(h.guard);
    if (change === "model") h.ctx.model = { ...model, id: "other" };
    if (change === "provider") h.ctx.model = { ...model, provider: "other" };
    if (change === "mode") h.settings.compactionMode = "provider-checkpoint";
    if (change === "disable") h.settings.enabled = false;
    if (change === "history") h.manager.appendContextEdit(h.manager.getBranch()[0].id, { content: "Edited history" });
    if (change === "session") await h.emit("session_start");
    assert.equal(preparation.isCurrent(), false);
    assert.equal((await prepared.draft(h.ctx, h.guard)).draft, undefined);
    assert.equal(h.payloads.length, 1);
  });
}

for (const boundary of ["adopt", "draft"] as const) {
  test(`thinking metadata during application auth is ${boundary === "adopt" ? "accepted for foreground reuse" : "rejected at an exact draft boundary"}`, async () => {
    const h = await fixture();
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const prepared = await preparation.start(h.guard);
    const auth = deferred<void>();
    const release = deferred<void>();
    h.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
      auth.resolve();
      await release.promise;
      return { ok: true, apiKey: "fixture" };
    };
    const pending = boundary === "adopt" ? prepared.adopt(h.event(), h.ctx, h.guard) : prepared.draft(h.ctx, h.guard);
    await auth.promise;
    h.host.rawPi.setThinkingLevel("high");
    h.manager.appendThinkingLevelChange("high");
    await h.emit("thinking_level_select", { thinkingLevel: "high" });
    release.resolve();
    const result = await pending;
    if ("kind" in result) assert.equal(result.kind, "ready");
    else assert.equal(result.draft, undefined);
    assert.equal(h.payloads.length, 1);
  });
}

for (const callback of ["status", "notification"] as const) {
  test(`reentrant ${callback} invalidation returns an unusable discarded result`, async () => {
    const h = await fixture();
    h.ctx.hasUI = true;
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const invalidate = () => h.manager.appendContextEdit(h.manager.getBranch()[0].id, { content: "Changed" });
    if (callback === "status")
      h.ctx.ui.setStatus = (_key, value) => {
        if (value === undefined) invalidate();
      };
    else h.ctx.ui.notify = invalidate;
    const prepared = await preparation.start(h.guard);
    assert.equal(prepared.usable, false);
    assert.equal(preparation.diagnostics?.().outcome, "discarded");
    assert.equal(h.payloads.length, 1);
  });
}

test("in-flight local invalidation remains discarded when the provider wraps its abort", async () => {
  const h = await fixture();
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const started = deferred<void>();
  const release = deferred<void>();
  h.setReply(async () => {
    started.resolve();
    await release.promise;
    return response();
  });
  const pending = preparation.start(h.guard);
  await started.promise;
  h.manager.appendContextEdit(h.manager.getBranch()[0].id, { content: "Changed" });
  release.resolve();
  assert.equal((await pending).usable, false);
  assert.equal(preparation.diagnostics?.().outcome, "discarded");
  assert.equal(preparation.diagnostics?.().reason, "text summary ownership or captured history changed");
});

test("a completed HTTP rejection remains a safe failure if history became stale", async () => {
  const h = await fixture();
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  h.setReply(() => {
    h.manager.appendContextEdit(h.manager.getBranch()[0].id, { content: "Changed" });
    return Response.json({ error: "SECRET" }, { status: 400 });
  });
  assert.equal((await preparation.start(h.guard)).usable, false);
  assert.equal(preparation.diagnostics?.().outcome, "failed");
  assert.equal(preparation.diagnostics?.().reason, "HTTP 400: request rejected");
  assert.doesNotMatch(preparation.diagnostics?.().report ?? "", /SECRET/);
});

for (const boundary of ["adopt", "draft"] as const) {
  test(`${boundary} rechecks current budget after session preview callbacks`, async () => {
    const h = await fixture();
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const prepared = await preparation.start(h.guard);
    const getHeader = h.manager.getHeader.bind(h.manager);
    let previews = 0;
    h.manager.getHeader = () => {
      if (++previews === (boundary === "draft" ? 2 : 1)) h.ctx.getSystemPrompt = () => "x".repeat(400_000);
      return getHeader();
    };
    const result =
      boundary === "adopt" ? await prepared.adopt(h.event(), h.ctx, h.guard) : await prepared.draft(h.ctx, h.guard);
    if ("kind" in result) {
      assert.equal(result.kind, "stale");
      assert.ok(result.kind === "stale");
      assert.match(result.reason, /token budget exceeded/);
    } else {
      assert.equal(result.draft, undefined);
      assert.match(result.reason ?? "", /token budget exceeded/);
    }
    assert.equal(h.payloads.length, 1);
  });
}

test("application budgets use the fresh boundary context rather than its captured context object", async () => {
  const h = await fixture();
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const prepared = await preparation.start(h.guard);
  const ctx = { ...h.ctx, getSystemPrompt: () => "x".repeat(400_000) };
  const result = await prepared.draft(ctx, h.guard);
  assert.equal(result.draft, undefined);
  assert.match(result.reason ?? "", /token budget exceeded/);
  assert.equal(h.payloads.length, 1);
});

test("a prepared source cannot return opaque history under Text summary's relaxed guards", async () => {
  const h = await fixture();
  const details = createCheckpointDetails({
    provider: model.provider,
    api: model.api,
    profile: "openai-responses-v1",
    modelId: model.id,
    protocol: "responses-compact",
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
    keptMessages: h.manager.buildSessionContext().messages.slice(1),
  });
  h.engine.attachSource({
    beforeCompact: async () => {
      h.ctx.getSystemPrompt = () => "Changed instructions";
      return {
        kind: "ready",
        result: {
          compaction: {
            summary: fallbackSummary(details.checkpointId),
            details,
            firstKeptEntryId: h.tailId,
            tokensBefore: 65_000,
          },
        },
      };
    },
  });
  assert.deepEqual(await h.emit("session_before_compact", h.event()), { cancel: true });
  assert.equal(h.payloads.length, 0);
});
