import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { type TestContext, test } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";

import { createUsageSettingsRuntime } from "../src/settings.js";
import usageExtension from "../src/usage.js";

initTheme("dark", false);

const codexModel = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

async function fixture(
  t: TestContext,
  options: {
    enabled?: boolean;
    invalid?: boolean;
    model?: typeof codexModel;
    models?: unknown[];
    offline?: boolean;
    directoryFetch?: (signal: AbortSignal) => Promise<Response>;
    context?: Record<string, unknown>;
  } = {},
) {
  const model = options.model ?? codexModel;
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "menu-account" } }),
  ).toString("base64url");
  const credential = {
    type: "oauth" as const,
    access: `fixture.${payload}.signature`,
    refresh: "fixture-menu-refresh",
    expires: Date.now() + 60_000,
    accountId: "menu-account",
  };
  const directory = await mkdtemp(join(tmpdir(), "pi-fast-menu-test-"));
  const path = join(directory, "pi-usage.json");
  const originalDocument = options.invalid
    ? '{"codexFastMode":"invalid"}'
    : JSON.stringify({ codexFastMode: options.enabled ?? false });
  await writeFile(path, originalDocument);
  const settings = createUsageSettingsRuntime(path);
  await settings.reload();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let authReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname === "/backend-api/codex/models") {
      if (options.directoryFetch) return options.directoryFetch(init?.signal as AbortSignal);
      if (options.offline) throw new TypeError("The model directory is temporarily unavailable.");
      return Response.json({ models: options.models ?? [{ slug: model.id, service_tiers: [{ id: "priority" }] }] });
    }
    assert.equal(url.pathname, "/backend-api/wham/usage");
    return Response.json({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } } });
  };
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settings, credentialReader: () => credential });
  const titles: string[] = [];
  const choices: string[] = [];
  let selection: string[] = [];
  const current = createMockContext({
    hasUI: true,
    mode: "rpc",
    model,
    select: async (title: string, values: string[]) => {
      titles.push(title);
      selection = values;
      return choices.shift();
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        authReads += 1;
        return { ok: true as const, apiKey: credential.access };
      },
      getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: credential.access } }),
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: () => "OpenAI Codex",
    },
    ...options.context,
  });
  t.onTestFinished(async () => {
    try {
      for (const shutdown of mock.events.get("session_shutdown") ?? []) await shutdown({}, current.ctx);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    ...current,
    path,
    originalDocument,
    settings,
    mock,
    requests,
    get authReads() {
      return authReads;
    },
    titles,
    choices,
    get selection() {
      return selection;
    },
    open: () => mock.commands.get("usage")?.handler("", current.ctx),
  };
}

test("/usage discovers an unlisted model and toggles the same persistent Fast preference", async (t) => {
  const future = { ...codexModel, id: "future-menu-model", name: "Future Menu Model" };
  const f = await fixture(t, { model: future });
  f.choices.push("Turn Fast mode on", "Close");
  await f.open();
  assert.equal(f.settings.get().settings.codexFastMode, true);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).codexFastMode, true);
  assert.match(f.titles[0] ?? "", /Fast mode: Off/);
  assert.match(f.titles[0] ?? "", /1\.5× faster.*uses more/);
  assert.match(f.notifications[0]?.message ?? "", /Fast mode enabled/);
});

test("/usage cancellation preserves the stored Fast preference", async (t) => {
  const f = await fixture(t);
  await f.open();
  assert.ok(f.selection.includes("Turn Fast mode on"));
  assert.equal(f.settings.get().settings.codexFastMode, false);
  assert.equal(await readFile(f.path, "utf8"), f.originalDocument);
});

test.for([
  { name: "missing model", models: [], label: "Unknown" },
  { name: "missing capability fields", models: [{ slug: codexModel.id }], label: "Unknown" },
  {
    name: "explicit unsupported capability",
    models: [{ slug: codexModel.id, service_tiers: [] }],
    label: "Unavailable",
  },
])("/usage displays $name without offering an unsafe enable action", async ({ models, label }, t) => {
  const f = await fixture(t, { models });
  f.choices.push("Close");
  await f.open();
  assert.match(f.titles[0] ?? "", new RegExp(`Fast mode: ${label}`));
  assert.ok(!f.selection.includes("Turn Fast mode on"));
  assert.equal(await readFile(f.path, "utf8"), f.originalDocument);
});

