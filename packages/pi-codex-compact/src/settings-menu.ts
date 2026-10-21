import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type MenuDefinition, runMenu } from "@narumitw/pi-tui-kit";
import { type RemoteCompactionProtocol, resolveCompactionRouteForApi } from "./model-api.js";
import type { CodexCompactSettings, CodexCompactSettingsRuntime, CodexCompactSettingsState } from "./settings.js";
import { terminalText as safeText } from "./terminal.js";

type Screen = "main" | "settings" | "invalid";
type Action =
  | "resume-warm"
  | "compact-now"
  | "set-enabled"
  | "set-log-compaction"
  | "set-async-enabled"
  | "set-async-auto-apply"
  | "set-async-threshold"
  | "set-protocol"
  | "set-timeout"
  | "set-retries"
  | "set-retention"
  | "set-notify"
  | "set-recovery";

export interface SettingsMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
  isPaused?(): boolean;
  hasCheckpoint?(): boolean;
  canReplayCheckpoint?(): boolean;
  lastProtocol?(): RemoteCompactionProtocol | undefined;
  backgroundStatus?(): "Preparing" | "Ready" | undefined;
  warmPauseReason?(): string | undefined;
  onResumeWarm?(): void;
  onSettingsChanged?(): void;
}

interface CompactMenuStatus {
  model: string;
  api?: Api;
}

function timeoutLabel(milliseconds: number): string {
  return `${milliseconds / 60_000} min`;
}

function retentionLabel(tokens: number): string {
  return `${tokens / 1000}K tokens`;
}

function protocolLabel(protocol: CodexCompactSettings["protocol"]): string {
  switch (protocol) {
    case "auto":
      return "Auto";
    case "remote-v2":
      return "Remote V2";
    case "responses-compact":
      return "Responses Compact";
    case "context-management":
      return "Context Management (experimental)";
  }
}

function lastProtocolLines(protocol: RemoteCompactionProtocol | undefined): string[] {
  return protocol ? [`Last resolved protocol: ${protocolLabel(protocol)}`] : [];
}

function backgroundStatusLines(status: "Preparing" | "Ready" | undefined): string[] {
  return status ? [`Warm-ahead checkpoint: ${status}`] : [];
}

async function update(
  runtime: CodexCompactSettingsRuntime,
  ctx: ExtensionCommandContext,
  patch: Partial<CodexCompactSettings>,
  signal: AbortSignal,
  onSettingsChanged?: () => void,
) {
  try {
    await runtime.update(patch, signal);
    if (signal.aborted) return { kind: "rejected" as const };
    if (Object.keys(patch).some((key) => key !== "logCompaction" && key !== "asyncAutoApply")) onSettingsChanged?.();
    ctx.ui.notify("Responses compaction settings saved.", "info");
    return { kind: "stay" as const };
  } catch (error) {
    if (signal.aborted) return { kind: "rejected" as const };
    ctx.ui.notify(
      `Could not save pi-codex-compact.json: ${safeText(error instanceof Error ? error.message : String(error))}`,
      "error",
    );
    return { kind: "rejected" as const };
  }
}

