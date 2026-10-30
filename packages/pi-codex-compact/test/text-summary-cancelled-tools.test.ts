import assert from "node:assert/strict";
import type { AssistantMessage, Model, Provider, ToolResultMessage } from "@earendil-works/pi-ai";
import { type ExtensionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { COMPACTION_ENGINE_REQUEST, type CompactionEngineV1 } from "../src/prepared-compaction-protocol.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";
import { matchedToolPairs, parseTextSummaryDetails } from "../src/text-summary.js";

const model: Model<"openai-responses"> = {
  id: "cancelled-tools-fixture",
  name: "Fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 12_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: 2,
  };
}
function call(stopReason: AssistantMessage["stopReason"], id = "cancelled-call"): AssistantMessage {
  return { ...assistant(""), stopReason, content: [{ type: "toolCall", id, name: "code", arguments: {} }] };
}
function result(id: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "code",
    content: [{ type: "text", text: "Tool execution cancelled" }],
    isError: true,
    timestamp: 3,
  };
}
async function fixture() {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
  const provider = openaiProvider();
  const host = createMockPi();
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Earlier task", timestamp: 1 });
  const tailId = manager.appendMessage(assistant("Retained detail"));
  const settings: CodexCompactSettings = {
    ...DEFAULT_CODEX_COMPACT_SETTINGS,
    compactionMode: "text-summary",
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
  const payloads: unknown[] = [];
  createCodexCompactExtension({
    settingsRuntime: runtime,
    fetch: async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      const item = {
        type: "message",
        id: "summary",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Summary of earlier task.", annotations: [] }],
      };
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
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
  host.eventBus.emit(COMPACTION_ENGINE_REQUEST, { accept: (value: CompactionEngineV1) => (engine = value) });
  const guard = { signal: new AbortController().signal, isCurrent: () => true, ownsStatus: () => true };
  const event = (firstKeptEntryId = tailId): SessionBeforeCompactEvent => ({
    type: "session_before_compact",
    reason: "manual",
    willRetry: false,
    signal: guard.signal,
    branchEntries: manager.getBranch(),
    preparation: {
      firstKeptEntryId,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 65_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 0 },
    },
  });
  return { manager, tailId, settings, ctx: context.ctx as ExtensionContext, payloads, emit, engine, guard, event };
}

for (const stopReason of ["aborted", "error"] as const) {
  for (const location of ["prefix", "retained"] as const) {
    test(`manual text summary accepts ${stopReason} tool attempt in ${location} without editing history`, async () => {
      const h = await fixture();
      const failedId = h.manager.appendMessage(call(stopReason));
      const keptId = location === "prefix" ? h.manager.appendMessage(assistant("Newest detail")) : failedId;
      const before = JSON.stringify(h.manager.getBranch());
      const outcome = (await h.emit("session_before_compact", h.event(keptId))) as {
        compaction?: { details: unknown; firstKeptEntryId: string };
      };
      assert.ok(parseTextSummaryDetails(outcome.compaction?.details));
      assert.equal(outcome.compaction?.firstKeptEntryId, keptId);
      assert.equal(h.payloads.length, 1);
      assert.doesNotMatch(JSON.stringify(h.payloads), /cancelled-call|No result provided/);
      assert.equal(JSON.stringify(h.manager.getBranch()), before);
    });
  }

  for (const location of ["prefix", "retained", "suffix"] as const) {
    for (const boundary of ["adopt", "draft"] as const) {
      test(`prepared ${boundary} accepts ${stopReason} tool attempt in ${location} and preserves the raw tail`, async () => {
        const h = await fixture();
        if (location !== "suffix") h.manager.appendMessage(call(stopReason));
        if (location === "prefix") h.manager.appendMessage(assistant("Newest detail"));
        const preparation = h.engine.capture(h.ctx);
        assert.ok(preparation);
        const prepared = await preparation.start(h.guard);
        assert.equal(prepared.usable, true, prepared.failure ?? "preparation unavailable");
        if (location === "suffix") h.manager.appendMessage(call(stopReason));
        const before = JSON.stringify(h.manager.getBranch());
        const draft =
          boundary === "draft"
            ? (await prepared.draft(h.ctx, h.guard)).draft
            : await prepared.adopt(h.event(), h.ctx, h.guard).then((outcome) => {
                assert.equal(outcome.kind, "ready");
                return outcome.kind === "ready" ? outcome.result.compaction : undefined;
              });
        assert.ok(draft);
        assert.equal(h.payloads.length, 1);
        assert.doesNotMatch(JSON.stringify(h.payloads), /cancelled-call|No result provided/);
        assert.equal(JSON.stringify(h.manager.getBranch()), before);
        const entries = h.manager.getBranch();
        const expected = entries
          .slice(entries.findIndex((entry) => entry.id === draft.firstKeptEntryId))
          .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
        h.manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 65_000, draft.details, true);
        assert.deepEqual(h.manager.buildSessionContext().messages.slice(1), expected);
      });
    }
  }

  test(`opaque checkpoint preparation still rejects ${stopReason} unmatched calls`, async () => {
    const h = await fixture();
    h.settings.compactionMode = "provider-checkpoint";
    h.manager.appendMessage(call(stopReason));
    assert.equal(h.engine.capture(h.ctx), undefined);
    assert.equal(h.payloads.length, 0);
  });
}

const unsafeHistories: [string, Parameters<SessionManager["appendMessage"]>[0][]][] = [
  ["pending call", [call("toolUse", "active")]],
  ["orphan result", [result("missing")]],
  ["result for an omitted attempt", [call("aborted"), result("cancelled-call")]],
  ["duplicate unresolved call", [call("toolUse", "active"), call("toolUse", "active"), result("active")]],
  ["duplicate result", [call("toolUse", "active"), result("active"), result("active")]],
  ["pending call crossing an aborted attempt", [call("toolUse", "active"), call("aborted"), result("active")]],
  ["pending call crossing an errored attempt", [call("toolUse", "active"), call("error"), result("active")]],
  ["pending call crossing an assistant", [call("toolUse", "active"), assistant("Later turn"), result("active")]],
  [
    "pending call crossing a user",
    [call("toolUse", "active"), { role: "user", content: "Later turn", timestamp: 3 }, result("active")],
  ],
  [
    "pending call crossing a converted custom message",
    [
      call("toolUse", "active"),
      { role: "custom", customType: "fixture", content: "Later turn", display: false, timestamp: 3 },
      result("active"),
    ],
  ],
  [
    "pending call colliding with an aborted ID",
    [call("toolUse", "active"), call("aborted", "active"), result("active")],
  ],
];
for (const [name, messages] of unsafeHistories) {
  test(`text summary still rejects ${name} before sending`, async () => {
    assert.equal(matchedToolPairs(messages), false);
    const h = await fixture();
    for (const message of messages) h.manager.appendMessage(message);
    const before = JSON.stringify(h.manager.getBranch());
    assert.deepEqual(await h.emit("session_before_compact", h.event()), { cancel: true });
    assert.equal(h.engine.capture(h.ctx), undefined);
    assert.equal(h.payloads.length, 0);
    assert.equal(JSON.stringify(h.manager.getBranch()), before);
  });

  test(`prepared adoption still rejects appended ${name}`, async () => {
    const h = await fixture();
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const prepared = await preparation.start(h.guard);
    assert.equal(prepared.usable, true);
    for (const message of messages) h.manager.appendMessage(message);
    const before = JSON.stringify(h.manager.getBranch());
    assert.equal((await prepared.adopt(h.event(), h.ctx, h.guard)).kind, "stale");
    assert.equal((await prepared.draft(h.ctx, h.guard)).draft, undefined);
    assert.equal(h.payloads.length, 1);
    assert.equal(JSON.stringify(h.manager.getBranch()), before);
  });
}

test("manual text summary cannot split a real tool pair even after an aborted attempt", async () => {
  const h = await fixture();
  h.manager.appendMessage(call("aborted"));
  h.manager.appendMessage(call("toolUse", "active"));
  const resultId = h.manager.appendMessage(result("active"));
  assert.deepEqual(await h.emit("session_before_compact", h.event(resultId)), { cancel: true });
  assert.equal(h.payloads.length, 0);
});

test("a completed retry can reuse an omitted attempt's ID and recorded tool errors remain paired", async () => {
  const messages = [call("aborted"), call("toolUse"), result("cancelled-call")];
  assert.equal(matchedToolPairs(messages), true);
  const h = await fixture();
  for (const message of messages) h.manager.appendMessage(message);
  const outcome = (await h.emit("session_before_compact", h.event())) as { compaction?: { details: unknown } };
  assert.ok(parseTextSummaryDetails(outcome.compaction?.details));
  assert.equal(h.payloads.length, 1);
});

test("multiple calls in one assistant remain paired across transparent system messages", () => {
  const first = call("toolUse", "one");
  first.content.push({ type: "toolCall", id: "two", name: "code", arguments: {} });
  assert.equal(
    matchedToolPairs([
      first,
      { role: "system", content: "Updated instructions", timestamp: 3 },
      result("two"),
      result("one"),
    ]),
    true,
  );
});

for (const stopReason of ["stop", "toolUse", "length"] as const) {
  test(`${stopReason} assistant calls still require real results`, () => {
    assert.equal(matchedToolPairs([call(stopReason)]), false);
    assert.equal(matchedToolPairs([call(stopReason), result("cancelled-call")]), true);
  });
}

for (const mutation of ["content", "stopReason"] as const) {
  test(`captured ${mutation} of an aborted attempt stays fingerprint protected`, async () => {
    const h = await fixture();
    const failedId = h.manager.appendMessage(call("aborted"));
    const preparation = h.engine.capture(h.ctx);
    assert.ok(preparation);
    const prepared = await preparation.start(h.guard);
    const entry = h.manager.getBranch().find((entry) => entry.id === failedId);
    assert.ok(entry?.type === "message" && entry.message.role === "assistant");
    if (mutation === "content") entry.message.content = [{ type: "text", text: "Changed attempt" }];
    else entry.message.stopReason = "stop";
    assert.equal(preparation.isCurrent(), false);
    assert.equal((await prepared.draft(h.ctx, h.guard)).draft, undefined);
    assert.equal(h.payloads.length, 1);
  });
}
