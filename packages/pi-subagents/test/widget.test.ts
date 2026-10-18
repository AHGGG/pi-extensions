import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { MessageBroker } from "../src/message-broker.js";
import { type ActiveJobDisplay, SubagentRuntime } from "../src/runtime.js";
import type { ChildRequest, ChildResult } from "../src/types.js";
import { createSubagentWidgetController, renderSubagentWidget, SUBAGENT_WIDGET_KEY } from "../src/widget.js";

const theme = { fg: (_role: string, text: string) => text } as Theme;
const displayJob: ActiveJobDisplay = {
  jobId: "job_preview",
  task: "Review authentication tests",
  state: "running",
  elapsedMs: 123_000,
  tools: ["read", "bash"],
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each([
  ["short task", "Review authentication tests", "Review authentication tests"],
  ["multiline whitespace", "  Review\n\t authentication   tests  ", "Review authentication tests"],
  ["exact width", "a".repeat(40), "a".repeat(40)],
  ["long task", "a".repeat(41), `${"a".repeat(39)}…`],
  ["wide characters", "界".repeat(21), `${"界".repeat(19)}…`],
  ["exact wide width", "界".repeat(20), "界".repeat(20)],
  ["combining characters", "e\u0301".repeat(41), `${"e\u0301".repeat(39)}…`],
  ["emoji", "👩‍💻".repeat(21), `${"👩‍💻".repeat(19)}…`],
  ["CSI styling", "\u001b[31mReview tests\u001b[0m", "Review tests"],
  ["OSC title", "\u001b]0;hidden title\u0007Review tests", "Review tests"],
  ["OSC hyperlink", "\u001b]8;;https://example.com\u001b\\Review tests\u001b]8;;\u001b\\", "Review tests"],
  ["APC marker", "\u001b_hidden marker\u001b\\Review tests", "Review tests"],
  ["DCS string", "\u001bPhidden data\u001b\\Review tests", "Review tests"],
  ["SOS string", "\u001bXhidden data\u001b\\Review tests", "Review tests"],
  ["PM string", "\u001b^hidden data\u001b\\Review tests", "Review tests"],
  ["C1 CSI", "\u009b31mReview tests\u009b0m", "Review tests"],
  ["C1 OSC", "\u009d0;hidden title\u009cReview tests", "Review tests"],
  ["C1 strings", "\u0090data\u009c\u0098data\u009c\u009edata\u009c\u009fdata\u009cReview tests", "Review tests"],
  ["simple escape", "\u001b7Review tests\u001b8", "Review tests"],
  ["malformed escape", "\u001b[\u001b]Review tests", "Review tests"],
  ["control characters", "Review\r\u0007\u0080 tests\u007f", "Review tests"],
  [
    "bidirectional controls",
    "\u061c\u200e\u200f\u202a\u202b\u202dReview\u202e tests\u202c\u2066\u2067\u2068\u2069",
    "Review tests",
  ],
  ["empty sanitized text", "\u0007\u001b\u202e\u2066\n\t", ""],
  ["only terminal sequences", "\u001b[31m\u001b[0m\u001b]0;title\u0007", ""],
  ["only invisible text", "\u200b\u0301", ""],
])("renders a safe task preview: %s", (_name, task, expected) => {
  const job = { ...displayJob, task };
  const lines = renderSubagentWidget([job], theme, 200);
  const preview = expected ? ` · ${expected}` : "";
  assert.equal(lines[2], `▶ job_preview${preview} · running · 2m 3s / no timeout · tools: read, bash`);
  assert.ok(visibleWidth(expected) <= 40);
  for (const line of lines) assert.doesNotMatch(line, /[\p{Cc}\p{Bidi_Control}]/u);
  assert.equal(job.task, task);
});

test.each(["\u001b[", "\u001b]", "\u001b_", "\u001bP", "\u001bX", "\u001b^", "\u009b", "\u009d", "\u009f"])(
  "renders maximum-size tasks containing repeated unterminated sequences: %j",
  (prefix) => {
    const task = prefix.repeat(Math.floor((50 * 1024) / Buffer.byteLength(prefix, "utf8")));
    assert.ok(Buffer.byteLength(task, "utf8") <= 50 * 1024);
    const jobs = Array.from({ length: 8 }, (_, index) => ({ ...displayJob, jobId: `job_${index}`, task }));
    const lines = renderSubagentWidget(jobs, theme, 200);
    assert.equal(lines.length, 10);
    for (const line of lines) assert.doesNotMatch(line, /[\p{Cc}\p{Bidi_Control}]/u);
    assert.ok(lines.slice(2).every((line) => / · running · /u.test(line)));
  },
);

test("keeps rows bounded across resize and uses the callback theme on every render", async () => {
  const { context, runtime } = await setupWidget();
  runtime.start(jobInput(`${"界e\u0301👩‍💻".repeat(20)}\nconstraints`));
  const component = widgetComponent(context);
  const fg = vi.fn((_role: string, text: string) => text);
  const callbackTheme = { fg } as unknown as Theme;
  const themedComponent = widgetComponent(context, callbackTheme);
  for (const width of [0, 1, 2, 24, 80, 200, 24, 200]) {
    const lines = component.render(width);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "─".repeat(width));
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    themedComponent.invalidate();
    themedComponent.render(width);
    assert.ok(fg.mock.calls.some(([role, text]) => role === "borderMuted" && text === "─".repeat(width)));
  }
  assert.ok(fg.mock.calls.some(([role, text]) => role === "text" && text.includes("…")));
  fg.mockClear();
  themedComponent.invalidate();
  themedComponent.render(200);
  assert.ok(fg.mock.calls.length > 0, "theme content must not stay cached across invalidation");
});

