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
import type { JsonObject } from "../src/protocol.js";

const model: Model<Api> = {
  id: "context-management-runtime",
  name: "Context Management runtime fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
const checkpoint = { type: "compaction", id: "cmp_runtime", encrypted_content: "opaque-runtime-fixture" };
const maintenanceOutput = {
  type: "message",
  id: "msg_maintenance",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "OK", annotations: [] }],
};

// The hosted model is replaced only at the transport boundary. Pi owns compaction,
// persistence, context projection, provider hooks, continuation, and settlement.
function response(text: string, inputTokens: number, maintenance: boolean): Response {
  const item = maintenance
    ? maintenanceOutput
    : {
        ...maintenanceOutput,
        id: "msg_task",
        content: [{ type: "output_text", text, annotations: [] }],
      };
  const outputIndex = maintenance ? 1 : 0;
  const events = [
    ...(maintenance ? [{ type: "response.output_item.done", output_index: 0, item: checkpoint }] : []),
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: outputIndex, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: outputIndex, item },
    {
      type: "response.completed",
      response: {
        id: "resp_runtime",
        status: "completed",
        output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 3, total_tokens: inputTokens + 3 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

for (const trigger of ["overflow", "threshold", "pre-prompt"] as const) {
  test(`real Pi ${trigger} compaction scopes maintenance and preserves ordinary replay`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-management-runtime-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      vi.resetModules();
      const { createCodexCompactExtension } = await import("../src/codex-compact.js");
      const { DEFAULT_CODEX_COMPACT_SETTINGS } = await import("../src/settings.js");
      const specifier = "@earendil-works/pi-ai/providers/openai";
      const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
      const native = openaiProvider();
      const requests: JsonObject[] = [];
      let ordinaryRequests = 0;
      const fixtureFetch: typeof fetch = async (_input, init) => {
        const payload: JsonObject = JSON.parse(String(init?.body));
        requests.push(payload);
        if (payload.context_management) return response("OK", 20, true);
        ordinaryRequests += 1;
        if (trigger === "overflow" && ordinaryRequests === 1) {
          return Response.json(
            { error: { message: "maximum context length exceeded", code: "context_length_exceeded" } },
            { status: 400 },
          );
        }
        const inputTokens = trigger === "threshold" && ordinaryRequests === 1 ? 90_000 : 20;
        return response("task response", inputTokens, false);
      };
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("openai", async () => ({ type: "api_key", key: "runtime-fixture" }));
      const modelRuntime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStorePath: join(directory, "models-store.json"),
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider({
        ...native,
        streamSimple: (activeModel, context, options) =>
          native.streamSimple(activeModel, context, { ...options, fetch: fixtureFetch }),
      });
      const state = {
        kind: "loaded" as const,
        path: join(directory, "pi-codex-compact.json"),
        document: {},
        settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol: "context-management" as const },
      };
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 15_000, keepRecentTokens: 10_000 },
        retry: { enabled: false },
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
        extensionFactories: [
          createCodexCompactExtension({
            fetch: fixtureFetch,
            settingsRuntime: {
              get: () => state,
              reload: async () => state,
              update: async () => state,
              flush: async () => {},
            },
          }),
        ],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const sessionManager = SessionManager.inMemory(directory);
      for (let index = 0; index < 4; index += 1) {
        sessionManager.appendMessage({
          role: "user",
          content: `Older task history ${"data ".repeat(4000)}`,
          timestamp: Date.now() - 10_000 + index * 2,
        });
        sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "Still working on the pending task." }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: trigger === "pre-prompt" ? 90_000 : 20_000,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: trigger === "pre-prompt" ? 90_010 : 20_010,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now() - 10_000 + index * 2 + 1,
        });
      }
      ({ session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime,
        model,
        resourceLoader,
        settingsManager,
        sessionManager,
        tools: ["read"],
      }));
      await session.bindExtensions({ mode: "print" });
      const compactionEvents: Array<{ reason: string; willRetry: boolean }> = [];
      session.subscribe((event) => {
        if (event.type === "compaction_end") compactionEvents.push(event);
      });
      await session.prompt("Complete the pending task.");
      assert.equal(requests.length, trigger === "overflow" ? 3 : 2);
      assert.equal(session.isIdle, true);
      assert.match(JSON.stringify(session.messages.at(-1)), /task response/);
      assert.doesNotMatch(JSON.stringify(session.messages), /msg_maintenance|PI_CONTEXT_COMPACTION_V1/);
      const compactions = sessionManager.getBranch().filter((entry) => entry.type === "compaction");
      assert.equal(compactions.length, 1);
      assert.equal(compactions[0].fromHook, true);
      assert.equal(compactionEvents.length, 1);
      assert.equal(compactionEvents[0].willRetry, trigger === "overflow");
      assert.equal(compactionEvents[0].reason, trigger === "overflow" ? "overflow" : "threshold");
      const maintenanceRequests = requests.filter((payload) => payload.context_management);
      assert.equal(maintenanceRequests.length, 1);
      const maintenanceInput = maintenanceRequests[0].input as JsonObject[];
      assert.match(
        JSON.stringify(maintenanceInput.at(-1)),
        /This maintenance instruction expires when this response completes\./,
      );
      const persisted = compactions[0].details as { replacementHistory: JsonObject[] };
      assert.deepEqual(persisted.replacementHistory, [checkpoint, maintenanceOutput]);
      assert.equal(maintenanceRequests[0].tool_choice, "none");

      // Threshold compaction must not force another turn after a normal stop.
      // A later user request replays the checkpoint through Pi's normal path.
      await session.prompt("Continue the task with the next step.");
      const maintenanceIndex = requests.indexOf(maintenanceRequests[0]);
      const replayRequests = requests.slice(maintenanceIndex + 1);
      assert.equal(replayRequests.length, trigger === "threshold" ? 1 : 2);
      for (const payload of replayRequests) {
        const input = payload.input as JsonObject[];
        const checkpointIndex = input.findIndex((item) => item.type === "compaction");
        assert.ok(checkpointIndex >= 0);
        assert.deepEqual(input.slice(checkpointIndex, checkpointIndex + 2), [checkpoint, maintenanceOutput]);
        assert.doesNotMatch(JSON.stringify(payload), /PI_CONTEXT_COMPACTION_V1|compact_threshold/);
        assert.notEqual(payload.tool_choice, "none");
        assert.equal(input.filter((item) => item.type === "compaction").length, 1);
        assert.match(JSON.stringify(payload.tools), /"name":"read"/);
      }
      if (replayRequests.length === 2) {
        const baseline = replayRequests[0];
        const next = replayRequests[1];
        assert.deepEqual(
          (next.input as JsonObject[]).slice(0, (baseline.input as JsonObject[]).length),
          baseline.input,
        );
        assert.deepEqual(next.tools, baseline.tools);
        assert.equal(next.instructions, baseline.instructions);
      }
      assert.equal(requests.filter((payload) => payload.context_management).length, 1);
    } finally {
      session?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
