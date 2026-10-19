import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { showSubagentsMenu } from "../src/menu.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../src/settings.js";
import { JOB_STATES, type JobSummary } from "../src/types.js";

initTheme("dark");

function fixture(jobs: JobSummary[] = [{ jobId: "job_one", state: "running", createdAt: 0 }]) {
  const tui = createTuiHarness();
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { custom: tui.custom, notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  const state = {
    settings: { ...DEFAULT_SUBAGENT_SETTINGS },
    settingsPath: "/user/pi-subagents.json",
    jobs,
    omitted: 2,
  };
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    isCurrent: () => true,
    getState: () => state,
    cancelJob: vi.fn(async (_jobId: string, _signal: AbortSignal): Promise<void> => {}),
    showSettings: vi.fn(async (_signal: AbortSignal): Promise<"back" | "close" | "stale"> => "back"),
  };
  return { tui, ctx, state, controller, options, notifications };
}

const text = (lines: readonly string[]) => lines.map(stripVTControlCharacters).join("\n");

async function openConfirmation(current: ReturnType<typeof fixture>) {
  const command = showSubagentsMenu(current.ctx, current.options);
  await current.tui.waitForOpen();
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  return { command };
}

test("RPC uses privacy-filtered summaries, keeps raw IDs, and cancels only after confirmation", async () => {
  const rawId = "job_\u001b[31mone\u001b[0m\u202e";
  const current = fixture([
    {
      jobId: rawId,
      state: "queued",
      createdAt: 0,
      timeout: 2,
      resultSummary: "PRIVATE OUTPUT",
      errorSummary: "PRIVATE ERROR",
    },
  ]);
  const rpc = createRpcHarness([
    { kind: "select", response: "Jobs" },
    { kind: "select", options: ["job_one", "Back"], response: "job_one" },
    { kind: "select", response: "Cancel job…" },
    { kind: "select", options: ["Cancel job", "Keep job"], response: "Cancel job" },
    { kind: "select", options: [], response: undefined },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Close" },
  ]);
  current.options.cancelJob.mockImplementation(async (id, signal) => {
    if (!signal.aborted)
      current.state.jobs = current.state.jobs.map((job) => (job.jobId === id ? { ...job, state: "cancelled" } : job));
  });
  await showSubagentsMenu({ ...current.ctx, mode: "rpc", ui: { ...current.ctx.ui, ...rpc.ui } }, current.options);
  rpc.assertConsumed();
  assert.equal(current.options.cancelJob.mock.calls.length, 1);
  assert.equal(current.options.cancelJob.mock.calls[0]?.[0], rawId);
  assert.equal(current.state.jobs[0]?.jobId, rawId);
  const display = rpc.dialogs.map((dialog) => dialog.title).join("\n");
  assert.match(display, /Timeout: 2 seconds/u);
  assert.doesNotMatch(display, /PRIVATE|\p{Bidi_Control}/u);
  assert.equal(display.includes("\u001b"), false);
  assert.deepEqual(current.notifications, []);
});

test.each(JOB_STATES.filter((state) => state !== "queued" && state !== "running"))(
  "terminal %s jobs have no cancellation action",
  async (state) => {
    const current = fixture([{ jobId: "job_one", state, createdAt: 0, finishedAt: 10 }]);
    const rpc = createRpcHarness([
      { kind: "select", response: "Jobs" },
      { kind: "select", response: "job_one" },
      { kind: "select", options: [], response: undefined },
      { kind: "select", response: "Back" },
      { kind: "select", response: "Close" },
    ]);
    await showSubagentsMenu({ ...current.ctx, mode: "rpc", ui: { ...current.ctx.ui, ...rpc.ui } }, current.options);
    rpc.assertConsumed();
    assert.equal(current.options.cancelJob.mock.calls.length, 0);
    assert.match(rpc.dialogs[2]?.title ?? "", new RegExp(`State: ${state}`, "u"));
    assert.deepEqual(current.notifications, []);
  },
);

