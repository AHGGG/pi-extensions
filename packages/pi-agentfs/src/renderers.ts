import { stripVTControlCharacters } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

function displayText(text: string): string {
  // Preserve raw tool payloads; strip terminal controls only at the display boundary.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally remove controls, except line feeds and tabs.
  const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
  return stripVTControlCharacters(text).replace(controls, "").replaceAll("\t", "   ");
}

function boundedComponent(text: string, padding = 0): Component {
  const component = new Text(text, padding, 0);
  return {
    render(width) {
      if (width <= 0) return [];
      // Text can retain one two-cell character in a one-cell viewport.
      return component.render(width).map((line) => truncateToWidth(line, width, ""));
    },
    invalidate: () => component.invalidate(),
  };
}

/** Core path renderers link to host files; the edit preview also reads host files. Neither applies
 * to virtual files. Render only supplied text and completed diffs, without speculative I/O. */
export function virtualRenderers(name: string): Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell"> {
  return {
    renderShell: undefined,
    renderCall(input, theme) {
      const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const value = name === "bash" ? args.command : args.path;
      const label = typeof value === "string" ? displayText(value).replaceAll("\n", "\\n") : "...";
      return boundedComponent(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", label)}`);
    },
    renderResult(result, options, theme, context) {
      const details =
        result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
      const raw =
        name === "edit" && !context.isError && typeof details.diff === "string"
          ? details.diff
          : result.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n");
      const text = displayText(raw);
      const visible = options.expanded ? text : text.split("\n").slice(0, 10).join("\n");
      return boundedComponent(theme.fg(context.isError ? "error" : "toolOutput", visible), context.outputPad);
    },
  };
}
