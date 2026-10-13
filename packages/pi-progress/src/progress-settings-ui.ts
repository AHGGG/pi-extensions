import {
  type ExtensionCommandContext,
  getSelectListTheme,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
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
): Promise<void> {
  let queue = Promise.resolve();
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      let closing = false;
      const revisions = new Map<string, number>();
      const current = () => !signal.aborted && options.isCurrent();
      const close = () => {
        if (closing) return;
        closing = true;
        controller.abort();
        done();
      };
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
        close,
      );
      options.signal.addEventListener("abort", close, { once: true });
      if (!current()) close();
      return {
        render(width: number) {
          return [
            ...new Text(theme.fg("accent", theme.bold("Progress Settings")), 0, 0).render(width),
            theme.fg("muted", "Saved changes apply immediately."),
            "",
            ...list.render(width),
          ].map((line) => truncateToWidth(line, Math.max(0, width), ""));
        },
        invalidate: () => list.invalidate(),
        handleInput(data: string) {
          if (closing || !current()) return;
          if (matchesKey(data, Key.ctrl("c"))) close();
          else list.handleInput(data);
          tui.requestRender();
        },
        dispose() {
          controller.abort();
          options.signal.removeEventListener("abort", close);
          if (!closing) close();
        },
      };
    });
  } finally {
    await queue;
  }
}

function formatValue(value: ProgressSettings[keyof ProgressSettings]): string {
  return value === null ? "none" : String(value);
}
