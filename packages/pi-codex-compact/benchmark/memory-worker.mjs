import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureCheckpointPreparation } from "../src/prepared-compaction.js";
import { RejectedRoutes } from "../src/rejection-state.js";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

// All transport is injected. Any accidental use of real fetch fails closed.
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
const samples = [];
const measure = (phase, cycle) => {
  globalThis.gc();
  globalThis.gc();
  samples.push({ phase, cycle, ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS });
};
const model = {
  id: "memory-fixture",
  name: "Memory fixture",
  provider: "memory-fixture",
  api: "openai-codex-responses",
  baseUrl: "https://example.invalid",
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
const provider = {
  id: model.provider,
  name: "Memory fixture",
  auth: {},
  getModels: () => [model],
  stream(active, context, streamOptions) {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        await streamOptions.onPayload(
          {
            model: active.id,
            input: context.messages.map((entry) => ({
              role: "user",
              content: [{ type: "input_text", text: JSON.stringify(entry.content) }],
            })),
          },
          active,
        );
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
// Smaller flat strings stay heap-resident instead of crossing V8's external-string
// allocation threshold for large Buffer.toString() results.
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
let fetchGate;
let fetchStarted;
let authGate;
let authStarted;
let requests = 0;
const settings = { ...DEFAULT_CODEX_COMPACT_SETTINGS, maxRetries: 0 };
const runtime = { get: () => ({ kind: "loaded", path: "/unused", settings, document: {} }) };
const pi = { getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off" };
const ctx = {
  cwd: process.cwd(),
  model,
  sessionManager: manager,
  hasUI: false,
  mode: "json",
  getSystemPrompt: () => "Memory fixture system prompt",
  // Report representative usage without allocating a large active context.
  getContextUsage: () => ({ tokens: 65_000, contextWindow: 100_000, percent: 65 }),
  ui: { setStatus() {}, notify() {} },
  modelRegistry: {
    getProvider: () => provider,
    async getApiKeyAndHeaders() {
      if (authGate) {
        authStarted.resolve();
        await authGate.promise;
      }
      return { ok: true, apiKey: "synthetic-no-credential" };
    },
  },
};
const fetch = async () => {
  requests++;
  fetchStarted.resolve();
  await fetchGate.promise;
  const item = { type: "compaction", encrypted_content: "synthetic-opaque" };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
  );
};
await turn();
measure("baseline", 0);
const timings = [];
for (let cycle = 0; cycle < options.cycles; cycle++) {
  fetchGate = deferred();
  fetchStarted = deferred();
  const owner = new AbortController();
  const started = performance.now();
  let preparation = captureCheckpointPreparation(
    pi,
    ctx,
    runtime,
    owner.signal,
    new RejectedRoutes(),
    () => true,
    () => {},
    fetch,
  );
  assert.ok(preparation);
  const guard = { signal: owner.signal, isCurrent: () => true, ownsStatus: () => true };
  let pending = preparation.start(guard);
  preparation = undefined;
  let job;
  await Promise.race([
    fetchStarted.promise,
    pending.then(() => {
      throw new Error("Preparation ended before transport");
    }),
  ]);
  timings.push({ cycle, preparingMs: performance.now() - started });
  measure("preparing", cycle);
  if (cycle % 2 === 1) {
    owner.abort();
    fetchGate.resolve();
    job = await pending;
    assert.equal(job.usable, false);
  } else {
    fetchGate.resolve();
    job = await pending;
    assert.equal(job.usable, true);
    await turn();
    measure("ready", cycle);
    authGate = deferred();
    authStarted = deferred();
    let adoption = job.draft(ctx, guard);
    await Promise.race([
      authStarted.promise,
      adoption.then(() => {
        throw new Error(`Draft ended before auth refresh: ${job.reason}`);
      }),
    ]);
    measure("adoption-auth-pending", cycle);
    authGate.resolve();
    const result = await adoption;
    assert.ok(result.draft, result.reason);
    adoption = undefined;
    authGate = undefined;
    authStarted = undefined;
    measure("adopted-draft", cycle);
  }
  owner.abort();
  pending = undefined;
  job = undefined;
  fetchGate = undefined;
  fetchStarted = undefined;
  await turn();
  await turn();
  measure("released", cycle);
}
assert.equal(requests, options.cycles);
console.log(
  JSON.stringify({
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    fixture: {
      historicalBytes: payloadBytes * epochs * messagesPerEpoch,
      priorCompactions: epochs,
      entries: manager.getBranch().length,
    },
    requests,
    timings,
    samples,
  }),
);
