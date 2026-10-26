import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, createAssistantMessageEventStream, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createCheckpointDetails, fallbackSummary } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { COMPACTION_ENGINE_REQUEST, type CompactionEngineV1 } from "../src/prepared-compaction-protocol.js";
import { ScratchpadStore } from "../src/scratchpad-store.js";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

const source: Model<Api> = {
  id: "source-model",
  name: "Source model",
  api: "openai-responses",
  provider: "custom",
  baseUrl: "https://issuer.example.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_000,
};
const target: Model<Api> = { ...source, id: "target-model", provider: "openai", baseUrl: "https://api.openai.com/v1" };
const usage = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function harness(
  options: {
    branch?: SessionEntry[];
    cancelRecovery?: boolean;
    scratchpadEnabled?: boolean;
    appendMaintenanceMessage?: boolean;
  } = {},
) {
  const mock = createMockPi();
  const kept: AgentMessage = { role: "user", content: "recent work", timestamp: 2 };
  const details = createCheckpointDetails({
    provider: source.provider,
    api: source.api,
    profile: "openai-responses-v1",
    modelId: source.id,
    protocol: "remote-v2",
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque-only-issuer-can-decrypt" }],
    keptMessages: [kept],
    checkpointId: "issuer-checkpoint-fixture",
  });
  const entries: SessionEntry[] = options.branch ?? [
    {
      type: "message",
      id: "old",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "old task", timestamp: 1 },
    },
    { type: "message", id: "kept", parentId: "old", timestamp: new Date(2).toISOString(), message: kept },
    {
      type: "compaction",
      id: "checkpoint",
      parentId: "kept",
      timestamp: new Date(3).toISOString(),
      summary: fallbackSummary(details.checkpointId),
      firstKeptEntryId: "kept",
      tokensBefore: 1000,
      details,
    },
    {
      type: "message",
      id: "question",
      parentId: "checkpoint",
      timestamp: new Date(4).toISOString(),
      message: { role: "user", content: "Continue and recall the project code.", timestamp: 4 },
    },
  ];
  const state = {
    kind: "loaded" as const,
    path: "fixture",
    settings: {
      ...DEFAULT_CODEX_COMPACT_SETTINGS,
      protocol: "remote-v2" as const,
      scratchpadEnabled: options.scratchpadEnabled ?? false,
      appendMaintenanceMessage: options.appendMaintenanceMessage ?? true,
    },
    document: {},
  };
  if (options.cancelRecovery) state.settings.checkpointRecovery = "cancel";
  const issuer = { available: true, fail: false, block: false, release: undefined as (() => void) | undefined };
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const calls: Array<{ provider: string; payload: unknown }> = [];
  const summary = "Portable checkpoint: the project code is VIOLET-5831. Continue the pending validation.";
  const provider: Provider = {
    id: source.provider,
    name: "Issuer",
    auth: {} as Provider["auth"],
    getModels: () => [source],
    stream(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          assert.equal(options?.apiKey, "custom-fixture-key");
          const input = context.messages.map((message) => ({
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
          }));
          const payload = await options?.onPayload?.({ model: model.id, input }, model);
          calls.push({ provider: model.provider, payload });
          await options?.fetch?.(`${source.baseUrl}/responses`, { method: "POST", signal: options.signal });
          const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] }];
          await options?.onProviderStreamEvent?.(
            { type: "response.completed", response: { status: "completed", output } },
            model,
          );
          const message = {
            role: "assistant" as const,
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [{ type: "text" as const, text: summary }],
            usage,
            stopReason: "stop" as const,
            timestamp: 5,
          };
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        } catch (error) {
          const message = {
            role: "assistant" as const,
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [],
            usage,
            stopReason: "error" as const,
            errorMessage: String(error),
            timestamp: 5,
          };
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
        }
      })();
      return stream;
    },
    streamSimple() {
      throw new Error("not used");
    },
  };
  createCodexCompactExtension({
    settingsRuntime: {
      get: () => state,
      async reload() {
        return state;
      },
      async update() {
        return state;
      },
      async flush() {},
    },
    fetch: async (_input, init) => {
      started();
      if (issuer.block)
        return new Promise<Response>((resolve, reject) => {
          issuer.release = () => resolve(new Response("fixture"));
          if (init?.signal?.aborted) reject(init.signal.reason);
          else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      return new Response("fixture", { status: issuer.fail ? 500 : 200 });
    },
  })(mock.pi);
  let aborted = false;
  const controller = new AbortController();
  const { ctx, notifications } = createMockContext({
    model: target,
    signal: controller.signal,
    hasUI: true,
    abort: () => {
      aborted = true;
    },
    getSystemPrompt: () => "Preserve the task.",
    sessionManager: { getSessionId: () => "session", getBranch: () => entries, getEntries: () => entries },
    modelRegistry: {
      find: (providerId: string, modelId: string) =>
        issuer.available && providerId === source.provider && modelId === source.id ? source : undefined,
      getProvider: (providerId: string) =>
        providerId === source.provider || providerId === target.provider ? provider : undefined,
      getApiKeyAndHeaders: async (model: Model<Api>) => ({ ok: true, apiKey: `${model.provider}-fixture-key` }),
    },
  });
  const replay = async () => {
    const messages = buildSessionContext(entries).messages;
    const projected = (await mock.events.get("context")?.[0]?.({ type: "context", messages }, ctx)) as
      | { messages: AgentMessage[] }
      | undefined;
    const input = (projected?.messages ?? messages).map((message) => ({
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            message.role === "compactionSummary"
              ? message.summary
              : "content" in message && typeof message.content === "string"
                ? message.content
                : "content" in message && Array.isArray(message.content)
                  ? message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n")
                  : "",
        },
      ],
    }));
    const payload = { model: target.id, instructions: "stable system", tools: [], input };
    return (
      (await mock.events.get("before_provider_request")?.[0]?.({ type: "before_provider_request", payload }, ctx)) ??
      payload
    );
  };
  const compact = (signal = new AbortController().signal) =>
    mock.events.get("session_before_compact")?.[0]?.(
      {
        type: "session_before_compact",
        reason: "manual",
        willRetry: false,
        signal,
        branchEntries: entries,
        preparation: {
          firstKeptEntryId: "question",
          tokensBefore: 1000,
          settings: { reserveTokens: 1000 },
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        },
      },
      ctx,
    );
  const persist = () => {
    for (const [index, entry] of mock.entries.entries()) {
      const id = `portable-${index}`;
      if (entries.some((candidate) => candidate.id === id)) continue;
      entries.push({
        type: "custom",
        id,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date(5 + index).toISOString(),
        customType: entry.customType,
        data: entry.data,
      });
    }
  };
  return {
    mock,
    entries,
    ctx,
    controller,
    issuer,
    requestStarted,
    calls,
    notifications,
    replay,
    compact,
    persist,
    summary,
    get aborted() {
      return aborted;
    },
  };
}

