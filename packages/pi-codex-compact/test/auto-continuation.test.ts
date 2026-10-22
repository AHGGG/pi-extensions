import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { CodexCompactSettings } from "../src/settings.js";

const model: Model<Api> = {
  id: "continuation-model",
  name: "Continuation fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-continuation-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.resetModules();
  const { createCodexCompactExtension } = await import("../src/codex-compact.js");
  const { DEFAULT_CODEX_COMPACT_SETTINGS } = await import("../src/settings.js");
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
  const provider = openaiProvider();
  const mock = createMockPi();
  let state = {
    kind: "loaded" as const,
    path: join(directory, "pi-codex-compact.json"),
    document: {},
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol: "context-management" as const } as CodexCompactSettings,
  };
  let fail = false;
  let queued = false;
  let release: (() => void) | undefined;
  let ready: (() => void) | undefined;
  const settingsRuntime = {
    get: () => state,
    reload: async () => state,
    update: async (patch: Partial<CodexCompactSettings>) => {
      state = { ...state, settings: { ...state.settings, ...patch } };
      return state;
    },
    flush: async () => {},
  };
  createCodexCompactExtension({
    settingsRuntime,
    fetch: async () => {
      if (ready) {
        ready();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (fail) return Response.json({ error: { message: "fixture rejection" } }, { status: 400 });
      const checkpoint = { type: "compaction", encrypted_content: "opaque-fixture" };
      if (state.settings.protocol === "responses-compact")
        return Response.json({
          object: "response.compaction",
          output: [checkpoint],
          usage: { input_tokens: 20, output_tokens: 1, total_tokens: 21 },
        });
      const events = [
        { type: "response.output_item.done", item: checkpoint },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [checkpoint],
            usage: { input_tokens: 20, output_tokens: 1, total_tokens: 21 },
          },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  })(mock.pi);
  const manager = SessionManager.inMemory(directory);
  manager.appendMessage({ role: "user", content: "Finish the task", timestamp: 1 });
  const keptId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Work is pending" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 20,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 21,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const { ctx } = createMockContext({
    model,
    getSystemPrompt: () => "Stable system instructions",
    hasPendingMessages: () => queued,
    sessionManager: manager,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
      getProvider: () => provider,
    },
  });
  const emit = (name: string, event: unknown, context = ctx) => mock.events.get(name)?.[0]?.(event, context);
  const start = () => emit("before_agent_start", { type: "before_agent_start" });
  const compact = async (
    options: { reason?: "manual" | "threshold" | "overflow"; willRetry?: boolean; publish?: boolean } = {},
  ) => {
    const event = {
      type: "session_before_compact" as const,
      branchEntries: manager.getBranch(),
      preparation: { firstKeptEntryId: keptId, tokensBefore: 90_000 } as SessionBeforeCompactEvent["preparation"],
      reason: options.reason ?? "threshold",
      willRetry: options.willRetry ?? false,
      signal: new AbortController().signal,
    };
    const result = (await emit("session_before_compact", event)) as
      | { compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown } }
      | undefined;
    if (!result?.compaction || options.publish === false) return result;
    const value = result.compaction;
    const id = manager.appendCompaction(value.summary, value.firstKeptEntryId, value.tokensBefore, value.details, true);
    const entry = manager.getEntry(id);
    await emit("session_compact", {
      type: "session_compact",
      compactionEntry: entry,
      fromExtension: true,
      reason: event.reason,
      willRetry: event.willRetry,
    });
    return result;
  };
  const boundary = (overrides: Record<string, unknown> = {}, context = ctx) => {
    const messages = manager.buildSessionContext().messages;
    const { context: preview, ...rest } = overrides;
    return emit(
      "agent_before_settle",
      {
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
          ...(preview as Record<string, unknown> | undefined),
        },
        ...rest,
      },
      context,
    );
  };
  return {
    manager,
    mock,
    ctx,
    start,
    compact,
    boundary,
    emit,
    settingsRuntime,
    rejectRequests: () => {
      fail = true;
    },
    queueWork: () => {
      queued = true;
    },
    delayNextRequest: () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    releaseRequest: () => {
      ready = undefined;
      release?.();
    },
    async dispose() {
      await emit("session_shutdown", { type: "session_shutdown" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function withFixture(action: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try {
    await action(f);
  } finally {
    await f.dispose();
  }
}

test("one committed checkpoint produces one boundary message and preserves prior drafts", async () => {
  await withFixture(async (f) => {
    await f.start();
    await f.compact();
    const earlier = { type: "custom", customType: "neutral-fixture", data: { retained: true } };
    const result = (await f.boundary({ entries: [earlier] })) as {
      entries: Array<{ type: string; customType: string; display?: boolean; content?: string }>;
      continue: boolean;
    };
    assert.equal(result.continue, true);
    assert.deepEqual(result.entries[0], earlier);
    assert.equal(result.entries[1].customType, "codex-compact:continue-v1");
    assert.equal(result.entries[1].display, false);
    assert.match(result.entries[1].content ?? "", /Continue unfinished work/);
    assert.equal(await f.boundary(), undefined);
    await f.compact();
    assert.equal(await f.boundary(), undefined, "another checkpoint cannot reset the user-run allowance");
    await f.start();
    await f.compact();
    assert.ok(await f.boundary(), "a new user run gets a new allowance");
  });
});

for (const mode of [
  "no active run",
  "unpublished",
  "manual",
  "Pi retry",
  "request already sent",
  "existing boundary continuation",
  "queued input",
  "failure",
] as const) {
  test(`does not force continuation for ${mode}`, async () => {
    await withFixture(async (f) => {
      if (mode !== "no active run") await f.start();
      if (mode === "failure") f.rejectRequests();
      await f.compact({
        reason: mode === "manual" ? "manual" : "threshold",
        willRetry: mode === "Pi retry",
        publish: mode !== "unpublished",
      });
      if (mode === "request already sent") await f.emit("before_provider_request", { payload: {} });
      if (mode === "queued input") f.queueWork();
      const override =
        mode === "existing boundary continuation"
          ? { continue: true, context: { canContinue: true } }
          : mode === "queued input"
            ? { context: { pendingMessages: [{ role: "user", content: "next" }], canContinue: true } }
            : {};
      assert.equal(await f.boundary(override), undefined);
      assert.equal(await f.boundary(), undefined);
    });
  });
}

for (const mode of [
  "aborted",
  "error",
  "changed model",
  "changed settings",
  "tree",
  "model selection",
  "settled",
  "reload",
  "shutdown",
  "failed event",
  "edited retained context",
] as const) {
  test(`${mode} invalidates a committed continuation candidate`, async () => {
    await withFixture(async (f) => {
      await f.start();
      await f.compact();
      let context = f.ctx;
      if (mode === "changed model")
        context = createMockContext({ model: { ...model, id: "other-model" }, sessionManager: f.manager }).ctx;
      if (mode === "changed settings") await f.settingsRuntime.update({ enabled: false });
      if (mode === "tree") await f.emit("session_tree", {});
      if (mode === "model selection") await f.emit("model_select", { model });
      if (mode === "settled") await f.emit("agent_settled", {});
      if (mode === "reload") await f.emit("session_start", {});
      if (mode === "shutdown") await f.emit("session_shutdown", {});
      if (mode === "failed event") await f.emit("session_compact_failed", {});
      if (mode === "edited retained context") {
        const kept = f.manager
          .getBranch()
          .find((entry) => entry.type === "message" && entry.message.role === "assistant");
        assert.ok(kept);
        f.manager.appendContextEdit(kept.id, null);
      }
      assert.equal(
        await f.boundary(mode === "aborted" || mode === "error" ? { outcome: mode } : {}, context),
        undefined,
      );
      assert.equal(await f.boundary(), undefined);
    });
  });
}

for (const event of ["session_start", "session_shutdown", "session_tree", "model_select", "before_agent_start"]) {
  test(`delayed compaction cannot arm a candidate after ${event}`, async () => {
    await withFixture(async (f) => {
      await f.start();
      const ready = f.delayNextRequest();
      const pending = f.compact();
      await ready;
      await f.emit(event, { model });
      f.releaseRequest();
      await pending;
      assert.equal(await f.boundary(), undefined);
    });
  });
}

for (const protocol of ["remote-v2", "responses-compact"] as const) {
  test(`${protocol} does not opt into Context Management continuation`, async () => {
    await withFixture(async (f) => {
      await f.settingsRuntime.update({ protocol });
      await f.start();
      assert.ok((await f.compact())?.compaction);
      assert.equal(await f.boundary(), undefined);
    });
  });
}

for (const kind of ["native fallback", "plaintext recovery", "restored checkpoint", "other checkpoint"] as const) {
  test(`${kind} publication cannot arm this run's continuation`, async () => {
    await withFixture(async (f) => {
      await f.start();
      const result = await f.compact({ publish: false });
      assert.ok(result?.compaction);
      const value = result.compaction;
      if (kind === "restored checkpoint") {
        await f.emit("session_start", {});
        await f.start();
      }
      const details =
        kind === "native fallback"
          ? undefined
          : kind === "plaintext recovery"
            ? { readFiles: [], modifiedFiles: [] }
            : kind === "other checkpoint"
              ? { ...(value.details as Record<string, unknown>), checkpointId: "different-checkpoint" }
              : value.details;
      const id = f.manager.appendCompaction(
        value.summary,
        value.firstKeptEntryId,
        value.tokensBefore,
        details,
        kind !== "native fallback",
      );
      await f.emit("session_compact", {
        compactionEntry: f.manager.getEntry(id),
        fromExtension: kind !== "native fallback",
        reason: "threshold",
        willRetry: false,
      });
      assert.equal(await f.boundary(), undefined);
    });
  });
}

test("an incoming continuation flag without runnable context is completed by a boundary message", async () => {
  await withFixture(async (f) => {
    await f.start();
    await f.compact();
    const result = (await f.boundary({ continue: true })) as { continue: boolean; entries: unknown[] };
    assert.equal(result.continue, true);
    assert.equal(result.entries.length, 1);
  });
});

for (const canContinue of [false, true]) {
  test(`context-only pending messages do not imply queued work (canContinue=${canContinue})`, async () => {
    await withFixture(async (f) => {
      await f.start();
      await f.compact();
      const result = (await f.boundary({
        context: {
          pendingMessages: [{ role: "custom", customType: "neutral-context", content: "Task context", display: false }],
          canContinue,
        },
      })) as { continue: boolean; entries: unknown[] };
      assert.equal(result.continue, true);
      assert.equal(result.entries.length, 1);
      assert.equal(await f.boundary(), undefined);
    });
  });
}

test("an aborted operation signal prevents continuation even before settlement reports cancellation", async () => {
  await withFixture(async (f) => {
    await f.start();
    await f.compact();
    const signal = AbortSignal.abort();
    const context = createMockContext({ model, sessionManager: f.manager, signal }).ctx;
    assert.equal(await f.boundary({}, context), undefined);
  });
});

test("headless sessions sharing one UI retain independent continuation ownership", async () => {
  await withFixture(async (f) => {
    await f.start();
    await f.compact();
    const otherManager = SessionManager.inMemory("/tmp/other-continuation-session");
    const other = createMockContext({ model, sessionManager: otherManager, ui: (f.ctx as ExtensionContext).ui }).ctx;
    await f.emit("before_agent_start", {}, other);
    assert.equal(await f.boundary({}, other), undefined);
    assert.ok(await f.boundary());
  });
});

test("unowned settings fields do not invalidate committed continuation", async () => {
  await withFixture(async (f) => {
    await f.start();
    await f.compact();
    Object.assign(f.settingsRuntime.get().settings, { futureUnownedSetting: true });
    const result = (await f.boundary()) as { continue: boolean } | undefined;
    assert.equal(result?.continue, true);
  });
});
