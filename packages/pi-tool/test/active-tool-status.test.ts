import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import {
  ACTIVE_TOOL_REFRESH_INTERVAL_MS,
  ACTIVE_TOOL_WIDGET_KEY,
  createActiveToolStatusController,
  formatActiveToolWidget,
  renderActiveToolWidget,
  sanitizeToolName,
} from "../src/active-tool-status.js";

type WidgetFactory = (_tui: never, theme: Theme) => Component;
type WidgetRecord = [string, string[] | WidgetFactory | undefined, { placement: "aboveEditor" } | undefined];

const DIVIDER = "─".repeat(80);
const IDENTITY_THEME = {
  fg: (_role: string, text: string) => text,
} as unknown as Theme;

afterEach(() => {
  vi.useRealTimers();
});

function createHarness(initialTools: string[] = []) {
  let activeTools = initialTools;
  const pi = {
    getActiveTools() {
      return [...activeTools];
    },
  } as unknown as ExtensionAPI;
  return {
    controller: createActiveToolStatusController(pi),
    setActiveTools(toolNames: string[]) {
      activeTools = toolNames;
    },
  };
}

function createContext(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
  const widgets: WidgetRecord[] = [];
  const sessionManager = {} as ExtensionContext["sessionManager"];
  const ctx = {
    mode,
    hasUI,
    sessionManager,
    ui: {
      setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: { placement: "aboveEditor" }) {
        widgets.push([key, content, options]);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets };
}

function renderWidgetRecord(record: WidgetRecord | undefined, width = 80): WidgetRecord | undefined {
  if (!record) return undefined;
  const [key, content, options] = record;
  const rendered = typeof content === "function" ? content(undefined as never, IDENTITY_THEME).render(width) : content;
  return [key, rendered, options];
}

test("stays off by default and can start, refresh, and stop in the owned session", async () => {
  vi.useFakeTimers();
  const harness = createHarness(["read", "bash"]);
  const current = createContext();
  harness.controller.start(current.ctx, false);
  assert.deepEqual(current.widgets, []);

  harness.controller.setEnabled(current.ctx, true);
  assert.deepEqual(renderWidgetRecord(current.widgets.at(-1)), [
    ACTIVE_TOOL_WIDGET_KEY,
    [DIVIDER, "Active tools (2)", "read · bash"],
    { placement: "aboveEditor" },
  ]);

  harness.setActiveTools(["read", "edit", "write"]);
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS);
  assert.deepEqual(renderWidgetRecord(current.widgets.at(-1)), [
    ACTIVE_TOOL_WIDGET_KEY,
    [DIVIDER, "Active tools (3)", "read · edit · write"],
    { placement: "aboveEditor" },
  ]);

  harness.controller.setEnabled(current.ctx, false);
  assert.deepEqual(current.widgets.at(-1), [ACTIVE_TOOL_WIDGET_KEY, undefined, undefined]);
  const countAfterDisable = current.widgets.length;
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS * 2);
  assert.equal(current.widgets.length, countAfterDisable);
});

test("session replacement clears the old widget and ignores stale shutdown", () => {
  const harness = createHarness(["read"]);
  const previous = createContext();
  const current = createContext();
  harness.controller.start(previous.ctx, true);
  harness.controller.start(current.ctx, true);
  assert.deepEqual(previous.widgets.at(-1), [ACTIVE_TOOL_WIDGET_KEY, undefined, undefined]);

  harness.controller.shutdown(previous.ctx);
  assert.equal(harness.controller.isEnabled(), true);
  harness.controller.shutdown(current.ctx);
  assert.deepEqual(current.widgets.at(-1), [ACTIVE_TOOL_WIDGET_KEY, undefined, undefined]);
});

test("keeps RPC widget content as plain strings and does nothing without UI", () => {
  const harness = createHarness(["read"]);
  const rpc = createContext("rpc");
  harness.controller.start(rpc.ctx, true);
  assert.deepEqual(rpc.widgets.at(-1), [
    ACTIVE_TOOL_WIDGET_KEY,
    ["Active tool (1)", "read"],
    { placement: "aboveEditor" },
  ]);
  const print = createContext("print", false);
  harness.controller.start(print.ctx, true);
  assert.deepEqual(print.widgets, []);
  harness.controller.shutdown(print.ctx);
});