test("/usage keeps its menu current when discovery refreshes an enabled Fast status", async (t) => {
  const f = await fixture(t, { enabled: true });
  f.choices.push("Close");
  await f.open();
  assert.match(f.titles[0] ?? "", /Fast mode: On/);
  assert.ok(f.selection.includes("Turn Fast mode off"));
  assert.equal(f.settings.get().settings.codexFastMode, true);
});

test("/usage can disable an enabled preference while discovery is unknown", async (t) => {
  const f = await fixture(t, { enabled: true, offline: true });
  f.choices.push("Turn Fast mode off", "Close");
  await f.open();
  assert.match(f.titles[0] ?? "", /Fast mode: Unknown/);
  assert.equal(f.settings.get().settings.codexFastMode, false);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).codexFastMode, false);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

test.for(["print", "json"] as const)("/usage rejects %s before authentication or directory I/O", async (mode, t) => {
  const f = await fixture(t, { context: { mode, hasUI: false } });
  await assert.rejects(Promise.resolve(f.open()), /requires TUI or RPC mode/);
  assert.equal(f.authReads, 0);
  assert.deepEqual(f.requests, []);
  assert.equal(await readFile(f.path, "utf8"), f.originalDocument);
});

test.for([
  { name: "Escape", input: "\u001b" },
  { name: "Ctrl+C", input: "\u0003" },
  { name: "remapped cancellation", input: "q", remapped: true },
  { name: "component disposal", dispose: true },
  { name: "session shutdown", shutdown: true },
  { name: "session replacement", replace: true },
  { name: "shared background request", input: "\u001b", background: true },
])("/usage cancels directory discovery through $name", async (scenario, t) => {
  const started = deferred<void>();
  let requestSignal: AbortSignal | undefined;
  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  let closeUi: (() => void) | undefined;
  let closing = false;
  let customCalls = 0;
  const f = await fixture(t, {
    directoryFetch: (signal) => {
      requestSignal = signal;
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Directory request cancelled", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
    context: {
      mode: "tui",
      select: undefined,
      custom: (factory: unknown) => {
        customCalls += 1;
        if (closing) return Promise.resolve(undefined);
        harness = createCustomSelectorHarness(
          factory,
          80,
          scenario.remapped
            ? {
                matches: (data, action) => action === "tui.select.cancel" && matchesKey(data, "q"),
                getKeys: (action) => (action === "tui.select.cancel" ? ["q"] : []),
              }
            : undefined,
        );
        return new Promise<unknown>((resolve) => {
          closeUi = () => resolve(undefined);
          void harness?.resultPromise.then(resolve);
        }).finally(() => harness?.dispose());
      },
    },
  });
  const shutdown = async () => {
    for (const handler of f.mock.events.get("session_shutdown") ?? []) await handler({}, f.ctx);
  };
  if (scenario.background) {
    await f.mock.events.get("model_select")?.at(-1)?.({ model: codexModel }, f.ctx);
    await started.promise;
  }
  const pending = Promise.resolve(f.open());
  try {
    await started.promise;
    // A shared request starts before the menu; synchronize on the menu's auth read too.
    if (scenario.background) {
      while (f.authReads < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(harness, "the cancellable loader must exist before awaiting directory I/O");
    if (scenario.shutdown) await shutdown();
    else if (scenario.replace) {
      const replacement = createMockContext({ hasUI: true, mode: "rpc" });
      for (const handler of f.mock.events.get("session_start") ?? []) await handler({}, replacement.ctx);
    } else if (scenario.dispose) {
      harness.dispose();
      closeUi?.();
    } else harness.handleInput(scenario.input ?? "\u001b");
    await pending;
    assert.equal(customCalls, 1, "cancellation must not open the quota loader or menu");
    assert.equal(requestSignal?.aborted, !scenario.background);
    assert.deepEqual(f.requests, ["/backend-api/codex/models"]);
    assert.equal(await readFile(f.path, "utf8"), f.originalDocument);
  } finally {
    closing = true;
    harness?.dispose();
    closeUi?.();
    await shutdown();
    await pending;
  }
});

test("invalid settings keep /usage Fast controls visibly read-only", async (t) => {
  const f = await fixture(t, { invalid: true });
  f.choices.push("Close");
  await f.open();
  assert.match(f.titles[0] ?? "", /Fast mode: Off/);
  assert.ok(f.selection.includes("Turn Fast mode on"));
  assert.equal(await readFile(f.path, "utf8"), f.originalDocument);
});
