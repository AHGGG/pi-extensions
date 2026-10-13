import assert from "node:assert/strict";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { buildSessionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createCheckpointDetails, fallbackSummary } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import type { RemoteCompactionProtocol } from "../src/model-api.js";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";

const model: Model<Api> = {
  id: "metadata-ownership-fixture",
  name: "Metadata ownership fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(protocol: RemoteCompactionProtocol = "responses-compact", checkpoint = false) {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
  const provider = openaiProvider();
  const manager = SessionManager.inMemory();
  const oldId = manager.appendMessage({ role: "user", content: "Earlier fact", timestamp: 1 });
  if (checkpoint) {
    const details = createCheckpointDetails({
      provider: model.provider,
      api: model.api,
      profile: "openai-responses-v1",
      modelId: model.id,
      protocol,
      replacementHistory: [{ type: "compaction", encrypted_content: "earlier-opaque" }],
      keptMessages: manager.buildSessionContext().messages,
    });
    manager.appendCompaction(fallbackSummary(details.checkpointId), oldId, 100, details, true);
  }
  const tailId = manager.appendMessage({ role: "user", content: "Recent tail", timestamp: 2 });
  const snapshot = manager.getBranch();
  const authReady = gate();
  const authDone = gate();
  const requestReady = gate();
  const requestDone = gate();
  let delayAuth = false;
  let delayRequest = false;
  let failRemote = false;
  let systemPrompt = "Original instructions";
  const declarations = [{ name: "read", description: "Read files", parameters: { type: "object" } }];
  const mock = createMockPi({ activeTools: ["read"], allTools: declarations });
  let state: CodexCompactSettingsState = {
    kind: "loaded",
    path: "/tmp/unused-codex-compact.json",
    document: {},
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol, maxRetries: 0 },
  };
  const settingsRuntime: CodexCompactSettingsRuntime = {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async (patch) => {
      state = { ...state, settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    flush: async () => {},
  };
  const payloads: unknown[] = [];
  createCodexCompactExtension({
    settingsRuntime,
    fetch: async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      requestReady.release();
      if (delayRequest) await requestDone.promise;
      const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
      if (failRemote) {
        if (payloads.length === 1)
          return Response.json({ error: { message: "fixture remote failure" } }, { status: 400 });
        const item = {
          type: "message",
          id: "summary",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Earlier fact summarized", annotations: [] }],
        };
        return new Response(
          [
            { type: "response.output_item.done", item },
            { type: "response.completed", response: { id: "resp", status: "completed", output: [item], usage } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const item = { type: "compaction", encrypted_content: "new-opaque" };
      if (protocol === "responses-compact") return Response.json({ output: [item], usage });
      return new Response(
        [
          { type: "response.output_item.done", item },
          { type: "response.completed", response: { id: "resp", status: "completed", output: [item], usage } },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  })(mock.pi);
  const context = createMockContext({
    mode: "tui",
    model,
    sessionManager: manager,
    getSystemPrompt: () => systemPrompt,
    modelRegistry: {
      getProvider: () => provider,
      getApiKeyAndHeaders: async () => {
        authReady.release();
        if (delayAuth) await authDone.promise;
        return { ok: true, apiKey: "fixture" };
      },
    },
  });
  const event: SessionBeforeCompactEvent = {
    type: "session_before_compact",
    branchEntries: snapshot,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
    preparation: {
      firstKeptEntryId: tailId,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    },
  };
  return {
    ...context,
    manager,
    snapshot,
    oldId,
    tailId,
    mock,
    payloads,
    event,
    authReady,
    authDone,
    requestReady,
    requestDone,
    declarations,
    settingsRuntime,
    delayAuth: () => {
      delayAuth = true;
    },
    delayRequest: () => {
      delayRequest = true;
    },
    changePrompt: () => {
      systemPrompt = "Changed instructions";
    },
    failRemote: () => {
      failRemote = true;
    },
    run: () => mock.events.get("session_before_compact")?.[0](event, context.ctx),
    shutdown: () => mock.events.get("session_shutdown")?.[0]({}, context.ctx),
  };
}

for (const protocol of ["responses-compact", "remote-v2", "context-management"] as const) {
  for (const checkpoint of [false, true]) {
    for (const stage of ["before-hook", "authentication", "request"] as const) {
      for (const reason of ["manual", "threshold", "overflow"] as const) {
        test(`${protocol}: ${reason} metadata during ${stage} preserves ${checkpoint ? "repeated" : "first"} compaction`, async () => {
          const h = await fixture(protocol, checkpoint);
          h.event.reason = reason;
          h.event.willRetry = reason === "overflow";
          if (stage === "authentication") h.delayAuth();
          if (stage === "request") h.delayRequest();
          let pending: ReturnType<typeof h.run> | undefined;
          try {
            if (stage !== "before-hook") {
              pending = h.run();
              await (stage === "authentication" ? h.authReady.promise : h.requestReady.promise);
            }
            h.manager.appendCustomEntry("arbitrary-bookkeeping", { counter: 1 });
            h.manager.appendSessionInfo("Renamed session");
            assert.deepEqual(h.manager.buildSessionContext().messages, buildSessionContext(h.snapshot).messages);
            if (stage === "before-hook") pending = h.run();
            h.authDone.release();
            h.requestDone.release();
            const result = await pending;
            assert.ok(
              result && typeof result === "object" && "compaction" in result,
              "metadata alone must not cancel valid work",
            );
            assert.equal(h.payloads.length, 1);
            assert.deepEqual(h.notifications, []);
          } finally {
            h.authDone.release();
            h.requestDone.release();
            await h.shutdown();
          }
        });
      }
    }
  }
}

for (const recovery of [false, true]) {
  test(`metadata during remote failure permits ${recovery ? "checkpoint recovery" : "native fallback"}`, async () => {
    const h = await fixture("responses-compact", recovery);
    h.failRemote();
    h.delayRequest();
    const pending = h.run();
    try {
      await h.requestReady.promise;
      h.manager.appendCustomEntry("bookkeeping", { updated: true });
      h.requestDone.release();
      const result = await pending;
      if (recovery) {
        assert.ok(result && typeof result === "object" && "compaction" in result);
        assert.match((result.compaction as { summary: string }).summary, /Earlier fact summarized/);
      } else assert.equal(result, undefined);
      assert.equal(h.payloads.length, recovery ? 2 : 1);
      assert.equal(h.notifications.length, 1);
    } finally {
      h.requestDone.release();
      await pending;
      await h.shutdown();
    }
  });
}

for (const stage of ["authentication", "request"] as const) {
  for (const change of [
    "message",
    "hidden-message",
    "replacement",
    "omission",
    "branch",
    "same-text-sibling",
    "in-place",
    "prompt",
    "tools",
    "tool-schema",
    "settings",
    "abort",
  ] as const) {
    test(`${change} during ${stage} still cancels stale compaction`, async () => {
      const h = await fixture();
      if (stage === "authentication") h.delayAuth();
      else h.delayRequest();
      const controller = new AbortController();
      h.event.signal = controller.signal;
      const pending = h.run();
      try {
        await (stage === "authentication" ? h.authReady.promise : h.requestReady.promise);
        switch (change) {
          case "message":
            h.manager.appendMessage({ role: "user", content: "New input", timestamp: 3 });
            break;
          case "hidden-message":
            h.manager.appendCustomMessageEntry("new-contract", "New instructions", false);
            break;
          case "replacement":
            h.manager.appendContextEdit(h.oldId, { content: "Different fact" });
            break;
          case "omission":
            h.manager.appendContextEdit(h.oldId, null);
            break;
          case "branch":
            h.manager.branch(h.oldId);
            break;
          case "same-text-sibling":
            h.manager.branch(h.oldId);
            h.manager.appendMessage({ role: "user", content: "Recent tail", timestamp: 2 });
            break;
          case "in-place": {
            const entry = h.manager.getEntry(h.oldId);
            assert.ok(entry?.type === "message" && entry.message.role === "user");
            entry.message.content = "Mutated original fact";
            break;
          }
          case "prompt":
            h.changePrompt();
            break;
          case "tools":
            h.mock.rawPi.setActiveTools([]);
            break;
          case "tool-schema":
            h.declarations[0].parameters.type = "string";
            break;
          case "settings":
            await h.settingsRuntime.update({ replacementTokenBudget: 10 });
            break;
          case "abort":
            controller.abort();
            break;
        }
        h.authDone.release();
        h.requestDone.release();
        assert.deepEqual(await pending, { cancel: true });
        assert.equal(h.payloads.length, stage === "authentication" ? 0 : 1);
        assert.deepEqual(h.notifications, []);
      } finally {
        h.authDone.release();
        h.requestDone.release();
        await pending;
        await h.shutdown();
      }
    });
  }
}
