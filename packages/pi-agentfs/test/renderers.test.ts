import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { stripVTControlCharacters } from "node:util";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceTools } from "../src/tools.js";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as Theme;
function context(args: unknown): ToolRenderContext {
  return {
    args,
    toolCallId: "id",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/host/cwd",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
it.each(["read", "write", "edit", "bash"])(
  "renders %s without terminal injection, host links, or speculative file reads",
  (name) => {
    const hostRead = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Host read forbidden"));
    const hostAccess = vi.spyOn(fs, "access").mockRejectedValue(new Error("Host access forbidden"));
    syncBuiltinESMExports();
    const raw = "/notes/測試/\u001b]52;c;c2VjcmV0\u0007\u001b[2Jname\nline.txt";
    const args = { path: raw, command: `cat '${raw}'`, content: raw, edits: [{ oldText: raw, newText: raw }] };
    const tool = createWorkspaceTools(() => {
      throw new Error("Rendering must not open a workspace");
    }).find((tool) => tool.name === name);
    if (!tool?.renderCall || !tool.renderResult) throw new Error("Missing safe renderer");
    const renderContext = context(args);
    const call = tool.renderCall(args, theme, renderContext);
    for (const width of [0, 1, 8, 80, 200]) {
      for (const line of call.render(width)) {
        // Cell clipping may append its own harmless SGR reset, even with an identity theme.
        expect(line.replaceAll("\u001b[0m", "")).not.toContain("\u001b");
        expect(line).not.toContain("file://");
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    for (const expanded of [true, false]) {
      const result = tool.renderResult(
        { content: [{ type: "text", text: raw }], details: { diff: raw } },
        { expanded, isPartial: false },
        theme,
        renderContext,
      );
      for (const width of [0, 1, 8, 80]) {
        const lines = result.render(width);
        if (width === 0) expect(lines).toEqual([]);
        expect(lines.join("\n").replaceAll("\u001b[0m", "")).toBe(stripVTControlCharacters(lines.join("\n")));
        expect(lines.join("\n")).not.toContain("file://");
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(args.path).toBe(raw);
    expect(args.content).toBe(raw);
    expect(hostRead).not.toHaveBeenCalled();
    expect(hostAccess).not.toHaveBeenCalled();
  },
);