test("RPC Status, Help, empty Jobs and Settings use one manager with observable data", async () => {
  const current = fixture([]);
  current.state.settingsPath = "/user/\u001b]0;hidden\u0007pi-subagents.json\u202e";
  const rpc = createRpcHarness([
    { kind: "select", response: "Status" },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Help" },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Jobs" },
    { kind: "select", options: ["Back"], response: "Back" },
    { kind: "select", response: "Settings" },
    { kind: "select", response: "Close" },
  ]);
  await showSubagentsMenu({ ...current.ctx, mode: "rpc", ui: { ...current.ctx.ui, ...rpc.ui } }, current.options);
  rpc.assertConsumed();
  const status = rpc.dialogs[1]?.title ?? "";
  const help = rpc.dialogs[3]?.title ?? "";
  assert.match(status, /Runtime: active for this session/u);
  assert.match(status, /Retained jobs: 0/u);
  assert.match(status, /Active jobs: 0/u);
  assert.match(status, /Omitted jobs: 2/u);
  assert.match(status, /Show widget: true/u);
  assert.match(status, /Show job ID: true/u);
  assert.match(status, /Show tools: true/u);
  assert.match(status, /Show timing: true/u);
  assert.match(status, /User settings: \/user\/pi-subagents.json/u);
  assert.doesNotMatch(status, /hidden|\p{Bidi_Control}/u);
  assert.equal(status.includes("\u001b"), false);
  assert.match(help, /\/subagents opens/u);
  assert.match(help, /\/subagents settings opens/u);
  for (const tool of ["spawn", "inspect", "wait", "send", "cancel"]) assert.ok(help.includes(`subagent_${tool}`));
  assert.match(help, /32 terminal jobs.*24 hours/u);
  assert.match(rpc.dialogs[5]?.title ?? "", /No jobs in this session/u);
  assert.equal(current.options.showSettings.mock.calls.length, 1);
  assert.deepEqual(current.notifications, []);
});

test.each(["completed", "removed"] as const)("confirmation revalidates a job that becomes %s", async (change) => {
  const current = fixture();
  const { command } = await openConfirmation(current);
  const before = text(current.tui.render());
  current.state.jobs = change === "removed" ? [] : [{ jobId: "job_one", state: "completed", createdAt: 0 }];
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  const after = text(current.tui.render());
  current.tui.press("ctrl+c");
  await command;
  assert.match(before, /Cancel subagent job/u);
  assert.doesNotMatch(after, /Cancel job…/u);
  assert.equal(current.options.cancelJob.mock.calls.length, 0);
  assert.deepEqual(current.notifications, []);
});

test("confirmation Back returns locally, but Ctrl+C closes the root manager", async () => {
  const current = fixture();
  const { command } = await openConfirmation(current);
  const confirmation = text(current.tui.render());
  current.tui.press("tui.select.cancel");
  await current.tui.waitForOpen();
  const detail = text(current.tui.render());
  current.tui.press("tui.select.confirm");
  await current.tui.waitForOpen();
  current.tui.press("ctrl+c");
  await command;
  assert.match(confirmation, /Cancel subagent job/u);
  assert.match(detail, /Job ID: job_one/u);
  assert.equal(current.tui.isOpen, false);
  assert.equal(current.tui.openCount, 6);
  assert.equal(current.options.cancelJob.mock.calls.length, 0);
});

test.each(["owner", "dispose"] as const)("%s cancels an open confirmation without a side effect", async (kind) => {
  const current = fixture();
  const { command } = await openConfirmation(current);
  if (kind === "owner") current.controller.abort();
  else current.tui.dispose();
  await command;
  assert.equal(current.tui.isOpen, false);
  assert.equal(current.options.cancelJob.mock.calls.length, 0);
  assert.deepEqual(current.notifications, []);
});

