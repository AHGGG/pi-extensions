import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeSubagentDisplayText } from "./display-text.js";
import { registerMessageRenderers } from "./message-renderers.js";
import {
  DEFAULT_SUBAGENT_SETTINGS,
  type SubagentSettings,
  SubagentSettingsStore,
  subagentSettingsPath,
} from "./settings.js";
import { registerSubagentTools, type SubagentToolsDependencies } from "./tools.js";
import { createSubagentWidgetController } from "./widget.js";

export interface SubagentsDependencies extends SubagentToolsDependencies {
  settingsStore?: Pick<SubagentSettingsStore, "userPath" | "load" | "save" | "flush">;
}

export default function subagents(pi: ExtensionAPI, dependencies: SubagentsDependencies = {}): void {
  registerMessageRenderers(pi);
  const tools = registerSubagentTools(pi, dependencies);
  const widget = createSubagentWidgetController(tools.runtime);
  const store = dependencies.settingsStore ?? new SubagentSettingsStore(subagentSettingsPath());
  let activeContext: ExtensionContext | undefined;
  let sessionGeneration = 0;
  let owner = new AbortController();
  let ready = false;
  let menuOpen = false;
  let settings: SubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS };
  const menuTasks = new Set<Promise<void>>();
  const ownsSession = (ctx: ExtensionContext) => ctx.sessionManager === activeContext?.sessionManager;

  const openSettings = async (
    ctx: ExtensionCommandContext,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<"back" | "close" | "stale"> => {
    if (signal.aborted || !isCurrent()) return "stale";
    if (ctx.mode !== "tui") {
      ctx.ui.notify(sanitizeSubagentDisplayText(`Edit user settings: ${store.userPath}. Then run /reload.`), "info");
      return "back";
    }
    const { showSubagentSettings } = await import("./settings-ui.js");
    if (signal.aborted || !isCurrent()) return "stale";
    return showSubagentSettings(ctx, {
      signal,
      isCurrent,
      get: () => ({ ...settings }),
      save: (key, value, actionSignal) => {
        actionSignal.throwIfAborted();
        if (!isCurrent()) throw new Error("The subagents session changed.");
        return store.save(key, value, actionSignal);
      },
      apply: (next) => {
        if (!isCurrent()) return;
        settings = { ...next };
        widget.update(ctx, settings);
      },
    });
  };

  pi.registerCommand("subagents", {
    description: "Manage subagent jobs and widget settings",
    getArgumentCompletions: (prefix) =>
      "settings".startsWith(prefix)
        ? [{ value: "settings", label: "settings", description: "Configure the subagent widget" }]
        : null,
    handler: async (args, ctx) => {
      if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
        throw new Error("/subagents requires TUI or RPC mode.");
      }
      const route = args.trim();
      if (route !== "" && route !== "settings") {
        ctx.ui.notify("Usage: /subagents | /subagents settings", "warning");
        return;
      }
      if (!ownsSession(ctx) || !ready || menuOpen) {
        ctx.ui.notify("Subagent controls are loading, unavailable, or already open.", "warning");
        return;
      }
      menuOpen = true;
      const generation = sessionGeneration;
      const signal = owner.signal;
      const isCurrent = () => generation === sessionGeneration && ownsSession(ctx) && !signal.aborted;
      const task = (async () => {
        if (route === "settings") {
          await openSettings(ctx, signal, isCurrent);
          return;
        }
        const { showSubagentsMenu } = await import("./menu.js");
        if (!isCurrent()) return;
        await showSubagentsMenu(ctx, {
          signal,
          isCurrent,
          getState: () => ({
            settings: { ...settings },
            settingsPath: store.userPath,
            ...tools.runtime.inspectJobs(),
          }),
          cancelJob: async (jobId, actionSignal) => {
            actionSignal.throwIfAborted();
            if (!isCurrent()) throw new Error("The subagents session changed.");
            await tools.runtime.cancel(jobId);
          },
          showSettings: (actionSignal) => openSettings(ctx, actionSignal, isCurrent),
        });
      })();
      menuTasks.add(task);
      try {
        await task;
      } catch (error) {
        if (isCurrent()) {
          ctx.ui.notify(sanitizeSubagentDisplayText(error instanceof Error ? error.message : String(error)), "error");
        }
      } finally {
        menuTasks.delete(task);
        if (isCurrent()) menuOpen = false;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    owner.abort();
    if (activeContext) widget.shutdown(activeContext);
    owner = new AbortController();
    activeContext = ctx;
    ready = false;
    menuOpen = false;
    const generation = ++sessionGeneration;
    const isCurrent = () => generation === sessionGeneration && ownsSession(ctx) && !owner.signal.aborted;
    // Stop old children and broker delivery before waiting for slow UI storage work.
    await tools.startSession();
    if (!isCurrent()) return;
    await Promise.allSettled([...menuTasks]);
    if (!isCurrent()) return;
    const loaded = await store.load();
    if (!isCurrent()) return;
    settings = { ...loaded.settings };
    ready = true;
    widget.start(ctx, settings);
    if (loaded.diagnostics.length > 0) {
      const message = sanitizeSubagentDisplayText(`Subagent settings: ${loaded.diagnostics.join(" ")}`);
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else throw new Error(message);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    sessionGeneration++;
    owner.abort();
    ready = false;
    menuOpen = false;
    activeContext = undefined;
    widget.shutdown(ctx);
    const results = await Promise.allSettled([tools.shutdown(), ...menuTasks, store.flush()]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  });
}
