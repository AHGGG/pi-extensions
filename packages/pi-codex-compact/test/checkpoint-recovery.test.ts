import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { type Api, createAssistantMessageEventStream, type Model, type Provider } from "@earendil-works/pi-ai";
import { compact, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { checkpointMarker, fingerprintMessage } from "../src/checkpoint.js";
import { recoverCheckpoint, summaryPrefix } from "../src/checkpoint-recovery.js";
import type { RemoteCompactionRequest } from "../src/remote-types.js";

const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const messageItem = {
  type: "message",
  id: "msg_summary",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Earlier assistant fact: sapphire. Pending: run tests.", annotations: [] }],
};
const event: SessionBeforeCompactEvent = {
  type: "session_before_compact",
  branchEntries: [],
  reason: "manual",
  willRetry: false,
  signal: new AbortController().signal,
  customInstructions: "Keep pending tasks.",
  preparation: {
    firstKeptEntryId: "tail",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    fileOps: {
      read: new Set(["read.ts", "changed.ts"]),
      written: new Set(["changed.ts"]),
      edited: new Set(["edited.ts"]),
    },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  },
};

function sse(
  output: unknown[] = [messageItem],
  status = "completed",
  terminal = "response.completed",
  includeTerminal = true,
  terminalOutput: unknown[] = output,
) {
  const response = {
    id: "resp_summary",
    object: "response",
    created_at: 1,
    model: "gpt-5.5",
    status,
    output: terminalOutput,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    ...output.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item },
      { type: "response.output_item.done", output_index, item },
    ]),
    ...(includeTerminal ? [{ type: terminal, response }] : []),
  ];
  return new Response(events.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function request(api: Api = "openai-responses"): Promise<RemoteCompactionRequest> {
  const codex = api === "openai-codex-responses";
  const azure = api === "azure-openai-responses";
  const specifier = codex
    ? "@earendil-works/pi-ai/providers/openai-codex"
    : azure
      ? "@earendil-works/pi-ai/providers/azure"
      : "@earendil-works/pi-ai/providers/openai";
  const module = (await import(specifier)) as Record<string, () => Provider>;
  const provider = module[codex ? "openaiCodexProvider" : azure ? "azureProvider" : "openaiProvider"]();
  const model: Model<Api> = {
    id: "gpt-5.5",
    name: "fixture",
    api,
    provider: provider.id,
    baseUrl: codex
      ? "https://chatgpt.com/backend-api/codex"
      : azure
        ? "https://example.openai.azure.com/openai/v1"
        : "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 10000,
  };
  const access = codex
    ? `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })).toString("base64url")}.signature`
    : "fixture-key";
  return {
    provider,
    model,
    protocol: "responses-compact",
    profile: codex ? "codex-responses-v1" : "openai-responses-v1",
    apiKey: access,
    signal: event.signal,
    maxRetries: 0,
    requestTimeoutMs: 30000,
    context: {
      systemPrompt: "original instructions",
      messages: [
        { role: "user", content: [{ type: "text", text: checkpointMarker("old") }], timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "recent work before retained tail" }], timestamp: 2 },
      ],
      tools: [],
    },
    priorCheckpoint: {
      marker: checkpointMarker("old"),
      replacementHistory: [{ type: "compaction", encrypted_content: "opaque-only-assistant-fact" }],
    },
  };
}

for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"] as const) {
  test(`${api}: actual adapter injects checkpoint into summary inference and publishes text with Pi cut point`, async () => {
    const input = await request(api);
    let payload: Record<string, unknown> | undefined;
    input.fetch = async (_url, init) => {
      payload = JSON.parse(
        typeof init?.body === "string" ? init.body : zlib.zstdDecompressSync(init?.body as Uint8Array).toString("utf8"),
      );
      // Mocked recall proves request plumbing, not hosted model understanding.
      assert.ok(JSON.stringify(payload).includes("opaque-only-assistant-fact"));
      return sse([messageItem], "completed", api === "openai-codex-responses" ? "response.done" : "response.completed");
    };
    const result = await recoverCheckpoint(input, event);
    assert.match(result.summary, /sapphire/);
    assert.equal(result.firstKeptEntryId, "tail");
    assert.equal(result.tokensBefore, 100);
    assert.deepEqual(result.details, { readFiles: ["read.ts"], modifiedFiles: ["changed.ts", "edited.ts"] });
    assert.match(result.summary, /<read-files>[\s\S]*read.ts/);
    assert.match(JSON.stringify(payload), /Keep pending tasks/);
    assert.doesNotMatch(
      JSON.stringify(payload),
      /PI_CODEX_REMOTE_CHECKPOINT|compaction_trigger|context_management|previous_response_id/,
    );
    assert.deepEqual(payload?.tools, []);
    assert.equal(payload?.tool_choice, "none");
    assert.equal(payload?.store, false);
    assert.equal(JSON.stringify(payload).split("opaque-only-assistant-fact").length - 1, 1);
  });
}