test("custom checkpoint is summarized by its issuer before dispatch to openai", async () => {
  const h = harness();
  const payload = await h.replay();
  const body = JSON.stringify(payload);
  const response = body.includes("opaque-only-issuer-can-decrypt")
    ? Response.json(
        {
          error: { code: "invalid_encrypted_content", message: "Encrypted content could not be decrypted or parsed." },
        },
        { status: 400 },
      )
    : Response.json({ output_text: "VIOLET-5831" });
  assert.equal(response.status, 200, "The target must never receive the issuer's opaque checkpoint");
  assert.match(body, /VIOLET-5831/);
  assert.doesNotMatch(body, /custom-fixture-key/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].provider, source.provider);
  assert.match(JSON.stringify(h.calls[0].payload), /opaque-only-issuer-can-decrypt/);
  assert.equal(h.aborted, false);
});

test("persisted plaintext transfer survives reload, resume and fork without issuer access", async () => {
  const h = harness();
  const original = structuredClone(h.entries);
  await h.replay();
  h.persist();
  const payload = await h.replay();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.entries.slice(0, original.length), original);
  for (const branch of [h.entries, structuredClone(h.entries), structuredClone(h.entries)]) {
    const loaded = harness({ branch });
    loaded.issuer.available = false;
    assert.deepEqual(await loaded.replay(), payload);
    assert.equal(loaded.calls.length, 0);
    assert.equal(loaded.aborted, false);
  }
});

