import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { convertToLlm, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { RemoteCompactionProtocolSetting } from "../src/model-api.js";
import type { RemoteCompactionRequest } from "../src/remote-types.js";

const remote = vi.hoisted(() => vi.fn());
vi.mock("../src/remote.js", () => ({ requestRemoteCompaction: remote }));

// This covers the merge boundary: authenticated protocol selection must feed the
// upstream continuation lifecycle even when the saved preference is Auto or V2.
const model: Model<Api> = {
  id: "oauth-continuation-fixture",
  name: "OAuth continuation fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
const usage = {
  input: 20,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 21,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Scenario = "settlement" | "ordinary-dispatch" | "manual";

async function exercise(protocol: RemoteCompactionProtocolSetting, scenario: Scenario, oauth = true) {
  const directory = await mkdtemp(join(tmpdir(), "pi-oauth-continuation-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.resetModules();
  remote.mockReset();
  const mock = createMockPi();
  let cleanup: (() => Promise<unknown>) | undefined;
  try {
    const { createCodexCompactExtension } = await import("../src/codex-compact.js");
    const { DEFAULT_CODEX_COMPACT_SETTINGS } = await import("../src/settings.js");
    const state = {
      kind: "loaded" as const,
      path: join(directory, "pi-codex-compact.json"),
      document: {},
      settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol },
    };
    const checkpoint = { type: "compaction", encrypted_content: "opaque-oauth-continuation-fixture" };
    const expectedProtocol = oauth ? "context-management" : protocol === "auto" ? "responses-compact" : protocol;
    remote.mockImplementation(async (request: RemoteCompactionRequest) => {
      assert.equal(request.protocol, expectedProtocol);
      return { item: checkpoint, replacementHistory: [checkpoint], promptInput: [], usage };
    });
    createCodexCompactExtension({
      settingsRuntime: {
        get: () => state,
        reload: async () => state,
        update: async () => state,
        flush: async () => {},
      },
    })(mock.pi);
    const manager = SessionManager.inMemory(directory);
    manager.appendMessage({ role: "user", content: "Finish the pending task", timestamp: 1 });
    const keptId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Work remains pending" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: 2,
    });
    const { ctx } = createMockContext({
      model,
      sessionManager: manager,
      getSystemPrompt: () => "Stable task instructions",
      hasPendingMessages: () => false,
      modelRegistry: {
        getProvider: () => ({}) as Provider,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-access" }),
        getProviderAuth: async () => ({
          source: oauth ? "OAuth" : "stored credential",
          auth: { apiKey: "fixture-access" },
        }),
      },
    });
    const emit = async (name: string, event: unknown) => mock.events.get(name)?.[0]?.(event, ctx);
    cleanup = () => emit("session_shutdown", { type: "session_shutdown" });
    await emit("before_agent_start", { type: "before_agent_start" });
    const reason = scenario === "manual" ? "manual" : "threshold";
    const event: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      branchEntries: manager.getBranch(),
      reason,
      willRetry: false,
      signal: new AbortController().signal,
      preparation: {
        firstKeptEntryId: keptId,
        tokensBefore: 90_000,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      },
    };
    const result = (await emit("session_before_compact", event)) as {
      compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: { protocol: string } };
    };
    assert.equal(result.compaction.details.protocol, expectedProtocol);
    assert.equal(remote.mock.calls.length, 1);
    assert.equal(state.settings.protocol, protocol, "routing must not rewrite the saved preference");
    const value = result.compaction;
    const id = manager.appendCompaction(value.summary, value.firstKeptEntryId, value.tokensBefore, value.details, true);
    await emit("session_compact", {
      type: "session_compact",
      compactionEntry: manager.getEntry(id),
      fromExtension: true,
      reason,
      willRetry: false,
    });
    if (scenario === "ordinary-dispatch") {
      // Pi has already scheduled work: it must consume, not duplicate, continuation.
      await emit("before_provider_request", { type: "before_provider_request", payload: { input: [] } });
    }
    const messages = manager.buildSessionContext().messages;
    const boundary = {
      type: "agent_before_settle",
      outcome: "completed",
      entries: [],
      continue: false,
      context: {
        contextEntries: [],
        contextMessages: messages,
        llmMessages: convertToLlm(messages),
        pendingMessages: [],
        canContinue: false,
      },
    };
    const continuation = (await emit("agent_before_settle", boundary)) as
      | { continue: boolean; entries: Array<{ customType?: string }> }
      | undefined;
    if (scenario === "settlement" && expectedProtocol === "context-management") {
      assert.equal(continuation?.continue, true);
      assert.deepEqual(continuation?.entries.map((entry) => entry.customType), ["codex-compact:continue-v1"]);
    } else {
      assert.equal(continuation, undefined);
    }
    assert.equal(await emit("agent_before_settle", boundary), undefined, "one candidate cannot schedule twice");
  } finally {
    await cleanup?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
}

for (const protocol of ["auto", "remote-v2", "responses-compact"] as const) {
  for (const scenario of ["settlement", "ordinary-dispatch", "manual"] as const) {
    test(`${protocol} OAuth adaptation preserves ${scenario} continuation ownership`, async () => {
      await exercise(protocol, scenario);
    });
  }
}

test("API-key Auto does not acquire Context Management continuation", () => exercise("auto", "settlement", false));
