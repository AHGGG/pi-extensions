import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

// Both preparation and application use production extension hooks. Only the
// provider transport, auth and UI facade are synthetic; real fetch fails closed.
globalThis.fetch = () => Promise.reject(new Error("Network is forbidden in this benchmark"));
const options = JSON.parse(process.argv[2]);
assert.equal(typeof globalThis.gc, "function", "Run the worker with --expose-gc");
const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const memory = [];
const measure = (phase) => {
  globalThis.gc();
  globalThis.gc();
  memory.push({ phase, ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS });
};
const clock = () => ({ wall: performance.now(), cpu: process.cpuUsage() });
const elapsed = (started) => {
  const cpu = process.cpuUsage(started.cpu);
  return { wallMs: performance.now() - started.wall, cpuMs: (cpu.user + cpu.system) / 1000 };
};
const model = {
  id: "apply-latency-fixture",
  name: "Apply latency fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  stopReason: "stop",
  timestamp: 1,
};
let providerCalls = 0;
const provider = {
  id: model.provider,
  name: "Apply latency fixture",
  auth: {},
  getModels: () => [model],
  stream(active, context, streamOptions) {
    providerCalls++;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const payload = await streamOptions.onPayload(
          {
            model: active.id,
            input: context.messages.map((entry) => ({
              role: "user",
              content: [{ type: "input_text", text: JSON.stringify(entry.content) }],
            })),
          },
          active,
        );
        assert.ok(payload.context_management, "Exercise the ChatGPT OAuth context-management route");
        const response = await streamOptions.fetch("https://example.invalid/responses", {
          method: "POST",
          signal: streamOptions.signal,
        });
        for (const line of (await response.text()).split("\n"))
          if (line.startsWith("data: ")) await streamOptions.onProviderStreamEvent(JSON.parse(line.slice(6)), active);
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      } catch (error) {
        const failure = { ...message, stopReason: "error", errorMessage: String(error) };
        stream.push({ type: "error", reason: "error", error: failure });
        stream.end(failure);
      }
    })();
    return stream;
  },
  streamSimple() {
    throw new Error("Unused fixture operation");
  },
};
const manager = SessionManager.inMemory();
const epochs = 4;
// Keep strings heap-resident, matching the existing memory benchmark fixture.
const messagesPerEpoch = Math.max(1, Math.ceil((options.historicalMiB * 1024 * 1024) / (epochs * 256 * 1024)));
const payloadBytes = Math.floor((options.historicalMiB * 1024 * 1024) / (epochs * messagesPerEpoch));
for (let epoch = 0; epoch < epochs; epoch++) {
  for (let index = 0; index < messagesPerEpoch; index++) {
    const buffer = Buffer.alloc(payloadBytes, 65 + ((epoch * messagesPerEpoch + index) % 26));
    buffer.write(`epoch=${epoch};message=${index};`);
    manager.appendMessage({ role: "user", content: buffer.toString("ascii"), timestamp: epoch * 100 + index });
  }
  const anchor = manager.appendMessage({
    role: "user",
    content: `Retained anchor ${epoch}`,
    timestamp: epoch * 100 + 99,
  });
  manager.appendCompaction(`Native summary ${epoch}`, anchor, 65_000);
}
manager.appendMessage({ role: "user", content: "Current small tail", timestamp: 1000 });
const fixtureEntries = manager.getBranch().length;
const fetchGate = deferred();
const fetchStarted = deferred();
const ready = deferred();
const authStarted = deferred();
const authGate = deferred();
const providerAuthStarted = deferred();
const providerAuthGate = deferred();
const notifications = [];
const authTimings = [];
let applying = false;
let requests = 0;
let requestAuthCalls = 0;
let providerAuthCalls = 0;
const settings = {
  ...DEFAULT_CODEX_COMPACT_SETTINGS,
  asyncEnabled: true,
  asyncAutoApply: true,
  logCompaction: true,
  maxRetries: 0,
};
const state = () => ({ kind: "loaded", path: "/unused", settings, document: {} });
const runtime = {
  get: state,
  reload: async () => state(),
  update: async () => assert.fail("Benchmark must not modify settings"),
  flush: async () => {},
};
const events = new Map();
const pi = {
  on(name, callback) {
    events.set(name, [...(events.get(name) ?? []), callback]);
  },
  registerCommand() {},
  getActiveTools: () => [],
  getAllTools: () => [],
  getThinkingLevel: () => "off",
};
const waitForAuth = async (kind, started, gate) => {
  if (!applying) return;
  const before = clock();
  started.resolve();
  if (options.mode === "memory") await gate.promise;
  else if (options.authDelayMs) await new Promise((resolve) => setTimeout(resolve, options.authDelayMs));
  authTimings.push({ kind, ...elapsed(before) });
};
const ctx = {
  cwd: process.cwd(),
  model,
  sessionManager: manager,
  hasUI: true,
  mode: "tui",
  signal: new AbortController().signal,
  isIdle: () => false,
  hasPendingMessages: () => false,
  compact: () => assert.fail("Mid-run application must not abort work with ctx.compact()"),
  getSystemPrompt: () => "Apply latency fixture system prompt",
  // Force the production threshold gate, not a claim about actual fixture tokens.
  getContextUsage: () => ({ tokens: 65_000, contextWindow: 100_000, percent: 65 }),
  ui: {
    setStatus() {},
    notify(text) {
      notifications.push(text);
      if (text.includes("Async compaction ready:")) ready.resolve();
      if (text.includes("Warm-ahead paused")) throw new Error(text);
    },
  },
  modelRegistry: {
    getProvider: () => provider,
    async getApiKeyAndHeaders() {
      requestAuthCalls++;
      await waitForAuth("request", authStarted, authGate);
      return { ok: true, apiKey: "synthetic-no-credential" };
    },
    async getProviderAuth() {
      providerAuthCalls++;
      await waitForAuth("provider", providerAuthStarted, providerAuthGate);
      return { source: "OAuth", auth: { apiKey: "synthetic-no-credential" } };
    },
  },
};
createCodexCompactExtension({
  settingsRuntime: runtime,
  fetch: async () => {
    requests++;
    fetchStarted.resolve();
    await fetchGate.promise;
    const item = { type: "compaction", encrypted_content: "synthetic-opaque" };
    return new Response(
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
    );
  },
})(pi);
const emit = async (name, event) => {
  let result;
  for (const hook of events.get(name) ?? []) result = await hook(event, ctx);
  return result;
};
const timings = {};
try {
  await emit("session_start", {});
  await turn();
  process.send?.({ type: "ready" });
  process.disconnect?.();
  measure("baseline");
  let started = clock();
  await emit("turn_end", { outcome: "completed", entries: [] });
  await fetchStarted.promise;
  timings.preparing = elapsed(started);
  if (options.mode === "memory") measure("preparing");
  started = clock();
  fetchGate.resolve();
  await ready.promise;
  await turn();
  timings.finishPreparation = elapsed(started);
  if (options.mode === "memory") measure("ready");
  manager.appendMessage({
    ...message,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "fixture-tool", name: "read", arguments: {} }],
  });
  const tailId = manager.appendMessage({
    role: "toolResult",
    toolCallId: "fixture-tool",
    toolName: "read",
    content: [{ type: "text", text: "Newly completed tool output" }],
    isError: false,
    timestamp: 1001,
  });
  const beforeEntries = manager.getBranch().length;
  applying = true;
  started = clock();
  let pending = emit("turn_end", { outcome: "completed", entries: [] });
  if (options.mode === "memory") {
    await authStarted.promise;
    measure("apply-request-auth-pending");
    authGate.resolve();
    await providerAuthStarted.promise;
    measure("apply-provider-auth-pending");
    providerAuthGate.resolve();
  }
  let result = await pending;
  pending = undefined;
  timings.apply = { ...elapsed(started), auth: authTimings };
  assert.equal(result?.entries?.length, 1, "The actual turn_end hook must return exactly one draft");
  let draft = result.entries[0];
  assert.equal(draft.type, "compaction");
  assert.equal(draft.details.protocol, "context-management");
  assert.equal(manager.getBranch().length, beforeEntries, "Returning a draft must not commit");
  assert.equal(requests, 1, "Application must reuse the prepared request");
  assert.equal(providerCalls, 1, "No second provider request is allowed");
  assert.equal(requestAuthCalls, 2);
  assert.equal(providerAuthCalls, 2, "Exercise both awaited ChatGPT auth lookups at application");
  if (options.mode === "memory") measure("draft-returned");
  started = clock();
  manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 65_000, draft.details, true, draft.usage);
  await emit("turn_start", {});
  const projected = await emit("context", { messages: manager.buildSessionContext().messages });
  timings.nativeAppendAndReplay = elapsed(started);
  assert.ok(projected?.messages);
  assert.ok(manager.getBranch().some((entry) => entry.id === tailId));
  assert.ok(JSON.stringify(projected.messages).includes("Newly completed tool output"));
  assert.equal(notifications.filter((text) => text.includes("checkpoint committed at")).length, 1);
  result = undefined;
  draft = undefined;
  await turn();
  if (options.mode === "memory") measure("committed-job-released");
} finally {
  await emit("session_shutdown", {});
}
console.log(
  JSON.stringify({
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    mode: options.mode,
    fixture: {
      historicalBytes: payloadBytes * epochs * messagesPerEpoch,
      priorCompactions: epochs,
      entriesBeforeToolPair: fixtureEntries,
    },
    requests,
    providerCalls,
    requestAuthCalls,
    providerAuthCalls,
    timings,
    memory,
    diagnostics: notifications.filter((text) => /timing|duration/i.test(text)),
  }),
);
