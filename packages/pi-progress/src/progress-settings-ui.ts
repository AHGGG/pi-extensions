import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionCommandContext,
  getSelectListTheme,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { sanitizeProgressText } from "./progress-renderer.js";
import { PROGRESS_DISPLAY_MODES, type ProgressSettings } from "./settings.js";

interface ProgressSettingsUIOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  get(): ProgressSettings;
  save(patch: Partial<ProgressSettings>, signal: AbortSignal): Promise<ProgressSettings>;
  apply(settings: ProgressSettings): void;
}

export async function showProgressSettings(
  ctx: ExtensionCommandContext,
  options: ProgressSettingsUIOptions,
): Promise<"back" | "close" | "stale"> {
  const { HorizontalRule, renderBoundedFrame } = await import("@narumitw/pi-tui-kit");
  if (options.signal.aborted || !options.isCurrent()) return "stale";
  let queue = Promise.resolve();
  let reason: "back" | "close" | "stale" = "stale";
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      let closing = false;
      const revisions = new Map<string, number>();
      const current = () => !signal.aborted && options.isCurrent();
      const close = (nextReason: "back" | "close" | "stale") => {
        if (closing) return;
        closing = true;
        reason = nextReason;
        controller.abort();
        done();
      };
      const cancelOwner = () => close("stale");
      const initial = options.get();
      const items: SettingItem[] = [
        {
          id: "enabled",
          label: "Show widget",
          description: "Show progress above the editor.",
          currentValue: String(initial.enabled),
          values: ["true", "false"],
        },
        {
          id: "displayMode",
          label: "Display mode",
          description: "Use adaptive, expanded, or collapsed display.",
          currentValue: initial.displayMode,
          values: [...PROGRESS_DISPLAY_MODES],
        },
        {
          id: "showCompleted",
          label: "Show completed",
          description: "Include completed steps in the progress display.",
          currentValue: String(initial.showCompleted),
          values: ["true", "false"],
        },
        {
          id: "maxVisibleItems",
          label: "Visible item limit",
          description: "Set an item limit from 1 to 50, or none.",
          currentValue: formatValue(initial.maxVisibleItems),
          submenu(value, finish) {
            const values = ["none", ...Array.from({ length: 50 }, (_, index) => String(index + 1))];
            const list = new SelectList(
              values.map((entry) => ({ value: entry, label: entry })),
              8,
              getSelectListTheme(),
            );
            list.setSelectedIndex(Math.max(0, values.indexOf(value)));
            list.onSelect = (item) => finish(item.value);
            list.onCancel = () => finish();
            return list;
          },
        },
        {
          id: "showProgress",
          label: "Show completion count",
          description: "Show the completed and total step counts in the header.",
          currentValue: String(initial.showProgress),
          values: ["true", "false"],
        },
      ];
      const list = new SettingsList(
        items,
        items.length,
        getSettingsListTheme(),
        (id, value) => {
          if (!current() || closing) return;
          const key = id as keyof ProgressSettings;
          const requested =
            key === "maxVisibleItems"
              ? value === "none"
                ? null
                : Number(value)
              : key === "displayMode"
                ? value
                : value === "true";
          const revision = (revisions.get(id) ?? 0) + 1;
          revisions.set(id, revision);
          queue = queue.then(async () => {
            if (!current()) return;
            try {
              const settings = await options.save({ [key]: requested }, signal);
              if (!current()) return;
              options.apply(settings);
            } catch (error) {
              if (!current()) return;
              ctx.ui.notify(
                sanitizeProgressText(
                  `Could not save pi-progress.json: ${error instanceof Error ? error.message : String(error)}`,
                ),
                "error",
              );
            }
            if (!current()) return;
            if (revisions.get(id) === revision) list.updateValue(id, formatValue(options.get()[key]));
            tui.requestRender();
          });
        },
        () => close("back"),
      );
      options.signal.addEventListener("abort", cancelOwner, { once: true });
      if (!current()) cancelOwner();
      return {
        render(width: number) {
          const content = list.render(width);
          // Pi SettingsList and SelectList mark their active row with the native arrow.
          const focusedRow = content.findIndex((line) => stripVTControlCharacters(line).startsWith("→"));
          const terminalRows = Number.isFinite(tui.terminal.rows) ? Math.floor(tui.terminal.rows) : 24;
          return renderBoundedFrame({
            width,
            maxRows: Math.max(1, terminalRows - 3),
            rule: rule.render(width)[0] ?? "",
            title: new Text(theme.fg("accent", theme.bold("Progress Settings")), 0, 0).render(width),
            context: [theme.fg("muted", "Saved changes apply immediately.")],
            content,
            priorityRows: focusedRow < 0 ? [] : [focusedRow],
            focusedRow,
          });
        },
        invalidate: () => list.invalidate(),
        handleInput(data: string) {
          if (closing || !current()) return;
          if (matchesKey(data, Key.ctrl("c"))) close("close");
          else list.handleInput(data);
          tui.requestRender();
        },
        dispose() {
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

function formatValue(value: ProgressSettings[keyof ProgressSettings]): string {
  return value === null ? "none" : String(value);
}
