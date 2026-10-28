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
import { createCheckpointDetails, fallbackSummary, latestCheckpoint } from "../src/checkpoint.js";
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
async function fixture() {
  const name = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(name)) as { openaiProvider(): Provider };
  const provider = openaiProvider();
  const outputBudgets: (number | undefined)[] = [];
  const originalStream = provider.stream;
  provider.stream = (active, context, options) => {
    outputBudgets.push(options?.maxTokens);
    return originalStream(active, context, options);
  };
  const host = createMockPi();
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
  let reply = () => response();
  createCodexCompactExtension({
    settingsRuntime: runtime,
    fetch: async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return reply();
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
    outputBudgets,
    setReply: (value: () => Response) => {
      reply = value;
    },
  };
}

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

test("background thinking selection is captured and invalidated when changed", async () => {
  const h = await fixture();
  h.ctx.model = { ...model, reasoning: true, thinkingLevelMap: { max: "xhigh" } };
  h.host.rawPi.setThinkingLevel("max");
  const preparation = h.engine.capture(h.ctx);
  assert.ok(preparation);
  const prepared = await preparation.start(h.guard);
  assert.equal(prepared.usable, true, prepared.failure ?? "summary unavailable");
  assert.equal((h.payloads[0].reasoning as { effort?: string }).effort, "xhigh");
  h.host.rawPi.setThinkingLevel("high");
  assert.equal((await prepared.draft(h.ctx, h.guard)).draft, undefined);
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