export function createCodexCompactMenu(
  runtime: CodexCompactSettingsRuntime,
  options: {
    onCompactRequested?: () => void;
    status?: CompactMenuStatus;
    isPaused?: () => boolean;
    hasCheckpoint?: () => boolean;
    canReplayCheckpoint?: () => boolean;
    lastProtocol?: () => RemoteCompactionProtocol | undefined;
    backgroundStatus?: () => "Preparing" | "Ready" | undefined;
    warmPauseReason?: () => string | undefined;
    onResumeWarm?: () => void;
    onSettingsChanged?: () => void;
  } = {},
): MenuDefinition<CodexCompactSettingsState, Screen, Action, ExtensionCommandContext> {
  const save = (ctx: ExtensionCommandContext, patch: Partial<CodexCompactSettings>, signal: AbortSignal) =>
    update(runtime, ctx, patch, signal, options.onSettingsChanged);
  return {
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Responses Compaction",
        lines: [
          `Remote compaction: ${state.settings.enabled ? "On" : "Off"}`,
          `Warm-ahead (experimental): ${state.settings.asyncEnabled ? `On · ${state.settings.asyncThresholdPercent}%` : "Off"}`,
          `Apply when ready: ${state.settings.asyncAutoApply ? "On" : "Off"}`,
          `Compaction logs: ${state.settings.logCompaction ? "On" : "Off"}`,
          ...backgroundStatusLines(options.backgroundStatus?.()),
          ...(options.warmPauseReason?.() ? [`Warm-ahead paused: ${safeText(options.warmPauseReason() ?? "")}`] : []),
          `Protocol setting: ${protocolLabel(state.settings.protocol)}`,
          `Active model: ${safeText(options.status?.model ?? "none")}`,
          `Preferred route: ${safeText(compactRoute(state, options.status))}`,
          ...(state.settings.enabled && options.status?.api === "openai-responses"
            ? ["On the official OpenAI endpoint, ChatGPT OAuth uses Context Management (experimental)."]
            : []),
          ...lastProtocolLines(options.lastProtocol?.()),
          ...(state.settings.enabled && options.hasCheckpoint?.() && options.canReplayCheckpoint?.() === false
            ? ["Compaction cancels: the active checkpoint cannot replay on this model/route."]
            : []),
          ...(options.isPaused?.()
            ? [
                "Last observed remote operation paused after OAuth rejection; /reload retries it.",
                options.hasCheckpoint?.()
                  ? state.settings.checkpointRecovery === "cancel" || options.canReplayCheckpoint?.() === false
                    ? "Recovery: cancel compaction; preserve checkpoint history."
                    : "Recovery: checkpoint-aware summary; on failure, Pi native may lose older context. Integrity failures cancel."
                  : "Recovery: Pi native compaction.",
              ]
            : []),
        ],
        items: [
          ...(options.warmPauseReason?.()
            ? [
                {
                  id: "resume-warm",
                  label: "Resume warm-ahead",
                  action: "resume-warm" as const,
                  description: "Clear the session-only failure pause; retry after the next completed turn.",
                },
              ]
            : []),
          {
            id: "compact-now",
            label: "Compact now",
            description: "Close this menu and compact the active session immediately.",
            action: "compact-now",
          },
          state.kind === "invalid"
            ? {
                id: "settings",
                label: "Settings",
                description: "Read-only until the invalid settings file is repaired.",
                to: "invalid" as const,
              }
            : { id: "settings", label: "Settings", to: "settings" as const },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      settings: ({ state }) => ({
        kind: "settings",
        title: "Responses Compaction Settings",
        lines: [`User settings · ${safeText(state.path)}`],
        items: [
          {
            id: "enabled",
            label: "Remote compaction",
            description: "Use a supported Responses compaction protocol.",
            currentValue: state.settings.enabled ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-enabled",
          },
          {
            id: "asyncEnabled",
            label: "Warm-ahead (experimental)",
            description:
              "Prepare a checkpoint after a completed turn for Pi automatic compaction. May consume quota even if unused.",
            currentValue: state.settings.asyncEnabled ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-async-enabled",
          },
          {
            id: "asyncAutoApply",
            label: "Apply when ready",
            description:
              "Apply a ready warm-ahead checkpoint after the current model/tool batch or before the next idle input. Requires warm-ahead.",
            currentValue: state.settings.asyncAutoApply ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-async-auto-apply",
          },
          {
            id: "asyncThresholdPercent",
            label: "Warm-ahead threshold",
            description: "Context-window usage that permits background preparation.",
            currentValue: `${state.settings.asyncThresholdPercent}%`,
            values: ["50%", "60%", "65%", "70%", "75%", "80%", "90%"],
            action: "set-async-threshold",
          },
          {
            id: "logCompaction",
            label: "Compaction logs",
            description: "Show async preparation and actual compaction lifecycle notices in TUI and RPC.",
            currentValue: state.settings.logCompaction ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-log-compaction",
          },
          {
            id: "protocol",
            label: "Protocol",
            description:
              "Choose a preferred protocol. OpenAI ChatGPT OAuth uses experimental Context Management through normal inference.",
            currentValue: protocolLabel(state.settings.protocol),
            values: ["Auto", "Remote V2", "Responses Compact", "Context Management (experimental)"],
            action: "set-protocol",
          },
          {
            id: "checkpointRecovery",
            label: "Checkpoint recovery",
            description:
              "Summarize uses inference quota; on failure, Pi native may lose older context. Integrity failures cancel. Cancel preserves history without a summary request.",
            currentValue: state.settings.checkpointRecovery === "cancel" ? "Cancel" : "Summarize",
            values: ["Summarize", "Cancel"],
            action: "set-recovery",
          },
          {
            id: "requestTimeoutMs",
            label: "Request timeout",
            description: "Maximum time for the extension-owned remote compaction request.",
            currentValue: timeoutLabel(state.settings.requestTimeoutMs),
            values: ["2 min", "5 min", "10 min", "15 min"],
            action: "set-timeout",
          },
          {
            id: "maxRetries",
            label: "Transport retries",
            description: "Retry transient provider failures before falling back to Pi.",
            currentValue: String(state.settings.maxRetries),
            values: ["0", "1", "2"],
            action: "set-retries",
          },
          {
            id: "replacementTokenBudget",
            label: "Replacement text budget",
            description: "Approximate user-history budget, or a hard limit for Context Management output.",
            currentValue: retentionLabel(state.settings.replacementTokenBudget),
            values: ["32K tokens", "64K tokens", "96K tokens", "128K tokens"],
            action: "set-retention",
          },
          {
            id: "notifyOnFallback",
            label: "Fallback notifications",
            description: "Warn when remote compaction fails and Pi native takes over.",
            currentValue: state.settings.notifyOnFallback ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-notify",
          },
        ],
      }),
      invalid: ({ state }) => ({
        kind: "detail",
        title: "Codex Compact Settings · Read only",
        lines: [
          `Invalid settings file: ${safeText(state.path)}`,
          `Issue: ${safeText(state.issue ?? "unknown validation error")}`,
          "Built-in defaults are active. Repair the file and run /reload; it will not be overwritten.",
        ],
        hint: "back",
      }),
    },
    actions: {
      "resume-warm": () => {
        options.onResumeWarm?.();
        return { kind: "stay" };
      },
      "compact-now": async () => {
        options.onCompactRequested?.();
        return { kind: "close" };
      },
      "set-log-compaction": ({ ctx, value, signal }) => save(ctx, { logCompaction: value === "On" }, signal),
      "set-enabled": ({ ctx, value, signal }) => save(ctx, { enabled: value === "On" }, signal),
      "set-async-auto-apply": ({ ctx, value, signal }) => save(ctx, { asyncAutoApply: value === "On" }, signal),
      "set-async-enabled": ({ ctx, value, signal }) => save(ctx, { asyncEnabled: value === "On" }, signal),
      "set-async-threshold": ({ ctx, value, signal }) =>
        save(ctx, { asyncThresholdPercent: Number.parseInt(value ?? "65", 10) }, signal),
      "set-protocol": ({ ctx, value, signal }) =>
        save(
          ctx,
          {
            protocol:
              value === "Context Management (experimental)"
                ? "context-management"
                : value === "Remote V2"
                  ? "remote-v2"
                  : value === "Responses Compact"
                    ? "responses-compact"
                    : "auto",
          },
          signal,
        ),
      "set-recovery": ({ ctx, value, signal }) =>
        save(ctx, { checkpointRecovery: value === "Cancel" ? "cancel" : "summarize" }, signal),
      "set-timeout": ({ ctx, value, signal }) =>
        save(ctx, { requestTimeoutMs: Number.parseInt(value ?? "5", 10) * 60_000 }, signal),
      "set-retries": ({ ctx, value, signal }) => save(ctx, { maxRetries: Number.parseInt(value ?? "2", 10) }, signal),
      "set-retention": ({ ctx, value, signal }) =>
        save(ctx, { replacementTokenBudget: Number.parseInt(value ?? "64", 10) * 1000 }, signal),
      "set-notify": ({ ctx, value, signal }) => save(ctx, { notifyOnFallback: value === "On" }, signal),
    },
  };
}