test("carries separate queued and running tasks without changing child tasks or public metadata", async () => {
  const { context, runtime, mock, children } = await setupWidget();
  const tasks = ["Review authentication\nwith full constraints", `Implement ${"long task ".repeat(100)}`] as const;
  const spawned = tasks.map((task) => runtime.start(jobInput(task)));
  const [first, second] = spawned;
  assert.ok(first && second);
  const queued = runtime.activeJobsForDisplay();
  assert.deepEqual(
    queued.map(({ task, state }) => ({ task, state })),
    tasks.map((task) => ({ task, state: "queued" })),
  );
  const queuedRows = widgetComponent(context).render(200);
  assert.match(queuedRows[2] ?? "", /Review authentication with full constra… · queued/u);
  assert.match(queuedRows[3] ?? "", /Implement .*… · queued/u);
  const firstSnapshot = queued[0];
  assert.ok(firstSnapshot);
  firstSnapshot.task = "mutated snapshot";
  assert.equal(runtime.activeJobsForDisplay()[0]?.task, tasks[0]);

  await Promise.resolve();
  assert.deepEqual(
    runtime.activeJobsForDisplay().map(({ state }) => state),
    ["running", "running"],
  );
  assert.deepEqual(
    [...children.values()].map(({ request }) => request.task),
    tasks,
  );
  const runningRows = widgetComponent(context).render(200);
  assert.match(runningRows[2] ?? "", / · running · /u);
  assert.match(runningRows[3] ?? "", / · running · /u);
  assert.deepEqual(Object.keys(spawned[0] ?? {}).sort(), ["jobId", "state"]);
  const activeMetadata = JSON.stringify(runtime.inspectJobs());
  assert.doesNotMatch(activeMetadata, /task|preview|Review authentication|Implement/u);

  const firstChild = children.get(tasks[0]);
  assert.ok(firstChild);
  firstChild.finish({ state: "completed", result: "done", limitations: [], truncated: false });
  const result = await runtime.wait(first.jobId, undefined);
  assert.equal(result.state, "completed");
  assert.equal(widgetComponent(context).render(200).length, 3);
  assert.doesNotMatch(widgetComponent(context).render(200).join("\n"), /Review authentication/u);
  await runtime.cancel(second.jobId);
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.deepEqual(runtime.activeJobsForDisplay(), []);
  assert.doesNotMatch(
    JSON.stringify([result, runtime.inspectJobs(), mock.sentMessages]),
    /taskText|"task"|preview|Review authentication|Implement/u,
  );
});

