import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { type ExtensionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { latestCheckpoint } from "../src/checkpoint.js";
import { projectSessionCheckpointContext } from "../src/checkpoint-projection.js";
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
  let failuresRemaining = 0;
  let rejectedOperation = false;
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
      if (rejectedOperation)
        return Response.json(
          { error: { code: "hardened_oauth_rule_missing", type: "rejected_by_hardened_oauth_boundary" } },
          { status: 403 },
        );
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
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
    failNext(count = 1) {
      failuresRemaining = count;
    },
    rejectOperation() {
      rejectedOperation = true;
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

for (const reason of ["manual", "threshold"] as const) {
  for (const failure of ["request", "deadline"] as const) {
    test(`${reason} compaction freshly retries ${failure} preparation failure without credential changes`, async () => {
      const h = fixture();
      const deadline = new AbortController();
      const preparation = h.engine().capture(h.ctx);
      assert.ok(preparation);
      if (failure === "request") h.failNext();
      const pending = preparation.start({
        signal: new AbortController().signal,
        deadlineSignal: deadline.signal,
        isCurrent: () => true,
        ownsStatus: () => true,
      });
      await h.started;
      if (failure === "deadline") deadline.abort(new Error("fixture deadline"));
      h.release();
      const checkpoint = await pending;
      assert.equal(checkpoint.usable, false);
      assert.equal(h.fetches, 1);
      const detach = h
        .engine()
        .attachSource({ beforeCompact: async () => ({ kind: "fallback", prepared: checkpoint }) });
      try {
        const result = await h.compact(reason);
        assert.ok(result && typeof result === "object" && "compaction" in result);
        assert.equal(h.fetches, 2, "exactly one new logical checkpoint request succeeds");
        assert.notEqual(h.requestSignals[0], h.requestSignals[1], "foreground owns a fresh request signal");
      } finally {
        detach();
        await h.emit("session_shutdown", { type: "session_shutdown" });
      }
    });
  }

  test(`${reason} failed fresh attempt returns to native fallback without looping`, async () => {
    const h = fixture();
    const preparation = h.engine().capture(h.ctx);
    assert.ok(preparation);
    h.failNext(2);
    h.release();
    const checkpoint = await preparation.start({
      signal: new AbortController().signal,
      isCurrent: () => true,
      ownsStatus: () => true,
    });
    assert.equal(checkpoint.usable, false);
    const detach = h.engine().attachSource({ beforeCompact: async () => ({ kind: "fallback", prepared: checkpoint }) });
    try {
      assert.equal(await h.compact(reason), undefined);
      assert.equal(h.fetches, 2, "background failure plus one foreground failure; no recursive retry");
    } finally {
      detach();
      await h.emit("session_shutdown", { type: "session_shutdown" });
    }
  });
}

for (const stop of ["source-cancel", "event-abort", "shutdown"] as const) {
  test(`failed preparation does not start foreground inference after ${stop}`, async () => {
    const h = fixture();
    const preparation = h.engine().capture(h.ctx);
    assert.ok(preparation);
    h.failNext();
    h.release();
    const checkpoint = await preparation.start({
      signal: new AbortController().signal,
      isCurrent: () => true,
      ownsStatus: () => true,
    });
    assert.equal(checkpoint.usable, false);
    const controller = new AbortController();
    const detach = h.engine().attachSource({
      beforeCompact: async () => {
        if (stop === "source-cancel") return { kind: "cancel" };
        if (stop === "event-abort") controller.abort();
        if (stop === "shutdown") await h.emit("session_shutdown", { type: "session_shutdown" });
        return { kind: "fallback", prepared: checkpoint };
      },
    });
    try {
      assert.deepEqual(await h.compact("threshold", controller.signal), { cancel: true });
      assert.equal(h.fetches, 1, "an invalid automatic apply or cancelled owner must not infer");
    } finally {
      detach();
      await h.emit("session_shutdown", { type: "session_shutdown" });
    }
  });
}

test("failed preparation then fresh foreground failure uses checkpoint recovery once before native fallback", async () => {
  const h = fixture();
  h.release();
  const initial = (await h.compact()) as {
    compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
  };
  assert.ok(initial.compaction);
  const c = initial.compaction;
  h.manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
  h.manager.appendMessage({ role: "user", content: "continue", timestamp: 3 });
  const preparation = h.engine().capture(h.ctx);
  assert.ok(preparation);
  h.failNext(3);
  const checkpoint = await preparation.start({
    signal: new AbortController().signal,
    isCurrent: () => true,
    ownsStatus: () => true,
  });
  assert.equal(checkpoint.usable, false);
  assert.equal(h.fetches, 2);
  const detach = h.engine().attachSource({ beforeCompact: async () => ({ kind: "fallback", prepared: checkpoint }) });
  try {
    assert.equal(await h.compact(), undefined);
    assert.equal(h.fetches, 4, "seed, failed preparation, fresh checkpoint, then one summary recovery");
    assert.ok(h.notifications.some((notice) => /Checkpoint recovery could not complete/.test(notice.message)));
  } finally {
    detach();
    await h.emit("session_shutdown", { type: "session_shutdown" });
  }
});

test("failed preparation with an OAuth operation rejection keeps foreground dispatch paused", async () => {
  const h = fixture();
  const preparation = h.engine().capture(h.ctx);
  assert.ok(preparation);
  h.rejectOperation();
  h.release();
  const checkpoint = await preparation.start({
    signal: new AbortController().signal,
    isCurrent: () => true,
    ownsStatus: () => true,
  });
  assert.equal(checkpoint.usable, false);
  const detach = h.engine().attachSource({ beforeCompact: async () => ({ kind: "fallback", prepared: checkpoint }) });
  try {
    assert.equal(await h.compact(), undefined);
    assert.equal(h.fetches, 1, "fresh foreground operation cannot bypass a paused OAuth route");
  } finally {
    detach();
    await h.emit("session_shutdown", { type: "session_shutdown" });
  }
});

for (const patch of [
  { appendMaintenanceMessage: false },
  { maintenanceMessage: "CUSTOM private handoff" },
  { scratchpadEnabled: true },
]) {
  test(`changing maintenance settings while preparing invalidates the captured request: ${Object.keys(patch)[0]}`, async () => {
    const h = fixture();
    const guard = { signal: new AbortController().signal, isCurrent: () => true, ownsStatus: () => true };
    const preparation = h.engine().capture(h.ctx);
    assert.ok(preparation);
    const pending = preparation.start(guard);
    await h.started;
    await h.runtime.update(patch);
    h.release();
    const checkpoint = await pending;
    assert.equal(checkpoint.usable, false);
    assert.equal(h.fetches, 1);
  });
}

test("foreground checkpoint summary reports preparation duration", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const h = fixture();
    const pending = h.compact("manual");
    await h.started;
    now = 1234;
    h.release();
    const result = (await pending) as { compaction: { summary: string } };
    assert.match(result.compaction.summary, /^Checkpoint prepared in 1.2s\. Responses compaction checkpoint /);
  } finally {
    clock.mockRestore();
  }
});

