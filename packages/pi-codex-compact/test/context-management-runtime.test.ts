import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { latestCheckpoint } from "../src/checkpoint.js";
import { COMPACTION_MAINTENANCE_MESSAGE, COMPACTION_REPLAY_MESSAGE } from "../src/context-management.js";
import type { JsonObject } from "../src/protocol.js";

const model: Model<"openai-responses"> = {
  id: "gpt-5.5",
  name: "Context Management runtime fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://pi-compaction.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 20_000,
  maxTokens: 2_000,
};

const checkpoint = { type: "compaction", id: "cmp_runtime", encrypted_content: "opaque-runtime-state" };
const reasoning = { type: "reasoning", id: "rs_runtime", summary: [], encrypted_content: "signed-runtime-state" };
function assistant(text: string, id = "msg_runtime"): JsonObject {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}
const maintenance = [checkpoint, reasoning, assistant("OK", "msg_maintenance")];

function toolCall(name: string): JsonObject {
  return {
    type: "function_call",
    id: `fc_${name}`,
    call_id: `call_${name}`,
    name,
    arguments: "{}",
    status: "completed",
  };
}

function response(items: JsonObject[], inputTokens = 64): Response {
  const events = [
    ...items.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    {
      type: "response.completed",
      response: {
        id: "resp_runtime",
        status: "completed",
        output: items,
        usage: { input_tokens: inputTokens, output_tokens: 16, total_tokens: inputTokens + 16 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function input(payload: JsonObject): JsonObject[] {
  assert.ok(Array.isArray(payload.input));
  return payload.input as JsonObject[];
}

function replayNote(items: JsonObject[]): JsonObject[] {
  return items.filter((item) => JSON.stringify(item).includes(COMPACTION_REPLAY_MESSAGE));
}

type Harness = {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  sessionManager: SessionManager;
  requests: JsonObject[];
};

async function withSession(
  responder: (payload: JsonObject) => Response | Promise<Response>,
  run: (harness: Harness) => Promise<void>,
  customTools: ToolDefinition[] = [],
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-compaction-handoff-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let session: Harness["session"] | undefined;
  try {
    vi.resetModules();
    const { createCodexCompactExtension } = await import("../src/codex-compact.js");
    const { DEFAULT_CODEX_COMPACT_SETTINGS } = await import("../src/settings.js");
    // Exercise Pi's actual Responses serializer/parser without making a live request.
    const specifier = "@earendil-works/pi-ai/providers/openai";
    const { openaiProvider } = (await import(specifier)) as typeof import("@earendil-works/pi-ai/providers/openai");
    const native = openaiProvider();
    const requests: JsonObject[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      assert.equal(String(url), `${model.baseUrl}/responses`);
      const payload = JSON.parse(String(init?.body)) as JsonObject;
      requests.push(structuredClone(payload));
      return responder(payload);
    };
    const provider: Provider<"openai-responses"> = {
      ...native,
      getModels: () => [model],
      getAllModels: () => [model],
      refreshModels: undefined,
      stream(activeModel, context, options) {
        return native.stream<"openai-responses">(activeModel, context, { ...options, fetch: options?.fetch ?? fetch });
      },
      streamSimple(activeModel, context, options) {
        return native.streamSimple(activeModel, context, { ...options, fetch: options?.fetch ?? fetch });
      },
    };
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(directory, "models-store.json"),
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(provider);
    await modelRuntime.setRuntimeApiKey(model.provider, "fixture-key");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 1_000 },
      retry: { enabled: false },
    });
    const state = {
      kind: "loaded" as const,
      path: join(directory, "pi-codex-compact.json"),
      settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol: "context-management" as const, maxRetries: 0 },
      document: {},
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        createCodexCompactExtension({
          fetch,
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
        }),
      ],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(directory);
    const created = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
      customTools,
      noTools: "builtin",
      thinkingLevel: "off",
    });
    session = created.session;
    assert.deepEqual(created.extensionsResult.errors, []);
    await session.bindExtensions({ mode: "print" });
    await run({ session, sessionManager, requests });
  } finally {
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
}