function textItem(id: string, parts: string[]) {
  return {
    ...messageItem,
    id,
    content: parts.map((text) => ({ type: "output_text", text, annotations: [] })),
  };
}

for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"] as const) {
  for (const [name, output, expected] of [
    ["multipart message", [textItem("one", ["sap", "phire"])], "sapphire"],
    ["whitespace and empty parts", [textItem("one", ["", " task", "\n", "", "next "])], " task\nnext "],
    [
      "distinct multipart messages",
      [textItem("one", ["first", " detail"]), textItem("two", ["second", " detail"])],
      "first detail\nsecond detail",
    ],
    [
      "interspersed reasoning",
      [
        textItem("one", ["first", " detail"]),
        { type: "reasoning", id: "reasoning", summary: [{ type: "summary_text", text: "not summary text" }] },
        textItem("two", ["second", " detail"]),
      ],
      "first detail\nsecond detail",
    ],
    ["empty message boundary", [textItem("empty", []), textItem("two", ["sap", "phire"])], "\nsapphire"],
  ] as const) {
    test(`${api}: recovery preserves ${name} using actual adapter text grouping`, async () => {
      const input = await request(api);
      input.fetch = async () =>
        sse([...output], "completed", api === "openai-codex-responses" ? "response.done" : "response.completed");
      const result = await recoverCheckpoint(input, event);
      assert.equal(result.summary.split("\n\n<read-files>")[0], expected);
      assert.equal(result.firstKeptEntryId, "tail");
      assert.deepEqual(result.details, { readFiles: ["read.ts"], modifiedFiles: ["changed.ts", "edited.ts"] });
    });
  }

  test(`${api}: actual adapter recovers complete streamed messages when terminal output is empty`, async () => {
    const input = await request(api);
    input.fetch = async () =>
      sse(
        [
          textItem("one", ["sap", "phire"]),
          { type: "reasoning", id: "thought", summary: [] },
          textItem("two", ["next", " task"]),
        ],
        "completed",
        api === "openai-codex-responses" ? "response.done" : "response.completed",
        true,
        [],
      );
    const result = await recoverCheckpoint(input, event);
    assert.equal(result.summary.split("\n\n<read-files>")[0], "sapphire\nnext task");
  });

  test(`${api}: multipart normalization still rejects terminal text conflicting with completed message`, async () => {
    const input = await request(api);
    input.fetch = async () =>
      sse(
        [textItem("one", ["sap", "fire"])],
        "completed",
        api === "openai-codex-responses" ? "response.done" : "response.completed",
        true,
        [textItem("one", ["sap", "phire"])],
      );
    await assert.rejects(recoverCheckpoint(input, event), /terminal text conflicts with provider completion/);
  });
}

for (const [name, output, status, terminal] of [
  ["empty", [], "completed", true],
  ["message without text parts", [textItem("empty", [])], "completed", true],
  ["blank", [{ ...messageItem, content: [{ type: "output_text", text: "  ", annotations: [] }] }], "completed", true],
  ["tool", [{ type: "function_call", id: "fc", call_id: "c", name: "do_work", arguments: "{}" }], "completed", true],
  ["refusal", [{ ...messageItem, content: [{ type: "refusal", refusal: "no" }] }], "completed", true],
  ["partial", [messageItem], "incomplete", true],
  ["missing terminal", [messageItem], "completed", false],
] as const) {
  test(`recovery rejects ${name} output`, async () => {
    const input = await request();
    input.fetch = async () => sse([...output], status, "response.completed", terminal);
    await assert.rejects(recoverCheckpoint(input, event));
  });
}

