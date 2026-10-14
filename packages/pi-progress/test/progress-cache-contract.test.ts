import assert from "node:assert/strict";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { ProgressParameters } from "../src/progress-state.js";
import progressWidgetExtension, {
  PROGRESS_DETAILS_VERSION,
  type ProgressStep,
  reconcileProgressContext,
  TOOL_NAME,
} from "../src/progress-widget.js";
import { progressToolCallMessage } from "./progress-harness.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  constrainedSampling?: boolean;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

function registeredProgressTool(): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(definition: RegisteredTool) {
      tools.push(definition);
    },
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI;
  progressWidgetExtension(pi);
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.ok(tool);
  return tool;
}

function normalizedRequest(messages: ContextEvent["messages"]) {
  const tool = registeredProgressTool();
  return {
    effectiveSystemGuidance: [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].filter(
      (value): value is string => typeof value === "string",
    ),
    activeToolNames: [tool.name],
    toolDefinitions: [
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        constrainedSampling: tool.constrainedSampling,
      },
    ],
    messages: convertToLlm(messages),
  };
}

function userMessage(text: string): ContextEvent["messages"][number] {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistantText(text: string): ContextEvent["messages"][number] {
  return assistantMessage([{ type: "text", text }], "stop");
}

function progressToolCall(steps: readonly ProgressStep[], id: string): ContextEvent["messages"][number] {
  return assistantMessage(
    [{ type: "toolCall", id, name: TOOL_NAME, arguments: { steps: progressJson(steps) } }],
    "toolUse",
  );
}

function assistantMessage(
  content: Extract<ContextEvent["messages"][number], { role: "assistant" }>["content"],
  stopReason: "stop" | "toolUse",
): ContextEvent["messages"][number] {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "cache-contract",
    model: "cache-contract",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function progressJson(steps: readonly ProgressStep[]): JsonValue {
  return steps.map((step) => ({
    text: step.text,
    status: step.status,
  }));
}

function progressToolResult(steps: readonly ProgressStep[], id: string): ContextEvent["messages"][number] {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: TOOL_NAME,
    content: [{ type: "text", text: steps.length === 0 ? "cleared" : "updated" }],
    details: { version: PROGRESS_DETAILS_VERSION, steps: progressJson(steps) },
    isError: false,
    timestamp: 0,
  };
}

function assertPrefix(later: ReturnType<typeof normalizedRequest>, earlier: ReturnType<typeof normalizedRequest>) {
  assert.deepEqual(later.effectiveSystemGuidance, earlier.effectiveSystemGuidance);
  assert.deepEqual(later.activeToolNames, earlier.activeToolNames);
  assert.deepEqual(later.toolDefinitions, earlier.toolDefinitions);
  assert.deepEqual(later.messages.slice(0, earlier.messages.length), earlier.messages);
}

test("the Progress rename starts one intentional provider-prefix epoch", () => {
  const first = normalizedRequest([userMessage("start")]);
  assert.deepEqual(first.activeToolNames, ["update_progress"]);
  assert.equal(first.toolDefinitions[0]?.name, "update_progress");
  assert.match(first.toolDefinitions[0]?.description ?? "", /complete supplied steps/u);
  assert.match(first.effectiveSystemGuidance.join("\n"), /Use update_progress/u);
  assert.equal(first.effectiveSystemGuidance.join("\n").includes("update_todo_list"), false);
  assert.equal(JSON.stringify(first.toolDefinitions).includes('"todos"'), false);
  assert.equal(JSON.stringify(first.toolDefinitions).includes('"step"'), false);

  const predecessorIdentity = {
    activeToolNames: ["update_todo_list"],
    toolName: "update_todo_list",
    payload: "todos[].step",
  };
  assert.notDeepEqual(
    { activeToolNames: first.activeToolNames, toolName: first.toolDefinitions[0]?.name, payload: "steps[].text" },
    predecessorIdentity,
  );
});

test("removing reason starts one tool-definition and guidance epoch with stable tool order", () => {
  const initial = normalizedRequest([userMessage("start")]);
  const stepSchema = ProgressParameters.properties.steps.items;
  const predecessorParameters = {
    ...ProgressParameters,
    properties: {
      steps: {
        ...ProgressParameters.properties.steps,
        items: {
          anyOf: [
            {
              ...stepSchema,
              properties: {
                ...stepSchema.properties,
                text: { ...stepSchema.properties.text, maxLength: 300 },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
            },
            {
              ...stepSchema,
              required: ["text", "status", "reason"],
              properties: {
                ...stepSchema.properties,
                text: { ...stepSchema.properties.text, maxLength: 300 },
                status: { type: "string", enum: ["blocked"] },
                reason: { type: "string", minLength: 1, maxLength: 200 },
              },
            },
          ],
        },
      },
    },
  };
  const predecessor = {
    ...initial,
    effectiveSystemGuidance: [
      "Use blocked with a concise reason only when progress depends on an external action or condition; blocked does not mean completed.",
    ],
    toolDefinitions: initial.toolDefinitions.map((tool) => ({ ...tool, parameters: predecessorParameters })),
  };
  assert.notDeepEqual(initial.toolDefinitions, predecessor.toolDefinitions);
  assert.deepEqual(initial.activeToolNames, predecessor.activeToolNames);
  assert.notDeepEqual(initial.effectiveSystemGuidance, predecessor.effectiveSystemGuidance);
  assert.deepEqual(stepSchema.required, ["text", "status"]);
  assert.equal("reason" in stepSchema.properties, false);
  assert.match(initial.effectiveSystemGuidance.join("\n"), /include what is needed to continue in the step text/u);

  const steps: ProgressStep[] = [{ text: "work", status: "in_progress" }];
  const raw = [
    { role: "compactionSummary", summary: "Earlier work", tokensBefore: 100, timestamp: 0 } as const,
    progressToolCallMessage([{ ...steps[0], reason: "checking code" }]),
    progressToolResult(steps, "progress-call"),
    userMessage("continue"),
  ];
  const baselineMessages = reconcileProgressContext(raw, steps);
  assert.equal(baselineMessages, raw, "a retained normalized call/result pair needs no synthetic boundary");
  const baseline = normalizedRequest(baselineMessages);
  assert.deepEqual(baseline.toolDefinitions, initial.toolDefinitions);
  const nextRaw = [...raw, assistantText("working"), userMessage("again")];
  const next = normalizedRequest(reconcileProgressContext(nextRaw, steps));
  assertPrefix(next, baseline);
  assert.deepEqual(
    normalizedRequest(reconcileProgressContext(nextRaw, steps)),
    next,
    "reload keeps the new baseline stable",
  );
});

test("observational guidance starts one prefix epoch without changing tool order, schema, or history", () => {
  const raw = [userMessage("start")];
  const baseline = normalizedRequest(reconcileProgressContext(raw, []));
  const predecessor = {
    ...baseline,
    effectiveSystemGuidance: [
      "Maintain the complete session progress state as multi-step work progresses",
      "Use update_progress to track work with multiple meaningful steps; skip it for simple, single-step tasks.",
      "Use update_progress to keep the progress state aligned with actual work: mark a step in_progress before starting it, mark it completed as soon as it finishes, and revise the steps before continuing when the plan changes.",
      "Use blocked only when progress depends on an external action or condition, and include what is needed to continue in the step text; blocked does not mean completed.",
      "Before a progress report or final response, call update_progress to reconcile every step with actual work; do not report completion while the progress state is stale.",
      "On every update_progress call, send the complete current steps array, keep at most one step in_progress, and send an empty steps array when no tracked work remains.",
    ],
    toolDefinitions: baseline.toolDefinitions.map((tool) => ({
      ...tool,
      description:
        "Replace the current session progress state with the complete supplied steps. Call update_progress whenever actual step state changes; keep at most one step in_progress and send an empty steps array to clear it.",
    })),
  };
  assert.notDeepEqual(baseline.effectiveSystemGuidance, predecessor.effectiveSystemGuidance);
  assert.notDeepEqual(baseline.toolDefinitions, predecessor.toolDefinitions);
  assert.deepEqual(baseline.activeToolNames, predecessor.activeToolNames);
  assert.deepEqual(baseline.toolDefinitions[0]?.parameters, predecessor.toolDefinitions[0]?.parameters);
  assert.equal(baseline.toolDefinitions[0]?.constrainedSampling, predecessor.toolDefinitions[0]?.constrainedSampling);
  assert.deepEqual(baseline.messages, predecessor.messages);

  const steps: ProgressStep[] = [
    { text: "inspect", status: "completed" },
    { text: "verify", status: "in_progress" },
    { text: "report", status: "pending" },
  ];
  const updatedRaw = [...raw, progressToolCall(steps, "observational-1"), progressToolResult(steps, "observational-1")];
  const updated = normalizedRequest(reconcileProgressContext(updatedRaw, steps));
  assertPrefix(updated, baseline);
  const ordinaryRaw = [...updatedRaw, assistantText("working"), userMessage("continue")];
  const ordinary = normalizedRequest(reconcileProgressContext(ordinaryRaw, steps));
  assertPrefix(ordinary, updated);
  assert.deepEqual(normalizedRequest(reconcileProgressContext(ordinaryRaw, steps)), ordinary, "reload keeps the epoch");
});

test("ordinary Progress requests keep normalized provider prefixes stable after the transition", () => {
  const initialRaw = [userMessage("start")];
  const initial = normalizedRequest(reconcileProgressContext(initialRaw, []));

  const ordinaryRaw = [...initialRaw, assistantText("working"), userMessage("continue")];
  const ordinary = normalizedRequest(reconcileProgressContext(ordinaryRaw, []));
  assertPrefix(ordinary, initial);

  const updatedSteps: ProgressStep[] = [
    { text: "inspect", status: "completed" },
    { text: "implement", status: "in_progress" },
  ];
  const updatedRaw = [
    ...ordinaryRaw,
    progressToolCall(updatedSteps, "update-1"),
    progressToolResult(updatedSteps, "update-1"),
    userMessage("continue after update"),
  ];
  const updated = normalizedRequest(reconcileProgressContext(updatedRaw, updatedSteps));
  assertPrefix(updated, ordinary);

  const clearedRaw = [
    ...updatedRaw,
    progressToolCall([], "clear-1"),
    progressToolResult([], "clear-1"),
    userMessage("continue after clear"),
  ];
  const cleared = normalizedRequest(reconcileProgressContext(clearedRaw, []));
  assertPrefix(cleared, updated);

  const reloaded = normalizedRequest(reconcileProgressContext(clearedRaw, []));
  assert.deepEqual(reloaded, cleared, "reload must rebuild the same normalized request");
});

test("compaction restoration keeps its old epoch byte-stable and later epochs canonical", () => {
  const steps: ProgressStep[] = [{ text: "continue", status: "in_progress" }];
  const summaries: ContextEvent["messages"] = [
    { role: "compactionSummary", summary: "Earlier work", tokensBefore: 100, timestamp: 0 },
    { role: "branchSummary", summary: "Retained branch", fromId: "branch", timestamp: 0 },
  ];
  const oldContent = `[PI TODO STATUS v3]\nCurrent todo list as JSON data:\n${JSON.stringify({ todos: [{ step: "continue", status: "in_progress" }] })}`;
  const firstMessages = reconcileProgressContext([...summaries, userMessage("continue")], steps, oldContent);
  const restored = firstMessages[2];
  assert.equal(restored?.role === "custom" ? restored.content : undefined, oldContent);
  const first = normalizedRequest(firstMessages);

  const ordinaryRaw = [...summaries, userMessage("continue"), assistantText("working"), userMessage("again")];
  const ordinaryMessages = reconcileProgressContext(ordinaryRaw, steps, oldContent);
  assert.equal(ordinaryMessages[2]?.role === "custom" ? ordinaryMessages[2].content : undefined, oldContent);
  const ordinary = normalizedRequest(ordinaryMessages);
  assertPrefix(ordinary, first);
  assert.equal(reconcileProgressContext(ordinaryMessages, steps, oldContent), ordinaryMessages);

  const updatedSteps: ProgressStep[] = [{ text: "continue — approval", status: "blocked" }];
  const updatedRaw = [
    ...ordinaryRaw,
    progressToolCall(updatedSteps, "update-2"),
    progressToolResult(updatedSteps, "update-2"),
  ];
  const updated = normalizedRequest(reconcileProgressContext(updatedRaw, updatedSteps, oldContent));
  assertPrefix(updated, ordinary);

  const clearedRaw = [...updatedRaw, progressToolCall([], "clear-2"), progressToolResult([], "clear-2")];
  const cleared = normalizedRequest(reconcileProgressContext(clearedRaw, [], oldContent));
  assertPrefix(cleared, updated);

  const nextEpochMessages = reconcileProgressContext(
    [{ role: "compactionSummary", summary: "Later work", tokensBefore: 200, timestamp: 0 }],
    updatedSteps,
  );
  const canonical = nextEpochMessages[1];
  assert.match(canonical?.role === "custom" ? String(canonical.content) : "", /PI PROGRESS STATUS v5/u);
  assert.doesNotMatch(canonical?.role === "custom" ? String(canonical.content) : "", /PI TODO STATUS/u);
});