test("cancelling pending job work aborts and drains its owned task", async () => {
  const current = fixture();
  let finish!: () => void;
  let taskSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    current.options.cancelJob.mockImplementation(async (_id, signal) => {
      taskSignal = signal;
      resolve();
      await new Promise<void>((done) => {
        finish = done;
      });
    });
  });
  const { command } = await openConfirmation(current);
  current.tui.press("tui.select.confirm");
  await started;
  await current.tui.waitForOpen();
  let settled = false;
  void command.then(() => {
    settled = true;
  });
  current.tui.press("ctrl+c");
  const aborted = taskSignal?.aborted;
  const early = settled;
  finish();
  await command;
  assert.equal(aborted, true);
  assert.equal(early, false);
  assert.equal(current.tui.isOpen, false);
  assert.equal(current.options.cancelJob.mock.calls.length, 1);
});

test.each(["back", "close", "stale"] as const)("Settings result %s controls the root flow", async (reason) => {
  const current = fixture();
  current.options.showSettings.mockResolvedValue(reason);
  const command = showSubagentsMenu(current.ctx, current.options);
  await current.tui.waitForOpen();
  current.tui.press("tui.select.down");
  current.tui.press("tui.select.confirm");
  if (reason === "back") {
    await current.tui.waitForOpen();
    current.tui.press("ctrl+c");
  }
  await command;
  assert.equal(current.options.showSettings.mock.calls.length, 1);
  assert.equal(current.tui.isOpen, false);
  assert.deepEqual(current.notifications, []);
});

test("manager frame uses callback theme, bounds all heights and supports custom cancellation", async () => {
  const current = fixture();
  const roles: string[] = [];
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.cancel": "ctrl+x",
  });
  const tui = createTuiHarness({
    keybindings: bindings,
    theme: {
      fg: (role, value) => {
        roles.push(role);
        return value;
      },
      bold: (value) => value,
    },
  });
  const zeroWidth: string[] = [];
  let zeroWidthRendered = false;
  current.ctx.ui.custom = (factory, options) =>
    tui.custom(async (...args) => {
      const component = await factory(...args);
      zeroWidth.push(...component.render(0));
      zeroWidthRendered = true;
      return component;
    }, options);
  const command = showSubagentsMenu(current.ctx, current.options);
  await tui.waitForOpen();
  tui.send("\u000e");
  const frames: { width: number; rows: number; lines: readonly string[] }[] = [];
  for (const rows of [24, 8, 7, 4])
    for (const width of [1, 3, 20, 80]) {
      frames.push({ width, rows, lines: tui.resize({ width, rows }) });
    }
  tui.invalidate();
  tui.resize({ width: 80, rows: 24 });
  tui.send("\u0018");
  await command;
  for (const { width, rows, lines } of frames) {
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    assert.ok(lines.length <= Math.max(1, rows - 3));
    if (rows >= 8 && width > 0) {
      assert.equal(stripVTControlCharacters(lines[0] ?? ""), "─".repeat(width));
      assert.equal(stripVTControlCharacters(lines.at(-1) ?? ""), "─".repeat(width));
    }
    if (width === 80) assert.match(text(lines), /Settings/u);
  }
  assert.equal(zeroWidthRendered, true);
  assert.ok(zeroWidth.every((line) => visibleWidth(line) === 0));
  assert.ok(roles.includes("border"));
  assert.ok(roles.includes("muted"));
  assert.equal(tui.isOpen, false);
});

test.each(["print", "json"] as const)("%s does not open TUI or mutate jobs", async (mode) => {
  const current = fixture();
  const custom = vi.fn();
  await showSubagentsMenu({ ...current.ctx, mode, hasUI: false, ui: { ...current.ctx.ui, custom } }, current.options);
  assert.equal(custom.mock.calls.length, 0);
  assert.equal(current.options.cancelJob.mock.calls.length, 0);
});
