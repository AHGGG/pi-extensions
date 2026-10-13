import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";

const model: Model<Api> = {
  id: "goal-compaction-fixture",
  name: "Goal compaction fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};

for (const goalFirst of [true, false]) {
  test(`real Pi manual compaction preserves active Goal bookkeeping (${goalFirst ? "Goal" : "Codex"} first)`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-goal-compaction-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      vi.resetModules();
      const { default: goal } = await import("../packages/pi-goal/src/index.js");
      const { createCodexCompactExtension } = await import("../packages/pi-codex-compact/src/codex-compact.js");
      const { DEFAULT_CODEX_COMPACT_SETTINGS } = await import("../packages/pi-codex-compact/src/settings.js");
      const specifier = "@earendil-works/pi-ai/providers/openai";
      const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("openai", async () => ({ type: "api_key", key: "fixture" }));
      const runtime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStorePath: join(directory, "models.json"),
        refreshOnCreate: false,
      });
      runtime.registerNativeProvider({
        ...openaiProvider(),
        streamSimple: () => {
          throw new Error("Unexpected ordinary inference during manual compaction");
        },
      });
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 100 },
        retry: { enabled: false },
      });
      const state = {
        kind: "loaded" as const,
        path: join(directory, "pi-codex-compact.json"),
        document: {},
        settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol: "responses-compact" as const, maxRetries: 0 },
      };
      let requests = 0;
      const compact = createCodexCompactExtension({
        settingsRuntime: {
          get: () => state,
          reload: async () => state,
          update: async () => state,
          flush: async () => {},
        },
        fetch: async (input) => {
          requests += 1;
          assert.match(String(input), /\/responses\/compact$/);
          return Response.json({
            output: [{ type: "compaction", encrypted_content: "fixture-opaque" }],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          });
        },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: goalFirst ? [goal, compact] : [compact, goal],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const manager = SessionManager.inMemory(directory);
      manager.appendMessage({ role: "user", content: "Earlier context ".repeat(1500), timestamp: 1 });
      manager.appendMessage({ role: "user", content: "Recent input ".repeat(100), timestamp: 2 });
      manager.appendCustomEntry("goal-state", {
        goal: {
          id: "fixture-goal",
          text: "Synthetic objective",
          status: "active",
          startedAt: 1,
          updatedAt: 1,
          iteration: 0,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          baselineTokens: 0,
        },
      });
      ({ session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime: runtime,
        model,
        resourceLoader,
        settingsManager,
        sessionManager: manager,
      }));
      await session.bindExtensions({ mode: "print" });
      const before = manager.getBranch();
      const countStates = () =>
        manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "goal-state").length;
      const beforeStates = countStates();
      await session.compact();
      assert.equal(requests, 1);
      assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
      assert.ok(countStates() > beforeStates, "Goal still persists its usage snapshot");
      assert.deepEqual(manager.getBranch().slice(0, before.length), before, "Raw history is preserved");
    } finally {
      if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
