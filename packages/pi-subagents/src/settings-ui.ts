import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Text,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { HorizontalRule, renderBoundedFrame, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import type { SubagentSettings } from "./settings.js";

interface SubagentSettingsUIOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  get(): SubagentSettings;
  save(key: keyof SubagentSettings, value: boolean, signal: AbortSignal): Promise<SubagentSettings>;
  apply(settings: SubagentSettings): void;
}

type CloseReason = "back" | "close" | "stale";

const SETTINGS: { key: keyof SubagentSettings; label: string; description: string }[] = [
  { key: "showWidget", label: "Show widget", description: "Show subagent jobs above the editor." },
  { key: "showJobId", label: "Show job ID", description: "Show job IDs in the widget." },
  { key: "showTools", label: "Show tools", description: "Show active tools in the widget." },
  { key: "showTiming", label: "Show timing", description: "Show job timing in the widget." },
];

export async function showSubagentSettings(
  ctx: ExtensionCommandContext,
  options: SubagentSettingsUIOptions,
): Promise<CloseReason> {
  if (options.signal.aborted || !options.isCurrent()) return "stale";
  // The command owner reports the settings file path in non-TUI modes.
  if (ctx.mode !== "tui" || !ctx.hasUI) return "back";
  let queue = Promise.resolve();
  let reason: CloseReason = "stale";
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const current = () => !signal.aborted && options.isCurrent();
      let closing = false;
      const revisions = new Map<string, number>();
      const pending = new Map<string, number>();
      const mouseRows = new Map<number, number>();
      let renderedWidth = 0;
      let contentHeight = 0;
      let mousePressed = false;
      const close = (next: CloseReason) => {
        if (closing) return;
        closing = true;
        reason = next;
        controller.abort();
        done();
      };
      const cancelOwner = () => close("stale");
      const reportFailure = (message: string) => {
        if (!current()) return;
        try {
          ctx.ui.notify(sanitizeTerminalText(`Could not save pi-subagents.json: ${message}`), "error");
        } catch {
          // The host can dispose its notifier after the ownership check.
        }
      };
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      // Keep native SettingsList semantics, but use this screen's callback theme.
      const listTheme = {
        ...getSettingsListTheme(),
        label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
        value: (text: string, selected: boolean) => theme.fg(selected ? "accent" : "muted", text),
        description: (text: string) => theme.fg("dim", text),
        cursor: theme.fg("accent", "→ "),
        hint: (text: string) => theme.fg("dim", text),
      };
      const initial = options.get();
      const items: SettingItem[] = SETTINGS.map(({ key, label, description }) => ({
        id: key,
        label,
        description,
        currentValue: String(initial[key]),
        values: ["true", "false"],
      }));
      const list = new SettingsList(
        items,
        items.length,
        listTheme,
        (id, value) => {
          if (closing || !current()) return;
          const key = id as keyof SubagentSettings;
          const revision = (revisions.get(id) ?? 0) + 1;
          revisions.set(id, revision);
          pending.set(id, revision);
          queue = queue
            .then(async () => {
              if (!current()) {
                if (!closing) cancelOwner();
                return;
              }
              const before = { ...options.get() };
              let effective = before;
              try {
                const settings = await options.save(key, value === "true", signal);
                // A successful rename is durable, even when closing aborted the save signal.
                if (!options.isCurrent()) {
                  cancelOwner();
                  return;
                }
                options.apply(settings);
                effective = options.get();
              } catch (error) {
                if (!options.isCurrent()) {
                  cancelOwner();
                  return;
                }
                let message = error instanceof Error ? error.message : String(error);
                try {
                  options.apply(before);
                } catch (rollbackError) {
                  message += `; could not restore effective settings: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
                }
                reportFailure(message);
              }
              if (!current()) return;
              if (pending.get(id) === revision) pending.delete(id);
              // Saving rereads the full document, including unrelated manual edits. Keep newer
              // optimistic choices, but refresh every row with no outstanding user change.
              for (const { key: settingKey } of SETTINGS) {
                if (!pending.has(settingKey)) list.updateValue(settingKey, String(effective[settingKey]));
              }
              tui.requestRender();
            })
            .catch((error: unknown) => {
              // A failed action must not prevent later requests from entering the queue.
              reportFailure(error instanceof Error ? error.message : String(error));
            });
        },
        () => close("back"),
      );
      options.signal.addEventListener("abort", cancelOwner, { once: true });
      if (!current()) cancelOwner();
      return {
        render(width: number) {
          if (!closing && !current()) cancelOwner();
          renderedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
          listTheme.cursor = theme.fg("accent", "→ ");
          // The native footer hardcodes keys. Advertise only the hard-cancel key owned here;
          // configured native navigation, change, and Back actions remain unchanged.
          const content = list.render(Math.max(4, renderedWidth)).slice(0, -2);
          contentHeight = content.length;
          const focusedRow = content.findIndex((line) => stripVTControlCharacters(line).startsWith("→"));
          mouseRows.clear();
          const tokens = new Map<string, number>();
          const layout = content.map((line, index) => {
            if (!stripVTControlCharacters(line).trim()) return line;
            const token = `content:${index}`;
            tokens.set(token, index);
            return token;
          });
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          const frame = renderBoundedFrame({
            width: Math.max(renderedWidth, `content:${content.length}`.length),
            maxRows: Math.max(1, terminalRows - 3),
            rule: rule.render(renderedWidth)[0] ?? "",
            title: new Text(theme.fg("accent", theme.bold("Subagents Settings")), 0, 0).render(renderedWidth),
            context: [theme.fg("muted", "Saved changes apply immediately.")],
            content: layout,
            hints: new Text(theme.fg("muted", "Ctrl+C close"), 0, 0).render(renderedWidth),
            priorityRows: focusedRow < 0 ? [] : [focusedRow],
            focusedRow,
          });
          return frame.map((line, row) => {
            const nativeRow = tokens.get(line);
            if (nativeRow !== undefined) mouseRows.set(row, nativeRow);
            return truncateToWidth(nativeRow === undefined ? line : (content[nativeRow] ?? ""), renderedWidth, "");
          });
        },
        invalidate() {
          mouseRows.clear();
          mousePressed = false;
          list.invalidate();
        },
        handleInput(data: string) {
          if (closing) return;
          if (!current()) return cancelOwner();
          mouseRows.clear();
          mousePressed = false;
          if (matchesKey(data, Key.ctrl("c"))) close("close");
          else {
            // SettingsList uses Pi's effective native keybindings for standard actions.
            list.handleInput(data);
          }
          tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent) {
          if (closing) return;
          if (!current()) {
            cancelOwner();
            return;
          }
          const nativeRow = mouseRows.get(event.y);
          if (nativeRow === undefined || event.x < 0 || event.x >= renderedWidth) {
            if (event.button === "left" && (event.type === "press" || event.type === "click")) mousePressed = false;
            return;
          }
          const nativeEvent = { ...event, y: nativeRow, width: renderedWidth, height: contentHeight };
          if (event.type === "click" && event.button === "left" && !mousePressed) {
            list.handleMouse({ ...nativeEvent, type: "press" });
          }
          const result = list.handleMouse(nativeEvent);
          if (event.type === "press" && event.button === "left") mousePressed = result?.handled === true;
          if (event.type === "click" || event.type === "wheel") mousePressed = false;
          if (result?.handled && result.render !== false) tui.requestRender();
          return result;
        },
        waitForPending() {
          return queue;
        },
        dispose() {
          mouseRows.clear();
          mousePressed = false;
          controller.abort();
          options.signal.removeEventListener("abort", cancelOwner);
          if (!closing) cancelOwner();
        },
      };
    });
  } finally {
    await queue;
  }
  return options.signal.aborted || !options.isCurrent() ? "stale" : reason;
}
