import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { sanitizeProgressText } from "./progress-renderer.js";
import type { ProgressSettings } from "./settings.js";

export interface ProgressMenuState {
  settings: ProgressSettings;
  settingsPath: string;
  widget: "disabled" | "hidden" | "empty" | "visible";
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
}

interface ProgressMenuOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  getState(): ProgressMenuState;
  hideWidget(): void;
  showSettings(signal: AbortSignal): Promise<"back" | "close" | "stale">;
}

export async function showProgressMenu(ctx: ExtensionCommandContext, options: ProgressMenuOptions): Promise<void> {
  const menu = defineMenu<ProgressMenuState, "main" | "status" | "help", "settings" | "hide">({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Progress",
        lines: [`Widget: ${state.widget} · ${state.completed}/${state.total} steps completed`],
        items: [
          { id: "hide", label: "Clear widget", description: "Keep saved progress unchanged", action: "hide" },
          { id: "settings", label: "Settings", action: "settings" },
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Progress Status",
        lines: [
          `Widget: ${state.widget}`,
          `Steps: ${state.total} total, ${state.completed} completed, ${state.inProgress} in progress, ${state.blocked} blocked`,
          `Enabled: ${state.settings.enabled}`,
          `Display mode: ${state.settings.displayMode}`,
          `Show completed: ${state.settings.showCompleted}`,
          `Visible item limit: ${state.settings.maxVisibleItems ?? "none"}`,
          `Show completion count: ${state.settings.showProgress}`,
          `User settings: ${sanitizeProgressText(state.settingsPath)}`,
        ],
      }),
      help: () => ({
        kind: "detail",
        title: "Progress Help",
        lines: [
          "/progress opens this menu.",
          "Settings edits user display preferences in TUI mode; RPC reports the file path.",
          "Successful settings saves apply immediately. Manual edits require /reload.",
          "Clear widget keeps saved progress unchanged. Updates, branch navigation, or reload can show incomplete progress again.",
          "/progress settings opens the same settings screen directly.",
          "/progress clear hides the widget directly.",
          "The model updates steps through update_progress; there is no manual progress editor.",
        ],
      }),
    },
    actions: {
      settings: async ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        const reason = await options.showSettings(signal);
        if (signal.aborted || !options.isCurrent() || reason !== "back") return { kind: "close" };
        return { kind: "stay" };
      },
      hide: ({ signal }) => {
        if (signal.aborted || !options.isCurrent()) return { kind: "close" };
        options.hideWidget();
        return { kind: "stay" };
      },
    },
  });
  await runMenu(ctx, menu, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    getState: options.getState,
    onError: (_ctx, error) => {
      if (options.signal.aborted || !options.isCurrent()) return;
      ctx.ui.notify(
        sanitizeProgressText(`Progress menu failed: ${error instanceof Error ? error.message : String(error)}`),
        "error",
      );
    },
  });
}