test("renders a muted divider and wraps every safe tool name within the available width", () => {
  const roles: string[] = [];
  const theme = {
    fg(role: string, text: string) {
      roles.push(role);
      return text;
    },
  } as unknown as Theme;
  const lines = renderActiveToolWidget(
    ["Active tools (6)", "read · bash · edit · write · runtime_diagnostics · subagent_spawn"],
    theme,
    40,
  );

  assert.deepEqual(lines.map(stripTerminalSequences), [
    "─".repeat(40),
    "Active tools (6)",
    "read · bash · edit · write ·",
    "runtime_diagnostics · subagent_spawn",
  ]);
  assert.deepEqual(roles, ["borderMuted"]);
  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
});

test.each([0, 1, 2, 12, 80, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, 12.9])(
  "keeps wrapping and row bounds at width %s",
  (width) => {
    const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const body = ["Active tools (3)", "read · 界界 · e\u0301_tool"];
    const wrapped = normalized === 0 ? body.map(() => "") : body.flatMap((line) => wrapTextWithAnsi(line, normalized));
    const lines = renderActiveToolWidget(body, IDENTITY_THEME, width);
    assert.deepEqual(lines, ["─".repeat(normalized), ...wrapped.map((line) => truncateToWidth(line, normalized, ""))]);
    assert.ok(lines.every((line) => visibleWidth(line) <= normalized));
    if (normalized === 0) assert.deepEqual(lines, ["", "", ""]);
  },
);

test("uses the callback theme after resize and invalidation without republishing unchanged tools", async () => {
  vi.useFakeTimers();
  const harness = createHarness(["read", "bash"]);
  const current = createContext();
  harness.controller.start(current.ctx, true);
  const factory = current.widgets.at(-1)?.[1];
  assert.equal(typeof factory, "function");
  if (typeof factory !== "function") return;
  let color = "\u001b[31m";
  const fg = vi.fn((_role: string, text: string) => `${color}${text}\u001b[0m`);
  const component = factory(undefined as never, { fg } as unknown as Theme);
  for (const width of [0, 1, 40, 80, 12]) {
    const lines = component.render(width);
    assert.equal(stripTerminalSequences(lines[0] ?? ""), "─".repeat(width));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width === 0) assert.deepEqual(lines, ["", "", ""]);
    else assert.ok(fg.mock.calls.some(([role, text]) => role === "borderMuted" && text === "─".repeat(width)));
  }
  color = "\u001b[32m";
  component.invalidate();
  assert.equal(component.render(80)[0], `${color}${DIVIDER}\u001b[0m`);
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS * 2);
  harness.controller.refresh(current.ctx);
  assert.equal(current.widgets.length, 1);
  harness.controller.shutdown(current.ctx);
  harness.controller.shutdown(current.ctx);
  assert.equal(vi.getTimerCount(), 0);
  const writes = current.widgets.length;
  await vi.advanceTimersByTimeAsync(ACTIVE_TOOL_REFRESH_INTERVAL_MS * 2);
  assert.equal(current.widgets.length, writes);
});

test("formats every tool as bounded safe display text", () => {
  assert.deepEqual(formatActiveToolWidget(["read", "bash", "edit", "write"]), [
    "Active tools (4)",
    "read · bash · edit · write",
  ]);
  assert.deepEqual(formatActiveToolWidget(["read\n\u001b[31m"]), ["Active tool (1)", "read31m"]);
  assert.equal(sanitizeToolName("\u001b]8;;bad\u0007read\n\u202efile"), "8badreadfile");
  assert.equal(sanitizeToolName("\u001b\u0007"), "tool");
  assert.equal(sanitizeToolName("x".repeat(40)), `${"x".repeat(32)}…`);
});
