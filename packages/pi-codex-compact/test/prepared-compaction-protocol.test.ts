import assert from "node:assert/strict";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import {
  COMPACTION_ENGINE_AVAILABLE,
  COMPACTION_ENGINE_REQUEST,
  type CompactionEngineV1,
} from "../src/prepared-compaction-protocol.js";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";

function setup() {
  const host = createMockPi();
  const state: CodexCompactSettingsState = {
    kind: "loaded",
    path: "/unused",
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, enabled: false },
  };
  const runtime: CodexCompactSettingsRuntime = {
    get: () => state,
    reload: async () => state,
    update: async () => state,
    flush: async () => {},
  };
  const notices: CompactionEngineV1[] = [];
  host.eventBus.on(COMPACTION_ENGINE_AVAILABLE, (value) => notices.push(value as CompactionEngineV1));
  createCodexCompactExtension({ settingsRuntime: runtime })(host.pi);
  const engine = notices[0];
  assert.ok(engine);
  const context = createMockContext();
  const emit = async (name: string, ctx: ExtensionContext = context.ctx, event: unknown = {}) => {
    let result: unknown;
    for (const handler of host.events.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const compactEvent: SessionBeforeCompactEvent = {
    type: "session_before_compact",
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
    branchEntries: [],
    preparation: {
      firstKeptEntryId: "none",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 0,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
    },
  };
  return { ...host, engine, context, emit, compactEvent };
}

test("core alone discovers in either order without scheduling preparation", async () => {
  const h = setup();
  let found: CompactionEngineV1 | undefined;
  h.eventBus.emit(COMPACTION_ENGINE_REQUEST, {
    accept: (engine: CompactionEngineV1) => {
      found = engine;
    },
  });
  assert.equal(found, h.engine);
  await h.emit("session_start");
  assert.equal(h.engine.available(h.context.ctx), false);
  assert.equal(h.engine.capture(h.context.ctx), undefined);
  assert.equal(await h.emit("session_before_compact", h.context.ctx, h.compactEvent), undefined);
  assert.equal(h.events.has("turn_end"), false);
});

test("source registration rejects duplicates and idempotent detach permits replacement", () => {
  const h = setup();
  const first = { beforeCompact: async () => ({ kind: "absent" as const }) };
  const release = h.engine.attachSource(first);
  assert.throws(() => h.engine.attachSource(first), /already registered/);
  release();
  release();
  const next = h.engine.attachSource(first);
  next();
});

test("source failure cancels rather than allowing Pi native fallback", async () => {
  const h = setup();
  await h.emit("session_start");
  h.engine.attachSource({
    beforeCompact: async () => {
      throw new Error("source failed");
    },
  });
  assert.deepEqual(await h.emit("session_before_compact", h.context.ctx, h.compactEvent), { cancel: true });
});

test("a source detached during await cannot hand off a result", async () => {
  const h = setup();
  await h.emit("session_start");
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const detach = h.engine.attachSource({
    beforeCompact: async () => {
      await wait;
      return { kind: "ready", result: { cancel: true } };
    },
  });
  const pending = h.emit("session_before_compact", h.context.ctx, h.compactEvent);
  detach();
  finish();
  assert.deepEqual(await pending, { cancel: true });
});

test("ready source validity is rechecked after reentrant status cleanup", async () => {
  const h = setup();
  await h.emit("session_start");
  let valid = true;
  h.engine.attachSource({
    beforeCompact: async () => ({
      kind: "ready",
      result: { compaction: { summary: "draft", firstKeptEntryId: "none", tokensBefore: 0 } },
      isCurrent: () => valid,
    }),
  });
  (h.context.ctx as ExtensionContext).ui.setStatus = () => {
    valid = false;
  };
  assert.deepEqual(await h.emit("session_before_compact", h.context.ctx, h.compactEvent), { cancel: true });
});

test("shutdown of one shared manager preserves discovery and source for another", async () => {
  const h = setup();
  const other = createMockContext();
  await h.emit("session_start");
  await h.emit("session_start", other.ctx);
  h.engine.attachSource({ beforeCompact: async () => ({ kind: "cancel" }) });
  await h.emit("session_shutdown");
  let found: CompactionEngineV1 | undefined;
  h.eventBus.emit(COMPACTION_ENGINE_REQUEST, {
    accept: (engine: CompactionEngineV1) => {
      found = engine;
    },
  });
  assert.equal(found, h.engine);
  assert.throws(() => h.engine.attachSource({ beforeCompact: async () => ({ kind: "absent" }) }), /already registered/);
  await h.emit("session_shutdown", other.ctx);
  found = undefined;
  h.eventBus.emit(COMPACTION_ENGINE_REQUEST, {
    accept: (engine: CompactionEngineV1) => {
      found = engine;
    },
  });
  assert.equal(found, undefined);
  await h.emit("session_start", other.ctx);
  h.eventBus.emit(COMPACTION_ENGINE_REQUEST, {
    accept: (engine: CompactionEngineV1) => {
      found = engine;
    },
  });
  assert.equal(found, h.engine);
  h.engine.attachSource({ beforeCompact: async () => ({ kind: "absent" }) })();
});

test("malformed ready results cancel rather than silently falling back to native compaction", async () => {
  for (const result of [undefined, null, {}, { cancel: false }]) {
    const h = setup();
    await h.emit("session_start");
    h.engine.attachSource({ beforeCompact: async () => ({ kind: "ready", result: result as never }) });
    assert.deepEqual(await h.emit("session_before_compact", h.context.ctx, h.compactEvent), { cancel: true });
  }
});