test("automatic compaction hands tool work back to Pi without a fresh user message or visible maintenance answer", async () => {
  const actions: string[] = [];
  let ordinaryRequests = 0;
  await withSession(
    (payload) => {
      if (payload.context_management) return response(maintenance);
      ordinaryRequests += 1;
      if (ordinaryRequests === 1) return response([toolCall("write_fixture")], 17_000);
      if (ordinaryRequests === 2) return response([toolCall("verify_fixture")]);
      return response([assistant("User task complete.")]);
    },
    async ({ session, sessionManager, requests }) => {
      await session.prompt("Write the fixture, verify it, and report the result.");
      assert.equal(session.isIdle, true);
      assert.deepEqual(actions, ["write", "verify"]);
      assert.equal(ordinaryRequests, 3);
      assert.equal(requests.length, 4);
      const maintenanceRequest = requests[1];
      assert.deepEqual(maintenanceRequest.context_management, [{ type: "compaction", compact_threshold: 1024 }]);
      assert.equal(maintenanceRequest.tool_choice, "none");
      assert.deepEqual(input(maintenanceRequest).at(-1), {
        role: "user",
        content: [{ type: "input_text", text: COMPACTION_MAINTENANCE_MESSAGE }],
      });
      const resumed = requests[2];
      const resumedInput = input(resumed);
      const checkpointIndex = resumedInput.findIndex((item) => item.type === "compaction");
      assert.ok(checkpointIndex >= 0);
      assert.deepEqual(resumedInput.slice(checkpointIndex, checkpointIndex + maintenance.length), maintenance);
      assert.equal(resumedInput[checkpointIndex + maintenance.length].role, "developer");
      assert.equal(replayNote(resumedInput).length, 1);
      assert.equal(
        resumedInput.some((item) => item.role === "user"),
        false,
      );
      assert.equal(resumed.context_management, undefined);
      assert.notEqual(resumed.tool_choice, "none");
      assert.equal(resumed.instructions, requests[0].instructions);
      assert.deepEqual(resumed.tools, requests[0].tools);
      assert.deepEqual(input(requests[3]).slice(0, resumedInput.length), resumedInput);
      assert.deepEqual(requests[3].tools, resumed.tools);
      assert.equal(replayNote(input(requests[3])).length, 1);
      assert.deepEqual(latestCheckpoint(sessionManager.getBranch())?.details.replacementHistory, maintenance);
      assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
      const messages = sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
      assert.equal(messages.filter((message) => message.role === "user").length, 1);
      assert.equal(
        messages.some(
          (message) =>
            message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text === "OK"),
        ),
        false,
      );
    },
    [
      {
        name: "write_fixture",
        label: "Write fixture",
        description: "Write the fixture once",
        parameters: Type.Object({}),
        async execute() {
          actions.push("write");
          return { content: [{ type: "text", text: `WRITE_DONE:${"x".repeat(6_000)}` }], details: {} };
        },
      },
      {
        name: "verify_fixture",
        label: "Verify fixture",
        description: "Verify the completed write",
        parameters: Type.Object({}),
        async execute() {
          actions.push("verify");
          return { content: [{ type: "text", text: "Verified the completed write." }], details: {} };
        },
      },
    ],
  );
});

test("manual compaction stays idle and reload preserves the handoff before a newer user request", async () => {
  let ordinaryRequests = 0;
  await withSession(
    (payload) => {
      if (payload.context_management) return response(maintenance);
      ordinaryRequests += 1;
      return response([assistant(ordinaryRequests === 1 ? `Task complete. ${"x".repeat(6_000)}` : "OK")]);
    },
    async ({ session, sessionManager, requests }) => {
      await session.prompt("Complete the task and provide a detailed report.");
      assert.equal(session.isIdle, true);
      await session.compact();
      assert.equal(session.isIdle, true);
      assert.equal(ordinaryRequests, 1);
      assert.equal(requests.length, 2);
      assert.deepEqual(latestCheckpoint(sessionManager.getBranch())?.details.replacementHistory, maintenance);
      await session.reload();
      assert.equal(ordinaryRequests, 1);
      const newerRequest = "That task is finished. For this new request, reply only OK.";
      await session.prompt(newerRequest);
      assert.equal(ordinaryRequests, 2);
      const replayed = input(requests.at(-1) as JsonObject);
      assert.equal(replayNote(replayed).length, 1);
      assert.match(JSON.stringify(replayed.at(-1)), /For this new request, reply only OK/);
      assert.equal(replayed.filter((item) => item.role === "user").length, 1);
      assert.equal(session.isIdle, true);
    },
  );
});

test("cancelled maintenance publishes no checkpoint or continuation state", async () => {
  let started!: () => void;
  const maintenanceStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let bodyCancelled = false;
  let ordinaryRequests = 0;
  await withSession(
    (payload) => {
      if (payload.context_management) {
        started();
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              bodyCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      ordinaryRequests += 1;
      return response([assistant(ordinaryRequests === 1 ? `Finished. ${"x".repeat(6_000)}` : "New request handled.")]);
    },
    async ({ session, sessionManager, requests }) => {
      await session.prompt("Complete the task.");
      const originalIds = sessionManager.getBranch().map((entry) => entry.id);
      const rejected = assert.rejects(session.compact(), /cancel/i);
      await maintenanceStarted;
      session.abortCompaction();
      await rejected;
      assert.equal(bodyCancelled, true);
      assert.equal(session.isIdle, true);
      assert.equal(ordinaryRequests, 1);
      assert.deepEqual(
        sessionManager.getBranch().map((entry) => entry.id),
        originalIds,
      );
      assert.equal(latestCheckpoint(sessionManager.getBranch()), undefined);
      await session.prompt("Handle a new request.");
      assert.equal(ordinaryRequests, 2);
      assert.equal(replayNote(input(requests.at(-1) as JsonObject)).length, 0);
    },
  );
});
