import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type MenuDefinition, runMenu } from "@narumitw/pi-tui-kit";
import { type RemoteCompactionProtocol, resolveCompactionRouteForApi } from "./model-api.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
  effectiveCodexCompactSettings,
  MAX_MAINTENANCE_MESSAGE_BYTES,
} from "./settings.js";
import { terminalText as safeText } from "./terminal.js";

type Screen = "main" | "settings" | "invalid";
type Action =
  | "compact-now"
  | "set-enabled"
  | "set-mode"
  | "save-provider"
  | "reset-provider"
  | "set-scratchpad"
  | "set-append-message"
  | "edit-maintenance-message"
  | "reset-maintenance-message"
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
  onSettingsChanged?(): void;
}

interface CompactMenuStatus {
  model: string;
  provider?: string;
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

function modeLabel(mode: CodexCompactSettings["compactionMode"]): string {
  return mode === "text-summary" ? "Text summary" : "Provider checkpoint";
}

function lastProtocolLines(protocol: RemoteCompactionProtocol | undefined): string[] {
  return protocol ? [`Last resolved protocol: ${protocolLabel(protocol)}`] : [];
}

async function update(
  runtime: CodexCompactSettingsRuntime,
  ctx: ExtensionCommandContext,
  patch: Partial<CodexCompactSettings>,
  signal: AbortSignal,
  onSettingsChanged?: () => void,
  isCurrent: () => boolean = () => true,
  provider?: string,
) {
  try {
    if (signal.aborted || !isCurrent()) return { kind: "rejected" as const };
    await runtime.update(patch, signal, provider);
    if (signal.aborted || !isCurrent()) return { kind: "rejected" as const };
    onSettingsChanged?.();
    ctx.ui.notify("Responses compaction settings saved.", "info");
    return { kind: "stay" as const };
  } catch (error) {
    if (signal.aborted || !isCurrent()) return { kind: "rejected" as const };
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
    onEditMessageRequested?: () => void;
    status?: CompactMenuStatus;
    isPaused?: () => boolean;
    hasCheckpoint?: () => boolean;
    canReplayCheckpoint?: () => boolean;
    lastProtocol?: () => RemoteCompactionProtocol | undefined;
    onSettingsChanged?: () => void;
    isCurrent?: () => boolean;
  } = {},
): MenuDefinition<CodexCompactSettingsState, Screen, Action, ExtensionCommandContext> {
  const provider = options.status?.provider;
  let displayedPreferences: Pick<CodexCompactSettings, "compactionMode" | "protocol"> | undefined;
  const save = async (
    ctx: ExtensionCommandContext,
    patch: Partial<CodexCompactSettings>,
    signal: AbortSignal,
    targetProvider?: string,
  ) => {
    const result = await update(
      runtime,
      ctx,
      patch,
      signal,
      options.onSettingsChanged,
      options.isCurrent,
      targetProvider,
    );
    // Kit serializes edits but retains the screen's original action state. Track only
    // successful menu edits so a snapshot matches its rows, not an external reload.
    if (result.kind === "stay" && targetProvider === undefined && displayedPreferences) {
      if (patch.compactionMode !== undefined) displayedPreferences.compactionMode = patch.compactionMode;
      if (patch.protocol !== undefined) displayedPreferences.protocol = patch.protocol;
    }
    return result;
  };
  const saveProvider = (ctx: ExtensionCommandContext, patch: Partial<CodexCompactSettings>, signal: AbortSignal) => {
    if (!provider) return { kind: "rejected" as const };
    return save(ctx, patch, signal, provider);
  };
  return {
    start: "main",
    screens: {
      main: ({ state: stored }) => {
        const state = { ...stored, settings: effectiveCodexCompactSettings(stored.settings, provider) };
        return {
          kind: "actions",
          title: "Responses Compaction",
          lines: [
            `Compaction and replay: ${state.settings.enabled ? "On" : "Off"}`,
            `Compaction mode: ${modeLabel(state.settings.compactionMode)}`,
            ...(state.settings.compactionMode === "provider-checkpoint"
              ? [`Protocol setting: ${protocolLabel(state.settings.protocol)}`]
              : ["Text summaries use normal Responses inference; the provider checkpoint protocol setting is unused."]),
            `Active model: ${safeText(options.status?.model ?? "none")}`,
            `Current provider: ${safeText(provider ?? "none")}`,
            `Provider preferences: ${provider && Object.keys(state.settings.providerOverrides[provider] ?? {}).length ? "Custom" : "Global defaults"}`,
            `Preferred route: ${safeText(compactRoute(state, options.status))}`,
            ...(state.settings.enabled &&
            state.settings.compactionMode === "provider-checkpoint" &&
            options.status?.api === "openai-responses"
              ? [
                  "For official OpenAI ChatGPT OAuth subscription-sharing, Remote V2 is unsupported. The effective route is Context Management (experimental), regardless of the preferred protocol.",
                ]
              : []),
            ...(state.settings.compactionMode === "provider-checkpoint"
              ? lastProtocolLines(options.lastProtocol?.())
              : []),
            ...(state.settings.enabled && options.hasCheckpoint?.() && options.canReplayCheckpoint?.() === false
              ? [
                  "Direct opaque replay is unavailable. Compatible provider changes require issuer summary recovery; incompatible routes cancel.",
                ]
              : []),
            ...(state.settings.compactionMode === "provider-checkpoint" && options.isPaused?.()
              ? [
                  "Last observed remote operation paused after OAuth rejection; /reload retries it.",
                  options.hasCheckpoint?.()
                    ? state.settings.checkpointRecovery === "cancel"
                      ? "Recovery: cancel compaction; preserve checkpoint history."
                      : options.canReplayCheckpoint?.() === false
                        ? "Recovery: issuer summary for compatible provider changes; otherwise cancel and preserve history."
                        : "Recovery: checkpoint-aware summary; on failure, Pi native may lose older context. Integrity failures cancel."
                    : "Recovery: Pi native compaction.",
                ]
              : []),
          ],
          items: [
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
        };
      },
      settings: ({ state }) => {
        displayedPreferences = {
          compactionMode: state.settings.compactionMode,
          protocol: state.settings.protocol,
        };
        const override = provider ? state.settings.providerOverrides[provider] : undefined;
        const hasOverride = override && Object.keys(override).length > 0;
        return {
          kind: "settings",
          title: "Responses Compaction Settings",
          lines: [
            `User settings · ${safeText(state.path)}`,
            `Current provider: ${safeText(provider ?? "none")}`,
            "Editing global defaults. Provider overrides remain active until replaced or reset.",
            ...(hasOverride
              ? [
                  `Saved provider mode: ${override.compactionMode ? modeLabel(override.compactionMode) : "Global default"}`,
                  `Saved provider protocol: ${override.protocol ? protocolLabel(override.protocol) : "Global default"}`,
                ]
              : ["Provider preferences: Global defaults"]),
          ],
          items: [
            {
              id: "enabled",
              label: "Compaction and replay",
              description: "Enable the selected compaction mode and replay existing compatible provider checkpoints.",
              currentValue: state.settings.enabled ? "On" : "Off",
              values: ["On", "Off"],
              action: "set-enabled",
            },
            {
              id: "compactionMode",
              label: "Compaction mode",
              description:
                "Provider checkpoint preserves the existing behavior. Text summary (experimental) directly requests a readable summary; existing checkpoint replay stays enabled." +
                " Global default for providers without a mode override.",
              currentValue: modeLabel(state.settings.compactionMode),
              values: ["Provider checkpoint", "Text summary"],
              action: "set-mode",
            },
            {
              id: "scratchpadEnabled",
              label: "Scratchpad",
              description:
                "Expose session-specific task notes. Saved across sessions; Off preserves notes. Also available through /scratchpad on or off.",
              currentValue: state.settings.scratchpadEnabled ? "On" : "Off",
              values: ["On", "Off"],
              action: "set-scratchpad",
            },
            {
              id: "protocol",
              label: "Protocol",
              description:
                "Used only in Provider checkpoint mode. Auto can try Context Management after a third-party Compact endpoint rejects the request; this can consume quota. Official OpenAI ChatGPT OAuth uses Context Management for every preference." +
                " Global default for providers without a protocol override.",
              currentValue: protocolLabel(state.settings.protocol),
              values: ["Auto", "Remote V2", "Responses Compact", "Context Management (experimental)"],
              action: "set-protocol",
            },
            ...(provider
              ? [
                  {
                    id: "saveProvider",
                    label: "Save current settings for this provider",
                    currentValue: "Save snapshot",
                    description: `Save the displayed global mode and protocol for ${safeText(provider)} across sessions. Other settings stay global.`,
                    action: "save-provider" as const,
                  },
                ]
              : []),
            ...(hasOverride
              ? [
                  {
                    id: "resetProvider",
                    label: "Use global defaults for this provider",
                    currentValue: "Remove overrides",
                    description: "Remove this provider's mode and protocol overrides; keep other provider settings.",
                    action: "reset-provider" as const,
                  },
                ]
              : []),
            {
              id: "appendMaintenanceMessage",
              label: "Append maintenance message",
              description:
                "Off omits the Context Management user message and scratchpad context in Text summary and recovery; summary instructions are preserved.",
              currentValue: state.settings.appendMaintenanceMessage ? "On" : "Off",
              values: ["On", "Off"],
              action: "set-append-message",
            },
            {
              id: "maintenanceMessage",
              label: "Maintenance message",
              description:
                "Close this menu and edit the Context Management request-only instruction (nonempty, at most 16 KiB UTF-8). Used only when appending is On.",
              currentValue:
                state.settings.maintenanceMessage === DEFAULT_CODEX_COMPACT_SETTINGS.maintenanceMessage
                  ? "Default"
                  : "Custom",
              action: "edit-maintenance-message",
            },
            {
              id: "resetMaintenanceMessage",
              label: "Reset maintenance message",
              description: "Restore the built-in instruction without changing the append toggle.",
              currentValue: "Reset to default",
              action: "reset-maintenance-message",
            },
            {
              id: "checkpointRecovery",
              label: "Checkpoint recovery",
              description:
                "After Provider checkpoint failure, Summarize uses inference quota; on failure, Pi native may lose older context. Integrity failures cancel. Cancel preserves history without a summary request.",
              currentValue: state.settings.checkpointRecovery === "cancel" ? "Cancel" : "Summarize",
              values: ["Summarize", "Cancel"],
              action: "set-recovery",
            },
            {
              id: "requestTimeoutMs",
              label: "Request timeout",
              description: "Maximum time for the extension-owned checkpoint or text-summary request.",
              currentValue: timeoutLabel(state.settings.requestTimeoutMs),
              values: ["5 min", "10 min", "15 min", "20 min", "25 min", "30 min"],
              action: "set-timeout",
            },
            {
              id: "maxRetries",
              label: "Transport retries",
              description: "Bound provider-opening retries. Text summary failure preserves history.",
              currentValue: String(state.settings.maxRetries),
              values: ["0", "1", "2"],
              action: "set-retries",
            },
            {
              id: "replacementTokenBudget",
              label: "Replacement text budget",
              description:
                "Upper bound for replacement text, including text summaries; Context Management applies it to output.",
              currentValue: retentionLabel(state.settings.replacementTokenBudget),
              values: ["32K tokens", "64K tokens", "96K tokens", "128K tokens"],
              action: "set-retention",
            },
            {
              id: "notifyOnFallback",
              label: "Failure notifications",
              description: "Warn on failed compaction and recovery; Text summary failure preserves history.",
              currentValue: state.settings.notifyOnFallback ? "On" : "Off",
              values: ["On", "Off"],
              action: "set-notify",
            },
          ],
        };
      },
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
      "save-provider": ({ ctx, signal }) => {
        const settings = displayedPreferences ?? runtime.get().settings;
        return saveProvider(ctx, { compactionMode: settings.compactionMode, protocol: settings.protocol }, signal);
      },
      "reset-provider": ({ ctx, signal }) => saveProvider(ctx, {}, signal),
      "compact-now": async () => {
        options.onCompactRequested?.();
        return { kind: "close" };
      },
      "set-scratchpad": ({ ctx, value, signal }) => save(ctx, { scratchpadEnabled: value === "On" }, signal),
      "set-append-message": ({ ctx, value, signal }) => save(ctx, { appendMaintenanceMessage: value === "On" }, signal),
      "reset-maintenance-message": ({ ctx, signal }) =>
        save(ctx, { maintenanceMessage: DEFAULT_CODEX_COMPACT_SETTINGS.maintenanceMessage }, signal),
      "edit-maintenance-message": async () => {
        options.onEditMessageRequested?.();
        return { kind: "close" };
      },
      "set-enabled": ({ ctx, value, signal }) => save(ctx, { enabled: value === "On" }, signal),
      "set-mode": ({ ctx, value, signal }) =>
        save(ctx, { compactionMode: value === "Text summary" ? "text-summary" : "provider-checkpoint" }, signal),
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
  const provider = ctx.model?.provider;
  const isCurrent = () => owner.isCurrent() && ctx.model?.provider === provider;
  let compactRequested = false;
  let editMessageRequested = false;
  await runMenu(
    ctx,
    createCodexCompactMenu(runtime, {
      onEditMessageRequested: () => {
        editMessageRequested = true;
      },
      onCompactRequested: () => {
        compactRequested = true;
      },
      isCurrent,
      status: {
        provider,
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
      onSettingsChanged: () => {
        if (!owner.signal.aborted && owner.isCurrent()) owner.onSettingsChanged?.();
      },
    }),
    {
      getState: () => runtime.get(),
      signal: owner.signal,
      isCurrent,
    },
  );
  if (owner.signal.aborted || !isCurrent()) return;
  if (editMessageRequested) {
    await editMaintenanceMessage(runtime, ctx, owner);
    return;
  }
  if (!compactRequested) return;
  ctx.compact({
    onError: (error) => {
      if (!owner.signal.aborted && owner.isCurrent()) {
        ctx.ui.notify(`Compaction failed: ${safeText(error.message)}`, "error");
      }
    },
  });
}

/** Use Pi's editor only after the menu releases its custom component. */
export async function editMaintenanceMessage(
  runtime: CodexCompactSettingsRuntime,
  ctx: ExtensionCommandContext,
  owner: SettingsMenuOwner,
): Promise<void> {
  if (owner.signal.aborted || !owner.isCurrent() || ctx.mode !== "tui") return;
  const message = await ctx.ui.editor(
    "Context Management maintenance message",
    runtime.get().settings.maintenanceMessage,
  );
  if (owner.signal.aborted || !owner.isCurrent() || message === undefined) return;
  if (message.trim().length === 0 || Buffer.byteLength(message, "utf8") > MAX_MAINTENANCE_MESSAGE_BYTES) {
    ctx.ui.notify(
      "Maintenance message must be nonempty and at most 16 KiB UTF-8. Use the append toggle to disable it.",
      "error",
    );
    return;
  }
  await update(
    runtime,
    ctx,
    { maintenanceMessage: message },
    owner.signal,
    () => {
      if (!owner.signal.aborted && owner.isCurrent()) owner.onSettingsChanged?.();
    },
    owner.isCurrent,
  );
}

export function compactMenuStatus(ctx: ExtensionCommandContext): CompactMenuStatus {
  const model = ctx.model;
  return {
    model: model ? `${model.provider}/${model.id}` : "none",
    provider: model?.provider,
    api: model?.api,
  };
}

function compactRoute(state: Readonly<CodexCompactSettingsState>, status: CompactMenuStatus | undefined): string {
  const route = resolveCompactionRouteForApi(status?.api, state.settings);
  if (route.kind === "native") return `Pi native (${route.reason})`;
  if (state.settings.compactionMode === "text-summary") return "Text summary through normal Responses inference";
  return route.protocol === "context-management"
    ? "Responses Context Management (experimental)"
    : route.protocol === "remote-v2"
      ? "Responses Remote V2"
      : "Responses Compact API";
}
