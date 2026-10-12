import assert from "node:assert/strict";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { COMPLETION_SUMMARY_MS, PROGRESS_DETAILS_VERSION, WIDGET_KEY } from "../src/progress-widget.js";
import {
  createContext,
  createHarness,
  defaultSettingsResult,
  progressToolCallMessage,
  progressToolResultMessage,
  setProgress,
  toolResultEntry,
} from "./progress-harness.js";

async function clearWidget(harness: ReturnType<typeof createHarness>, ctx: ExtensionContext, args = "") {
  const command = harness.commands.get("clear-progress-widget");
  assert.ok(command);
  await command.handler(args, ctx as ExtensionCommandContext);
}

for (const mode of ["tui", "rpc"] as const) {
  test(`${mode}: dismisses only the widget, preserves state, and allows later updates/restoration`, async () => {
    const harness = createHarness();
    const steps = [{ text: "Interrupted work", status: "in_progress" as const }];
    const details = { version: PROGRESS_DETAILS_VERSION, steps };
    const current = createContext({ mode, branch: [toolResultEntry(details)] });
    await harness.emit("session_start", current.ctx);
    const messages = [progressToolCallMessage(steps), progressToolResultMessage(details)];
    const before = await harness.context(messages, current.ctx);
    const branchBefore = structuredClone(current.branch);
    const entriesBefore = structuredClone(harness.entries);
    assert.deepEqual([...harness.commands.keys()], ["clear-progress-widget"]);

    await clearWidget(harness, current.ctx);
    await clearWidget(harness, current.ctx, "  ");
    assert.deepEqual(current.widgets.at(-1), { key: WIDGET_KEY, content: undefined, options: undefined });
    assert.deepEqual(current.notifications.at(-1), {
      message: "Progress widget cleared. Saved progress is unchanged.",
      type: "info",
    });
    assert.deepEqual(await harness.context(messages, current.ctx), before);
    assert.deepEqual(harness.entries, entriesBefore);
    assert.deepEqual(current.branch, branchBefore);

    await setProgress(harness, current.ctx, steps);
    assert.ok(current.widgets.at(-1)?.content || current.widgets.at(-1)?.lines);
    await clearWidget(harness, current.ctx);
    await harness.emit("session_tree", current.ctx);
    assert.ok(current.widgets.at(-1)?.content || current.widgets.at(-1)?.lines);
    await clearWidget(harness, current.ctx);
    await harness.emit("session_start", current.ctx);
    assert.ok(current.widgets.at(-1)?.content || current.widgets.at(-1)?.lines);
    await harness.emit("session_shutdown", current.ctx);
  });

  test(`${mode}: rejects arguments without clearing and cancels completion timers on dismissal`, async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const current = createContext({ mode });
    try {
      await harness.emit("session_start", current.ctx);
      await setProgress(harness, current.ctx, [{ text: "done", status: "completed" }]);
      assert.equal(vi.getTimerCount(), 1);
      const widgetCount = current.widgets.length;
      await clearWidget(harness, current.ctx, "extra input");
      assert.equal(current.widgets.length, widgetCount);
      assert.equal(vi.getTimerCount(), 1);
      assert.deepEqual(current.notifications.at(-1), {
        message: "Usage: /clear-progress-widget (no arguments)",
        type: "warning",
      });

      await clearWidget(harness, current.ctx);
      assert.equal(vi.getTimerCount(), 0);
      const countAfterClear = current.widgets.length;
      await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
      assert.equal(current.widgets.length, countAfterClear);
      assert.deepEqual(current.widgets.at(-1), { key: WIDGET_KEY, content: undefined, options: undefined });
      // A repeated completed snapshot must also redisplay after manual dismissal.
      await setProgress(harness, current.ctx, [{ text: "done", status: "completed" }]);
      assert.ok(current.widgets.at(-1)?.content || current.widgets.at(-1)?.lines);
    } finally {
      await harness.emit("session_shutdown", current.ctx);
      vi.useRealTimers();
    }
  });
}

for (const mode of ["print", "json"] as const) {
  test(`${mode}: rejects without UI calls or state changes`, async () => {
    const harness = createHarness();
    const current = createContext({ mode });
    await harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, [{ text: "pending", status: "pending" }]);
    await assert.rejects(clearWidget(harness, current.ctx), /requires TUI or RPC mode/u);
    assert.deepEqual(current.widgets, []);
    assert.deepEqual(current.notifications, []);
    assert.deepEqual(harness.entries, []);
    await harness.emit("session_shutdown", current.ctx);
  });
}

test("ignores replaced or shut-down session commands without touching the current widget", async () => {
  const harness = createHarness();
  const previous = createContext();
  await harness.emit("session_start", previous.ctx);
  const current = createContext();
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, [{ text: "current", status: "pending" }]);
  const count = current.widgets.length;
  const oldCount = previous.widgets.length;
  await clearWidget(harness, previous.ctx);
  assert.equal(current.widgets.length, count);
  assert.equal(previous.widgets.length, oldCount);
  assert.match(previous.notifications.at(-1)?.message ?? "", /session changed/u);
  await harness.emit("session_shutdown", current.ctx);
  const shutdownCount = current.widgets.length;
  await clearWidget(harness, current.ctx);
  assert.equal(current.widgets.length, shutdownCount);
});

test("dismissal during settings loading remains hidden when initialization finishes", async () => {
  let resolveSettings: ((value: ReturnType<typeof defaultSettingsResult>) => void) | undefined;
  const harness = createHarness({
    loadSettings: () =>
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
  });
  const current = createContext({
    branch: [toolResultEntry({ version: PROGRESS_DETAILS_VERSION, steps: [{ text: "old", status: "pending" }] })],
  });
  const starting = harness.emit("session_start", current.ctx);
  assert.ok(resolveSettings);
  await clearWidget(harness, current.ctx);
  resolveSettings(defaultSettingsResult());
  await starting;
  assert.deepEqual(current.widgets.at(-1), { key: WIDGET_KEY, content: undefined, options: undefined });
  await harness.emit("session_shutdown", current.ctx);
});