for (const action of ["adopt", "draft"] as const) {
  test(`background checkpoint ${action} freezes preparation time and measures only application checks`, async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const append = SessionManager.prototype.appendCompaction;
    const preview = vi.spyOn(SessionManager.prototype, "appendCompaction").mockImplementation(function (
      this: SessionManager,
      ...args
    ) {
      now += 500;
      return append.apply(this, args);
    });
    try {
      const h = fixture();
      const guard = { signal: new AbortController().signal, isCurrent: () => true, ownsStatus: () => true };
      const preparation = h.engine().capture(h.ctx);
      assert.ok(preparation);
      const pending = preparation.start(guard);
      await h.started;
      now = 134000;
      h.release();
      const checkpoint = await pending;
      now += 600000;
      h.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
        now += 800;
        return { ok: true, apiKey: "fixture-key" };
      };
      let summary: string | undefined;
      if (action === "draft") {
        const result = await checkpoint.draft(h.ctx, guard);
        assert.ok(result.draft);
        summary = result.draft.summary;
        h.manager.appendCompaction(
          summary,
          result.draft.firstKeptEntryId,
          65000,
          result.draft.details,
          true,
          result.draft.usage,
        );
        const messages = h.manager.buildSessionContext().messages;
        const saved = latestCheckpoint(h.manager.getBranch());
        assert.ok(saved);
        assert.ok(
          projectSessionCheckpointContext(messages, h.manager.getBranch(), saved),
          "decorated draft can still replay the opaque checkpoint",
        );
      } else {
        h.engine().attachSource({
          async beforeCompact(event, ctx, current) {
            const result = await checkpoint.adopt(event, ctx, current);
            return result.kind === "ready" ? result : { kind: "cancel" };
          },
        });
        const result = (await h.compact()) as { compaction: { summary: string } };
        summary = result.compaction.summary;
      }
      assert.match(
        summary,
        new RegExp(
          `^Background checkpoint prepared in 2m 14s; apply checks ${action === "draft" ? "1.3" : "0.8"}s\\. Responses compaction checkpoint `,
        ),
      );
      assert.equal(h.fetches, 1);
    } finally {
      preview.mockRestore();
      clock.mockRestore();
    }
  });
}