test("recovery bounds request bodies and rejects a missing marker before dispatch", async () => {
  const input = await request();
  input.context.messages = [{ role: "user", content: [{ type: "text", text: "missing marker" }], timestamp: 1 }];
  input.fetch = async () => assert.fail("unsafe request must not dispatch");
  await assert.rejects(recoverCheckpoint(input, event));
  input.context.messages = [{ role: "user", content: [{ type: "text", text: checkpointMarker("old") }], timestamp: 1 }];
  assert.ok(input.priorCheckpoint);
  input.priorCheckpoint.replacementHistory = [{ type: "compaction", encrypted_content: "x".repeat(9 * 1024 * 1024) }];
  await assert.rejects(recoverCheckpoint(input, event));
});

test("recovery releases a hung provider on cancellation and timeout", async () => {
  for (const cancel of [true, false]) {
    vi.useFakeTimers();
    try {
      const input = await request();
      const controller = new AbortController();
      input.signal = controller.signal;
      let observed: AbortSignal | undefined;
      input.provider = {
        ...input.provider,
        stream: (_model, _context, options) => {
          observed = options?.signal;
          return createAssistantMessageEventStream();
        },
      };
      const pending = recoverCheckpoint(input, event);
      const failure = assert.rejects(pending);
      if (cancel) controller.abort();
      else await vi.advanceTimersByTimeAsync(30000);
      await failure;
      assert.equal(observed?.aborted, true);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      vi.useRealTimers();
    }
  }
});

test("summary prefix excludes the exact retained tail and fails closed on mismatches", () => {
  const prefix = { role: "user" as const, content: [{ type: "text" as const, text: "prefix" }], timestamp: 1 };
  const tail = { ...prefix, content: [{ type: "text" as const, text: "tail" }], timestamp: 2 };
  assert.deepEqual(summaryPrefix([prefix, tail], [tail], fingerprintMessage), [prefix]);
  assert.throws(() => summaryPrefix([prefix], [tail], fingerprintMessage));
  assert.throws(() => summaryPrefix([], [tail], fingerprintMessage));
});

test("actual Pi native compact cannot consume opaque checkpoint and returns only native details", async () => {
  const input = await request();
  let serialized = "";
  const result = await compact(
    {
      ...event.preparation,
      messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "recent work" }], timestamp: 1 }],
      previousSummary: "Responses checkpoint stores older history opaquely.",
    },
    input.model,
    "fixture",
    undefined,
    undefined,
    undefined,
    undefined,
    (_model, context) => {
      serialized = JSON.stringify(context);
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "recent summary" }],
        api: input.model.api,
        provider: input.model.provider,
        model: input.model.id,
        usage,
        stopReason: "stop" as const,
        timestamp: 2,
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  );
  assert.match(serialized, /older history opaquely/);
  assert.doesNotMatch(serialized, /opaque-only-assistant-fact/);
  assert.equal(result.summary.startsWith("recent summary"), true);
  assert.deepEqual(result.details, { readFiles: ["read.ts"], modifiedFiles: ["changed.ts", "edited.ts"] });
});

for (const bytes of [3 * 1024 * 1024, 9 * 1024 * 1024]) {
  test(`recovery rejects oversized ${bytes > 8 * 1024 * 1024 ? "stream" : "summary"}`, async () => {
    const input = await request();
    input.fetch = async () =>
      sse([{ ...messageItem, content: [{ type: "output_text", text: "x".repeat(bytes), annotations: [] }] }]);
    await assert.rejects(recoverCheckpoint(input, event));
  });
}

test("synchronous aborting provider failure does not leave unhandled rejection or timers", async () => {
  const input = await request();
  const controller = new AbortController();
  input.signal = controller.signal;
  input.provider = {
    ...input.provider,
    stream: () => {
      controller.abort();
      throw new Error("provider failed");
    },
  };
  await assert.rejects(recoverCheckpoint(input, event), /provider failed/);
});

test("recovery rejects multiple successful HTTP attempts even with matching empty-terminal text", async () => {
  const input = await request();
  input.fetch = async () => sse([messageItem], "completed", "response.completed", true, []);
  const provider = input.provider;
  let bridgeFailure: unknown;
  input.provider = {
    ...provider,
    stream: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        assert.ok(options?.fetch);
        // A custom provider retries after a successful HTTP response. The recovery
        // validator must not combine successful response attempts into one result.
        const first = await options.fetch("https://fixture.invalid/recovery");
        await first.body?.cancel();
        for await (const item of provider.stream(model, context, options)) stream.push(item);
      })()
        .catch((error: unknown) => {
          bridgeFailure = error;
        })
        .finally(() => stream.end());
      return stream;
    },
  };
  await assert.rejects(recoverCheckpoint(input, event), /without validated completion/);
  assert.equal(bridgeFailure, undefined);
});