export async function showCodexCompactMenu(
  runtime: CodexCompactSettingsRuntime,
  ctx: ExtensionCommandContext,
  owner: SettingsMenuOwner,
): Promise<void> {
  if (ctx.mode === "rpc" && ctx.hasUI) {
    ctx.ui.notify(`Edit Responses compaction settings at ${safeText(runtime.get().path)}.`, "info");
    return;
  }
  if (ctx.mode !== "tui") {
    throw new Error("/codex-compact requires TUI or RPC UI support");
  }
  if (owner.signal.aborted || !owner.isCurrent()) return;
  let compactRequested = false;
  await runMenu(
    ctx,
    createCodexCompactMenu(runtime, {
      onCompactRequested: () => {
        compactRequested = true;
      },
      status: {
        get model() {
          return compactMenuStatus(ctx).model;
        },
        get api() {
          return ctx.model?.api;
        },
      },
      isPaused: owner.isPaused,
      hasCheckpoint: owner.hasCheckpoint,
      canReplayCheckpoint: owner.canReplayCheckpoint,
      lastProtocol: owner.lastProtocol,
      backgroundStatus: owner.backgroundStatus,
      warmPauseReason: owner.warmPauseReason,
      onResumeWarm: () => {
        if (!owner.signal.aborted && owner.isCurrent()) owner.onResumeWarm?.();
      },
      onSettingsChanged: () => {
        if (!owner.signal.aborted && owner.isCurrent()) owner.onSettingsChanged?.();
      },
    }),
    {
      getState: () => runtime.get(),
      signal: owner.signal,
      isCurrent: owner.isCurrent,
    },
  );
  if (!compactRequested || owner.signal.aborted || !owner.isCurrent()) return;
  ctx.compact({
    onError: (error) => {
      if (!owner.signal.aborted && owner.isCurrent()) {
        ctx.ui.notify(`Compaction failed: ${safeText(error.message)}`, "error");
      }
    },
  });
}

export function compactMenuStatus(ctx: ExtensionCommandContext): CompactMenuStatus {
  const model = ctx.model;
  return {
    model: model ? `${model.provider}/${model.id}` : "none",
    api: model?.api,
  };
}

function compactRoute(state: Readonly<CodexCompactSettingsState>, status: CompactMenuStatus | undefined): string {
  const route = resolveCompactionRouteForApi(status?.api, state.settings);
  if (route.kind === "native") return `Pi native (${route.reason})`;
  return route.protocol === "context-management"
    ? "Responses Context Management (experimental)"
    : route.protocol === "remote-v2"
      ? "Responses Remote V2"
      : "Responses Compact API";
}
