import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { type ExtensionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { COMPACTION_ENGINE_REQUEST, type CompactionEngineV1 } from "../src/prepared-compaction-protocol.js";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";

const model = {
  id: "fixture",
  name: "Fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-responses">;
const usage = {
  input: 65_000,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 65_001,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
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
function response() {
  const item = { type: "compaction", encrypted_content: "opaque" };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
  );
}
function fixture() {
  const mock = createMockPi();
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "snapshot user", timestamp: 1 });
  manager.appendMessage(assistant("snapshot assistant"));
  let state: CodexCompactSettingsState = {
    kind: "loaded",
    path: "/tmp/test-async.json",
    settings: {
      ...DEFAULT_CODEX_COMPACT_SETTINGS,
      protocol: "context-management",
    },
    document: {},
  };
  const runtime: CodexCompactSettingsRuntime = {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async (patch) => {
      state = { ...state, settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    flush: async () => {},
  };
  const started = deferred<void>();
  const gate = deferred<void>();
  let paused = true;
  let fetches = 0;
  let failOnce = false;
  let apiKey = "fixture-key";
  const prompt = "system";
  const requestSignals: AbortSignal[] = [];
  const captured: unknown[] = [];
  const provider: Provider = {
    id: model.provider,
    name: "Fixture",
    auth: {} as Provider["auth"],
    getModels: () => [model],
    stream(active, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          captured.push(structuredClone(context.messages));
          await options?.onPayload?.(
            {
              model: active.id,
              input: context.messages.map((message) => ({
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text:
                      typeof message.content === "string"
                        ? message.content
                        : message.content
                            .filter((part) => part.type === "text")
                            .map((part) => part.text)
                            .join("\n"),
                  },
                ],
              })),
            },
            active,
          );
          const result = await options?.fetch?.("https://example.test/responses", {
            method: "POST",
            signal: options.signal,
          });
          for (const line of ((await result?.text()) ?? "").split("\n"))
            if (line.startsWith("data: ")) await options?.onProviderStreamEvent?.(JSON.parse(line.slice(6)), active);
          const message = assistant("done") as Extract<AgentMessage, { role: "assistant" }>;
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        } catch (error) {
          const message = { ...assistant(""), stopReason: "error", errorMessage: String(error) } as Extract<
            AgentMessage,
            { role: "assistant" }
          >;
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
        }
      })();
      return stream;
    },
    streamSimple() {
      throw new Error("unused");
    },
  };
  const mockCtx = createMockContext({
    model: structuredClone(model),
    mode: "tui",
    sessionManager: manager,
    getSystemPrompt: () => prompt,
    getContextUsage: () => ({ tokens: 65_000, contextWindow: 100_000, percent: 65 }),
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
      getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey } }),
      getProvider: () => provider,
    },
  });
  const ctx = mockCtx.ctx as ExtensionContext;
  createCodexCompactExtension({
    settingsRuntime: runtime,
    fetch: async (_input, init) => {
      fetches += 1;
      requestSignals.push(init?.signal as AbortSignal);
      started.resolve();
      if (paused) await gate.promise;
      if (failOnce) {
        failOnce = false;
        throw new Error("expired token");
      }
      return response();
    },
  })(mock.pi);
  const emit = async (name: string, event: unknown) => {
    let result: unknown;
    for (const hook of mock.events.get(name) ?? []) {
      const next = await hook(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  const compact = (
    reason: SessionBeforeCompactEvent["reason"] = "threshold",
    signal = new AbortController().signal,
    customInstructions?: string,
  ) =>
    emit("session_before_compact", {
      type: "session_before_compact",
      reason,
      customInstructions,
      willRetry: false,
      signal,
      branchEntries: manager.getBranch(),
      preparation: {
        firstKeptEntryId: manager.getLeafId() ?? first,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90_000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 1000 },
      },
    } satisfies SessionBeforeCompactEvent);
  return {
    ...mock,
    ...mockCtx,
    ctx,
    manager,
    first,
    runtime,
    provider,
    captured,
    requestSignals,
    started: started.promise,
    emit,
    compact,
    get fetches() {
      return fetches;
    },
    release() {
      paused = false;
      gate.resolve();
    },
    failNext() {
      failOnce = true;
    },
    setKey(value: string) {
      apiKey = value;
    },
    engine() {
      let engine: CompactionEngineV1 | undefined;
      mock.eventBus.emit(COMPACTION_ENGINE_REQUEST, {
        accept(value: CompactionEngineV1) {
          engine = value;
        },
      });
      if (!engine) throw new Error("Prepared-compaction engine was not registered");
      return engine;
    },
    start: () => emit("turn_end", { outcome: "completed" }),
  };
}

for (const action of ["adopt", "draft"] as const) {
  for (const change of ["token", "headers", "model", "provider", "logout", "mismatch"] as const) {
    test(`prepared official OAuth checkpoint ${action}: ${change}`, async () => {
      const h = fixture();
      const guard = { signal: new AbortController().signal, isCurrent: () => true, ownsStatus: () => true };
      const preparation = h.engine().capture(h.ctx);
      assert.ok(preparation);
      h.release();
      const checkpoint = await preparation.start(guard);
      assert.equal(checkpoint.usable, true);
      assert.equal(h.fetches, 1);
      h.setKey("refreshed-token");
      if (change === "headers")
        h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
          ok: true,
          apiKey: "refreshed-token",
          headers: { "ChatGPT-Account-Id": "different" },
        });
      if (change === "logout")
        h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "signed out" });
      if (change === "mismatch")
        h.ctx.modelRegistry.getProviderAuth = async () => ({ source: "OAuth", auth: { apiKey: "other-token" } });
      if (change === "model") h.ctx.model = { ...model, id: "changed" };
      if (change === "provider") h.ctx.modelRegistry.getProvider = () => ({ ...h.provider });
      if (action === "draft") {
        const result = await checkpoint.draft(h.ctx, guard);
        assert.equal(result.draft?.type, change === "token" ? "compaction" : undefined);
      } else {
        let result: { kind: string } | undefined;
        const detach = h.engine().attachSource({
          beforeCompact: async (event, ctx, current) => {
            result = await checkpoint.adopt(event, ctx, current);
            return { kind: "cancel" };
          },
        });
        try {
          await h.compact();
        } finally {
          detach();
        }
        assert.equal(result?.kind, change === "token" ? "ready" : "stale");
      }
      assert.equal(h.fetches, 1, "application must reuse the prepared request without foreground inference");
      await h.emit("session_shutdown", { type: "session_shutdown" });
    });
  }
}

test("refreshed OAuth retries a failed preparation instead of reusing its old authentication failure", async () => {
  const h = fixture();
  const guard = { signal: new AbortController().signal, isCurrent: () => true, ownsStatus: () => true };
  const preparation = h.engine().capture(h.ctx);
  assert.ok(preparation);
  h.release();
  h.failNext();
  const checkpoint = await preparation.start(guard);
  assert.equal(checkpoint.usable, false);
  assert.equal(h.fetches, 1);
  h.setKey("refreshed-token");
  const detach = h.engine().attachSource({ beforeCompact: async () => ({ kind: "fallback", prepared: checkpoint }) });
  try {
    const result = await h.compact();
    assert.ok(result);
    assert.equal(h.fetches, 2, "fresh authentication must make a new foreground request");
  } finally {
    detach();
    await h.emit("session_shutdown", { type: "session_shutdown" });
  }
});