for (const failure of ["unavailable", "request", "disabled"] as const) {
  test(`provider transfer ${failure} stops the request and preserves the checkpoint`, async () => {
    const h = harness({ cancelRecovery: failure === "disabled" });
    h.issuer.available = failure !== "unavailable";
    h.issuer.fail = failure === "request";
    const before = structuredClone(h.entries);
    const payload = await h.replay();
    assert.equal(h.aborted, true);
    assert.doesNotMatch(JSON.stringify(payload), /opaque-only-issuer-can-decrypt/);
    assert.deepEqual(h.entries, before);
    assert.equal(h.mock.entries.length, 0);
    assert.ok(h.notifications.some(({ message }) => message.includes("request stopped and history preserved")));
  });
}

test("model change during a transfer aborts without publishing its summary", async () => {
  const h = harness();
  h.issuer.block = true;
  const pending = h.replay();
  await h.requestStarted;
  await h.mock.events.get("model_select")?.[0]?.({ type: "model_select", model: { ...target, id: "another" } }, h.ctx);
  await pending;
  assert.equal(h.aborted, true);
  assert.equal(h.mock.entries.length, 0);
});

test("same-provider model switch keeps opaque replay and does not request a plaintext summary", async () => {
  const h = harness();
  Object.assign(h.ctx, { model: { ...source, id: "another-source-model" } });
  const payload = await h.replay();
  assert.match(JSON.stringify(payload), /opaque-only-issuer-can-decrypt/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.aborted, false);
});

test("compaction after provider change recovers through the issuer without sending opaque state to the target", async () => {
  const h = harness();
  const before = structuredClone(h.entries);
  const result = (await h.compact()) as { compaction: { summary: string; details: unknown } };
  assert.match(result.compaction.summary, /VIOLET-5831/);
  assert.deepEqual(result.compaction.details, { readFiles: [], modifiedFiles: [] });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].provider, source.provider);
  assert.deepEqual(h.entries, before);
});

for (const cancellation of ["abort", "reload", "branch"] as const) {
  test(`${cancellation} during issuer recovery cannot persist a stale transfer`, async () => {
    const h = harness();
    h.issuer.block = true;
    const pending = h.replay();
    await h.requestStarted;
    if (cancellation === "abort") h.controller.abort();
    if (cancellation === "reload")
      await h.mock.events.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "reload" }, h.ctx);
    if (cancellation === "branch") {
      h.entries.push({
        type: "message",
        id: "replacement",
        parentId: "question",
        timestamp: new Date(6).toISOString(),
        message: { role: "user", content: "Replacement branch work", timestamp: 6 },
      });
      h.issuer.release?.();
    }
    await pending;
    assert.equal(h.mock.entries.length, 0);
    assert.equal(h.aborted, true);
  });
}

test("a saved summary for a different checkpoint cannot authorize a foreign replay", async () => {
  const h = harness();
  await h.replay();
  h.persist();
  const saved = h.entries.at(-1);
  assert.ok(saved && saved.type === "custom");
  saved.data = { ...(saved.data as object), checkpointId: "different-checkpoint" };
  const reloaded = harness({ branch: h.entries });
  reloaded.issuer.available = false;
  await reloaded.replay();
  assert.equal(reloaded.aborted, true);
  assert.equal(reloaded.mock.entries.length, 0);
});

for (const failure of ["unavailable", "request", "disabled"] as const) {
  test(`compaction provider transfer ${failure} cancels without native fallback or target dispatch`, async () => {
    const h = harness({ cancelRecovery: failure === "disabled" });
    h.issuer.available = failure !== "unavailable";
    h.issuer.fail = failure === "request";
    const before = structuredClone(h.entries);
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.deepEqual(h.entries, before);
    assert.equal(h.mock.entries.length, 0);
    assert.ok(h.calls.every((call) => call.provider === source.provider));
    assert.equal(h.calls.length, failure === "request" ? 1 : 0);
  });
}