test("refreshes a changed task even when the remaining display data is unchanged", async () => {
  let refresh: (() => void) | undefined;
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
    refresh = callback as () => void;
    return { unref() {} } as NodeJS.Timeout;
  });
  const { context, runtime } = await setupWidget();
  const jobs = vi.spyOn(runtime, "activeJobsForDisplay").mockReturnValue([{ ...displayJob, task: "First task" }]);
  assert.ok(refresh);
  refresh();
  const firstFactory = context.widgets.get(SUBAGENT_WIDGET_KEY);
  const first = widgetComponent(context);
  assert.match(first.render(200)[2] ?? "", /First task/u);
  refresh();
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), firstFactory);
  jobs.mockReturnValue([{ ...displayJob, task: "Second task" }]);
  refresh();
  assert.notEqual(context.widgets.get(SUBAGENT_WIDGET_KEY), firstFactory);
  assert.match(widgetComponent(context).render(200)[2] ?? "", /Second task/u);
  assert.match(first.render(200)[2] ?? "", /First task/u, "published snapshots must remain independent");
});

test("clears task rows and releases refresh ownership across session replacement and repeated shutdown", async () => {
  const { context, runtime, controller, children } = await setupWidget();
  const timers = vi.spyOn(globalThis, "clearInterval");
  runtime.start(jobInput("Old session task"));
  await Promise.resolve();
  assert.match(widgetComponent(context).render(200)[2] ?? "", /Old session task/u);
  await runtime.shutdown();
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.equal(children.get("Old session task")?.request.signal.aborted, true);
  runtime.beginSession();
  const replacement = createMockContext({ mode: "tui" });
  controller.start(replacement.ctx);
  cleanups.push(async () => controller.shutdown(replacement.ctx));
  assert.ok(timers.mock.calls.length > 0);
  runtime.start(jobInput("New session task"));
  assert.match(widgetComponent(replacement).render(200)[2] ?? "", /New session task/u);
  assert.doesNotMatch(widgetComponent(replacement).render(200).join("\n"), /Old session task/u);
  controller.shutdown(context.ctx);
  assert.match(widgetComponent(replacement).render(200)[2] ?? "", /New session task/u);
  controller.shutdown(replacement.ctx);
  controller.shutdown(replacement.ctx);
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.equal(replacement.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  const writes = vi.spyOn((replacement.ctx as ExtensionContext).ui, "setWidget");
  await runtime.shutdown();
  assert.equal(writes.mock.calls.length, 0, "shutdown must unsubscribe the widget from later job changes");
});

async function setupWidget() {
  const mock = createMockPi();
  const context = createMockContext({ mode: "tui" });
  const children = new Map<string, { request: ChildRequest; finish: (result: ChildResult) => void }>();
  const broker = new MessageBroker({ onMessage() {} });
  const runtime = new SubagentRuntime(mock.pi, broker, {
    now: () => 0,
    runChild: (request) =>
      new Promise((resolve) => {
        const onAbort = () => finish({ state: "cancelled", limitations: [], truncated: false });
        const finish = (result: ChildResult) => {
          request.signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        children.set(request.task, { request, finish });
        request.signal.addEventListener("abort", onAbort, { once: true });
      }),
  });
  const controller = createSubagentWidgetController(runtime);
  cleanups.push(async () => {
    controller.shutdown(context.ctx);
    await runtime.shutdown();
    await broker.shutdown();
  });
  await broker.start();
  runtime.beginSession();
  controller.start(context.ctx);
  return { mock, context, runtime, controller, children };
}

function widgetComponent(context: ReturnType<typeof createMockContext>, callbackTheme = theme): Component {
  const factory = context.widgets.get(SUBAGENT_WIDGET_KEY) as ((_tui: unknown, theme: Theme) => Component) | undefined;
  assert.ok(factory);
  return factory({}, callbackTheme);
}

function jobInput(task: string) {
  return {
    task,
    tools: ["read"],
    skills: [],
    extensions: [],
    toolSources: {},
    model: "test-provider/test-model",
    thinkingLevel: "medium" as const,
    cwd: process.cwd(),
    projectTrusted: false,
  };
}
