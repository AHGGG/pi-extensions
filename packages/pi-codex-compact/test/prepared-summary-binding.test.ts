import assert from "node:assert/strict";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { type ExtensionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { captureCheckpointPreparation } from "../src/prepared-compaction.js";
import type { PreparedCheckpoint } from "../src/prepared-compaction-protocol.js";
import { RejectedRoutes } from "../src/rejection-state.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";
import { parseTextSummaryDetails } from "../src/text-summary.js";

async function fixture(mode: "text-summary" | "provider-checkpoint" = "text-summary") {
  const name = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(name)) as { openaiProvider(): Provider };
  const provider = openaiProvider();
  const model: Model<"openai-responses"> = {
    id: "fixture",
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
  const host = createMockPi();
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "Earlier task", timestamp: 1 });
  const tail = manager.appendMessage({ role: "user", content: "Retained task", timestamp: 2 });
  const settings = { ...DEFAULT_CODEX_COMPACT_SETTINGS, compactionMode: mode, maxRetries: 0 };
  const runtime: CodexCompactSettingsRuntime = {
    get: () => ({ kind: "loaded", path: "/unused", settings }),
    reload: async () => runtime.get(),
    update: async () => runtime.get(),
    flush: async () => {},
  };
  const state = { current: true, requests: 0, reject: false };
  const { ctx: context } = createMockContext({
    model,
    sessionManager: manager,
    getSystemPrompt: () => "Stable system",
    getContextUsage: () => ({ tokens: 65_000, contextWindow: 100_000, percent: 65 }),
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
      getProvider: () => provider,
      getProviderAuth: async () => ({ source: "API Key", auth: { apiKey: "fixture" } }),
    },
  });
  const ctx = context as ExtensionContext;
  const guard = { signal: new AbortController().signal, isCurrent: () => true, ownsStatus: () => true };
  const event = (): SessionBeforeCompactEvent => ({
    type: "session_before_compact",
    reason: "manual",
    willRetry: false,
    signal: guard.signal,
    branchEntries: manager.getBranch(),
    preparation: {
      firstKeptEntryId: tail,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 65_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 0 },
    },
  });
  const preparation = captureCheckpointPreparation(
    host.pi,
    ctx,
    runtime,
    guard.signal,
    new RejectedRoutes(),
    () => state.current,
    () => {},
    async () => {
      state.requests += 1;
      if (state.reject) return Response.json({}, { status: 503 });
      if (mode === "provider-checkpoint")
        return Response.json({
          id: "compact-fixture",
          object: "response.compaction",
          output: [{ type: "compaction", encrypted_content: "opaque-fixture" }],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        });
      const item = {
        type: "message",
        id: "summary",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Completed plaintext summary.", annotations: [] }],
      };
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  assert.ok(preparation);
  const apply = async (prepared: PreparedCheckpoint, boundary: "adopt" | "draft") => {
    if (boundary === "draft") return prepared.draft(ctx, guard);
    const result = await prepared.adopt(event(), ctx, guard);
    return result.kind === "ready" && result.result && "compaction" in result.result
      ? { draft: result.result.compaction, reason: undefined }
      : { draft: undefined, reason: result.kind === "stale" ? result.reason : result.kind };
  };
  return { provider, model, manager, first, tail, settings, state, ctx, guard, preparation, apply };
}

for (const boundary of ["adopt", "draft"] as const) {
  for (const mode of ["text-summary", "provider-checkpoint"] as const) {
    for (const method of ["stream", "streamSimple", "both"] as const) {
      test(`${boundary} ${mode} ${mode === "text-summary" ? "accepts" : "rejects"} replaced ${method} after completion`, async () => {
        const h = await fixture(mode);
        const prepared = await h.preparation.start(h.guard);
        assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
        if (method !== "streamSimple")
          h.provider.stream = () => {
            throw new Error("completed summary must not invoke the replacement stream");
          };
        if (method !== "stream")
          h.provider.streamSimple = () => {
            throw new Error("completed summary must not invoke the replacement streamSimple");
          };
        const result = await h.apply(prepared, boundary);
        if (mode === "text-summary") {
          assert.ok(result.draft, result.reason ?? "draft unavailable");
          assert.match(result.draft.summary, /Completed plaintext summary/);
          assert.ok(parseTextSummaryDetails(result.draft.details));
          assert.equal(parseCheckpointDetails(result.draft.details), undefined);
        } else {
          assert.equal(result.draft, undefined);
          assert.match(result.reason ?? "", /stream(?:Simple)? function changed/);
        }
        assert.equal(h.state.requests, 1);
      });
    }
  }

  for (const change of [
    "auth",
    "provider",
    "model",
    "route",
    "history",
    "branch",
    "owner",
    "tools",
    "budget",
  ] as const) {
    test(`${boundary} still rejects ${change} after completed text summary stream replacement`, async () => {
      const h = await fixture();
      const prepared = await h.preparation.start(h.guard);
      assert.equal(prepared.usable, true, prepared.failure ?? "preparation failed");
      h.provider.stream = () => {
        throw new Error("replacement unused");
      };
      h.provider.streamSimple = h.provider.stream;
      if (change === "auth") h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "changed" });
      if (change === "provider") h.ctx.modelRegistry.getProvider = () => ({ ...h.provider });
      if (change === "model") h.ctx.model = { ...h.model, id: "changed" };
      if (change === "route") h.settings.protocol = "remote-v2";
      if (change === "history") h.manager.appendContextEdit(h.first, { content: "Edited task" });
      if (change === "branch") h.manager.branch(h.first);
      if (change === "owner") h.state.current = false;
      if (change === "tools")
        h.manager.appendMessage({
          role: "toolResult",
          toolCallId: "unmatched",
          toolName: "read",
          content: [{ type: "text", text: "Unexpected tool result" }],
          isError: false,
          timestamp: 3,
        });
      if (change === "budget") h.ctx.getSystemPrompt = () => "x".repeat(400_000);
      const result = await h.apply(prepared, boundary);
      assert.equal(result.draft, undefined);
      assert.doesNotMatch(result.reason ?? "", /stream(?:Simple)? function changed/);
      if (change === "auth") assert.match(result.reason ?? "", /request authentication changed/);
      if (change === "budget") assert.match(result.reason ?? "", /token budget exceeded/);
      assert.equal(h.state.requests, 1);
    });
  }
}

for (const method of ["stream", "streamSimple"] as const) {
  test(`incomplete text summary retry still rejects a changed ${method} binding`, async () => {
    const h = await fixture();
    h.state.reject = true;
    const failed = await h.preparation.start(h.guard);
    assert.equal(failed.usable, false);
    assert.equal(failed.retryable, true);
    const retry = failed.retry?.(h.guard);
    assert.ok(retry);
    h.provider[method] = () => {
      throw new Error("retry must reject before streaming");
    };
    const result = await retry.start(h.guard);
    assert.equal(result.usable, false);
    assert.equal(result.retryable, false);
    assert.equal(h.state.requests, 1);
  });
}