for (const cancellation of ["abort", "reload", "branch"] as const) {
  test(`compaction ${cancellation} during issuer recovery cannot apply a stale plaintext result`, async () => {
    const h = harness();
    const controller = new AbortController();
    h.issuer.block = true;
    const pending = h.compact(controller.signal);
    await h.requestStarted;
    if (cancellation === "abort") controller.abort();
    if (cancellation === "reload")
      await h.mock.events.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "reload" }, h.ctx);
    if (cancellation === "branch") {
      h.entries.push({
        type: "message",
        id: "replacement",
        parentId: "question",
        timestamp: new Date(6).toISOString(),
        message: { role: "user", content: "Replacement branch work", timestamp: 6 },
      });
      h.issuer.release?.();
    }
    assert.deepEqual(await pending, { cancel: true });
    assert.equal(h.mock.entries.length, 0);
    assert.ok(h.calls.every((call) => call.provider === source.provider));
  });
}

test("opaque preparation rejects a foreign checkpoint but accepts an issuer model switch", () => {
  const h = harness();
  let engine: CompactionEngineV1 | undefined;
  h.mock.eventBus.emit(COMPACTION_ENGINE_REQUEST, {
    accept: (candidate: CompactionEngineV1) => {
      engine = candidate;
    },
  });
  assert.ok(engine);
  Object.assign(h.ctx, { getContextUsage: () => ({ tokens: 1000 }) });
  assert.equal(engine.capture(h.ctx), undefined);
  assert.equal(h.calls.length, 0);
  Object.assign(h.ctx, { model: { ...source, id: "another-source-model" } });
  const preparation = engine.capture(h.ctx);
  assert.ok(preparation);
  assert.equal(preparation.isCurrent(), true);
  Object.assign(h.ctx, { model: { ...source, id: "yet-another-source-model" } });
  assert.equal(preparation.isCurrent(), false, "An already captured preparation still binds its exact model");
  assert.equal(h.calls.length, 0);
});

for (const callback of ["appendEntry", "notify", "status"] as const) {
  test(`reentrant ${callback} during successful transfer cannot return stale context`, async () => {
    const h = harness();
    const replaceModel = () => {
      Object.assign(h.ctx, { model: { ...target, id: "reentrant-target" } });
    };
    const pi = h.mock.pi as ExtensionAPI;
    const ctx = h.ctx as ExtensionContext;
    if (callback === "appendEntry") {
      const append = pi.appendEntry;
      pi.appendEntry = (type, data) => {
        append(type, data);
        replaceModel();
      };
    }
    if (callback === "notify") ctx.ui.notify = replaceModel;
    if (callback === "status") {
      ctx.ui.setStatus = (_key, text) => {
        if (text === undefined) replaceModel();
      };
    }
    const payload = await h.replay();
    assert.equal(h.aborted, true);
    assert.doesNotMatch(JSON.stringify(payload), /VIOLET-5831|opaque-only-issuer-can-decrypt/);
    assert.equal(h.calls.length, 1);
  });
}

for (const mode of ["compact", "ordinary-turn", "scratchpad-off", "append-off"] as const) {
  test(`issuer transfer scratchpad boundary: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "issuer-scratchpad-"));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      const store = new ScratchpadStore({ directory: join(directory, "scratchpads") });
      await store.execute("session", { action: "add", texts: ["PRIVATE issuer saved fact"] });
      const h = harness({
        scratchpadEnabled: mode !== "scratchpad-off",
        appendMaintenanceMessage: mode !== "append-off",
      });
      const before = structuredClone(h.entries);
      if (mode === "ordinary-turn") await h.replay();
      else {
        const result = await h.compact();
        assert.ok(result && typeof result === "object" && "compaction" in result);
      }
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].provider, source.provider);
      const body = JSON.stringify(h.calls[0].payload);
      assert.equal(body.includes("PI_SCRATCHPAD_SNAPSHOT_V1"), mode === "compact");
      assert.equal(body.includes("PRIVATE issuer saved fact"), mode === "compact");
      assert.match(body, /Summarize the preceding conversation/);
      assert.deepEqual(h.entries, before);
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
