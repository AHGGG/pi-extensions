import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runSecretInput, runTask } from "@narumitw/pi-tui-kit";
import type { Coordinator } from "./coordinator.js";
import { displayPath, notificationMetadata, safeText } from "./metadata.js";
import type { Destination, Notification, Providers } from "./provider.js";
import {
  policyKeys,
  resolveSettings,
  type Scope,
  type Settings,
  type SettingsStore,
  type Snapshot,
  saveDestination,
  savePolicy,
  validSeconds,
} from "./settings.js";

type Screen =
  | "main"
  | "destinations"
  | "destination"
  | "settings"
  | "targets"
  | "delay"
  | "customDelay"
  | "label"
  | "chat"
  | "topic"
  | "review"
  | "remove"
  | "testSelect"
  | "testReview"
  | "status"
  | "help";
type Action =
  | "scope"
  | "policy"
  | "delay"
  | "customDelay"
  | "target"
  | "inheritTargets"
  | "add"
  | "edit"
  | "select"
  | "token"
  | "label"
  | "chat"
  | "topic"
  | "save"
  | "remove"
  | "prepareTest"
  | "sendTest";
interface State {
  snapshot: Snapshot;
  editing: Settings;
}
export interface MenuOptions {
  store: SettingsStore;
  coordinator: Coordinator;
  providers: Providers;
  signal: AbortSignal;
  isCurrent(): boolean;
}
export const helpLines = [
  "Create a bot with @BotFather in Telegram, then start a private conversation or add it to your group with permission to send messages.",
  "Obtain the numeric chat ID from Telegram Bot API getUpdates after sending a message. Do not share or paste the token into Pi chat. Stop other update consumers before using getUpdates; this extension does not poll.",
  "Use a negative group/supergroup chat ID when applicable. Forum topic IDs are optional positive integers.",
  "Destinations are User settings only. Project settings require trust and may select existing destinations but cannot change credentials or addresses.",
  "Notifications disclose hostname, session name/ID, workspace and Git metadata, elapsed time and timestamp. No conversation or code is sent.",
  "Inactivity is not attention detection: reading without typing can still trigger a notification. Available focus-gain events count as activity, but focus support is not required.",
  "Input or new work cancels a pending reminder. Saved policy/destination changes cancel pending reminders. Settings save immediately; closing does not undo them.",
  "RPC/print/JSON cannot observe terminal activity and deliver at settlement instead. Short-lived processes can exit before delivery completes.",
  "Delivery is best effort, one attempt, with no automatic retries or history replay. Accepted means Telegram accepted the message, not that it was read.",
  "Manual file changes require /reload or session start. Repair malformed files before saving. Revoke exposed tokens through BotFather.",
];

export async function showNotifyMenu(ctx: ExtensionCommandContext, options: MenuOptions) {
  const { store, coordinator, providers, signal, isCurrent } = options;
  // Kit reserves one column internally; preserve the host's zero-width contract.
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, customOptions) =>
    ctx.ui.custom(async (...args) => {
      const component = await factory(...args);
      const render = component.render.bind(component);
      component.render = (width) => (width <= 0 ? [] : render(width));
      return component;
    }, customOptions);
  const menuCtx = { ...ctx, ui: { ...ctx.ui, custom } };
  let scope: Scope = "user";
  let selectedId = "";
  let draft: Destination | undefined;
  let testNotification: Notification | undefined;
  let testDestination: Destination | undefined;
  const current = () => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error("Session replaced.");
  };
  const apply = async (operation: Promise<Snapshot>) => {
    const snapshot = await operation;
    current();
    coordinator.apply(snapshot.effective);
  };
  const knownDestination = () => {
    const destination = store.snapshot.effective.destinations[selectedId];
    if (!destination) throw new Error("Destination is unavailable.");
    return destination;
  };
  const assertDraft = () => {
    if (!draft) throw new Error("Destination draft is unavailable.");
    return draft;
  };
  const draftLines = () =>
    draft
      ? [
          `Label: ${safeText(draft.label)}`,
          `Chat: ${safeText(draft.chatId)}`,
          `Topic: ${draft.messageThreadId ?? "none"}`,
          "Bot token: configured (hidden)",
        ]
      : ["No destination draft."];
  const menu = defineMenu<State, Screen, Action>({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Notify",
        lines: [
          `Notifications: ${state.snapshot.effective.enabled ? "enabled" : "disabled"} · ${state.snapshot.effective.mode}`,
          `Selected: ${state.snapshot.effective.targetIds.map((id) => safeText(state.snapshot.effective.destinations[id]?.label ?? id)).join(", ") || "none"}`,
          `Editing: ${scope === "user" ? "User" : "Project"}`,
          ...state.snapshot.diagnostics,
        ],
        items: [
          { id: "destinations", label: "Telegram destinations", to: "destinations" },
          { id: "test", label: "Send test to Telegram…", to: "testSelect" },
          { id: "settings", label: "Settings", to: "settings" },
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
        ],
        hint: "close",
      }),
      destinations: ({ state }) => ({
        kind: "actions",
        title: "Telegram destinations · User",
        items: [
          ...Object.entries(state.snapshot.effective.destinations).map(([id, value]) => ({
            id,
            label: safeText(value.label),
            description: `Telegram · ${safeText(value.chatId)} · token configured`,
            action: "select" as const,
          })),
          { id: "add", label: "Add Telegram destination", action: "add" },
        ],
      }),
      destination: () => ({
        kind: "actions",
        title: "Telegram destination · User",
        lines: [
          `Label: ${safeText(knownDestination().label)}`,
          `Chat: ${safeText(knownDestination().chatId)}`,
          "Bot token: configured (hidden)",
        ],
        items: [
          { id: "edit", label: "Edit destination", action: "edit" },
          { id: "remove", label: "Remove destination…", to: "remove" },
        ],
      }),
      settings: ({ state }) => {
        const own = state.snapshot[scope];
        const inherited = (key: (typeof policyKeys)[number]) => scope === "project" && !Object.hasOwn(own, key);
        return {
          kind: "settings",
          title: `Notify Settings · ${scope === "user" ? "User" : "Project"}`,
          lines: ["Changes save immediately. Closing does not undo saved changes."],
          items: [
            {
              id: "scope",
              label: "Scope",
              currentValue: scope === "user" ? "User" : "Project",
              values: ["User", "Project"],
              action: "scope",
              description: store.projectPath
                ? "Project overrides require trust."
                : "Project scope is unavailable until trusted.",
            },
            {
              id: "enabled",
              label: "Notifications",
              currentValue: inherited("enabled") ? "Inherit" : String(own.enabled ?? false),
              values: scope === "project" ? ["Inherit", "true", "false"] : ["false", "true"],
              action: "policy",
              description: `Effective: ${state.snapshot.effective.enabled}. Source: ${Object.hasOwn(state.snapshot.project, "enabled") ? "Project" : Object.hasOwn(state.snapshot.user, "enabled") ? "User" : "default"}.`,
            },
            {
              id: "mode",
              label: "Mode",
              currentValue: inherited("mode") ? "Inherit" : String(own.mode ?? "immediate"),
              values:
                scope === "project" ? ["Inherit", "immediate", "after-inactivity"] : ["immediate", "after-inactivity"],
              action: "policy",
              description: `Effective: ${state.snapshot.effective.mode}. Inactivity falls back to immediate outside TUI.`,
            },
            {
              id: "inactivitySeconds",
              label: "Inactivity time",
              currentValue: `${state.editing.inactivitySeconds}s${inherited("inactivitySeconds") ? " (inherited)" : ""}`,
              disabled: state.editing.mode !== "after-inactivity",
              action: "delay",
              description: "Available only in after-inactivity mode. Measures activity, not reading.",
            },
            {
              id: "targetIds",
              label: "Selected destinations",
              currentValue: `${state.editing.targetIds.length}${inherited("targetIds") ? " (inherited)" : ""}`,
              action: "target",
              description: "Select existing User destinations for this scope.",
            },
          ],
        };
      },
      targets: ({ state }) => ({
        kind: "multiSelect",
        title: `Selected destinations · ${scope}`,
        items: Object.entries(state.snapshot.effective.destinations).map(([id, value]) => ({
          id,
          label: safeText(value.label),
          description: safeText(value.chatId),
          selected: state.editing.targetIds.includes(id),
        })),
        action: "target",
        enableSearch: true,
        actions:
          scope === "project"
            ? [{ id: "inherit", label: "Restore inherited selection", action: "inheritTargets" }]
            : [],
      }),
      delay: () => ({
        kind: "choice",
        title: `Inactivity time · ${scope}`,
        items: [
          ...(scope === "project" ? [{ id: "inherit", label: "Inherit User setting" }] : []),
          { id: "30", label: "30 seconds" },
          { id: "60", label: "1 minute" },
          { id: "120", label: "2 minutes" },
          { id: "custom", label: "Custom seconds…" },
        ],
        action: "delay",
      }),
      customDelay: ({ state }) => ({
        kind: "input",
        title: "Inactivity seconds",
        lines: ["Whole seconds from 1 to 86400."],
        initialValue: String(state.editing.inactivitySeconds),
        action: "customDelay",
      }),
      label: () => ({
        kind: "input",
        title: "Telegram destination label",
        initialValue: assertDraft().label,
        action: "label",
      }),
      chat: () => ({
        kind: "input",
        title: "Telegram chat ID",
        lines: ["Numeric private chat, group, or supergroup ID. Group IDs can be negative."],
        initialValue: assertDraft().chatId,
        action: "chat",
      }),
      topic: () => ({
        kind: "input",
        title: "Forum topic ID (optional)",
        lines: ["Leave empty for no topic."],
        initialValue: String(assertDraft().messageThreadId ?? ""),
        action: "topic",
      }),
      review: () => ({
        kind: "actions",
        title: "Review Telegram destination · User",
        lines: draftLines(),
        items: [
          { id: "save", label: "Save destination", action: "save" },
          { id: "token", label: "Replace bot token…", action: "token" },
        ],
      }),
      remove: () => ({
        kind: "actions",
        title: "Remove Telegram destination?",
        lines: [
          safeText(knownDestination().label),
          "Also removes its User selection. Existing messages are not recalled.",
          "Remove any Project selection first.",
        ],
        items: [{ id: "confirm", label: "Remove destination", action: "remove" }],
      }),
      testSelect: ({ state }) => ({
        kind: "actions",
        title: "Test destination · sends externally",
        items: Object.entries(state.snapshot.effective.destinations).map(([id, value]) => ({
          id,
          label: safeText(value.label),
          action: "prepareTest" as const,
        })),
      }),
      testReview: () => ({
        kind: "review",
        title: `Send test to ${safeText(testDestination?.label ?? "Telegram")}?`,
        content: `${testNotification?.title ?? ""}\n${testNotification?.body ?? ""}`,
        viewportSize: "adaptive",
        confirm: { id: "send", label: "Send test to Telegram", action: "sendTest" },
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Notify Status",
        lines: [
          `User: ${displayPath(store.userPath)}`,
          `Project: ${store.projectPath ? displayPath(store.projectPath) : "not trusted / unavailable"}`,
          ...policyKeys.map(
            (key) =>
              `${key}: source ${Object.hasOwn(state.snapshot.project, key) ? "Project" : Object.hasOwn(state.snapshot.user, key) ? "User" : "default"}`,
          ),
          `Pending reminder: ${coordinator.pendingAt ? new Date(coordinator.pendingAt).toISOString() : "none"}`,
          ...Object.entries(state.snapshot.effective.destinations).map(([id, value]) => {
            const result = coordinator.statuses.get(id)?.result;
            return `${safeText(value.label)} · ${state.snapshot.effective.targetIds.includes(id) ? "selected" : "not selected"} · token configured (User) · ${result ? (result.state === "failed" ? `${result.code}${result.retryAfterSeconds ? `; retry after ${result.retryAfterSeconds}s (not automatic)` : ""}` : result.state) : "no delivery"}`;
          }),
          ...state.snapshot.diagnostics,
        ],
      }),
      help: () => ({ kind: "detail", title: "Notify Help", lines: helpLines }),
    },
    actions: {
      scope: ({ value }) => {
        if (value === "Project" && !store.projectPath)
          throw new Error("Trust the project before editing Project settings.");
        scope = value === "Project" ? "project" : "user";
        return { kind: "stay" };
      },
      policy: async ({ itemId, value, signal: actionSignal }) => {
        if (itemId !== "enabled" && itemId !== "mode") throw new Error("Invalid setting.");
        await apply(
          savePolicy(
            store,
            scope,
            itemId,
            value === "Inherit" ? undefined : itemId === "enabled" ? value === "true" : value,
            actionSignal,
          ),
        );
        return { kind: "stay" };
      },
      delay: async ({ itemId, signal: actionSignal }) => {
        if (itemId === "inactivitySeconds") return { kind: "to", screen: "delay" };
        if (itemId === "custom") return { kind: "to", screen: "customDelay" };
        await apply(
          savePolicy(
            store,
            scope,
            "inactivitySeconds",
            itemId === "inherit" ? undefined : Number(itemId),
            actionSignal,
          ),
        );
        return { kind: "back" };
      },
      customDelay: async ({ value, signal: actionSignal }) => {
        if (!value || !/^\d+$/.test(value) || !validSeconds(Number(value)))
          throw new Error("Use whole seconds from 1 to 86400.");
        await apply(savePolicy(store, scope, "inactivitySeconds", Number(value), actionSignal));
        return { kind: "to", screen: "settings" };
      },
      target: async ({ itemId, selected, signal: actionSignal }) => {
        if (itemId === "targetIds") return { kind: "to", screen: "targets" };
        await apply(
          store.change(
            scope,
            (document, project, user) => {
              const edited = resolveSettings(user, scope === "project" ? project : {}, providers).effective;
              const ids = new Set(edited.targetIds);
              if (selected) ids.add(itemId);
              else ids.delete(itemId);
              document.targetIds = [...ids];
            },
            actionSignal,
          ),
        );
        return { kind: "stay" };
      },
      inheritTargets: async ({ signal: actionSignal }) => {
        await apply(savePolicy(store, "project", "targetIds", undefined, actionSignal));
        return { kind: "stay" };
      },
      select: ({ itemId }) => {
        selectedId = itemId;
        return { kind: "to", screen: "destination" };
      },
      add: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, { title: "Telegram bot token", signal: actionSignal, isCurrent });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        if (result.kind !== "submitted") return { kind: "stay" };
        selectedId = randomUUID();
        draft = { provider: "telegram", label: "", botToken: result.value.trim(), chatId: "" };
        return { kind: "to", screen: "label" };
      },
      edit: () => {
        draft = { ...knownDestination() };
        return { kind: "to", screen: "label" };
      },
      token: async ({ signal: actionSignal }) => {
        const result = await runSecretInput(menuCtx, {
          title: "Replace Telegram bot token",
          signal: actionSignal,
          isCurrent,
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "submitted") assertDraft().botToken = result.value.trim();
        if (result.kind === "closed" && result.reason === "close") return { kind: "close" };
        return { kind: "stay" };
      },
      label: ({ value }) => {
        if (!value?.trim() || value.length > 128) throw new Error("Use a label from 1 to 128 characters.");
        assertDraft().label = value.trim();
        return { kind: "to", screen: "chat" };
      },
      chat: ({ value }) => {
        if (!value || !/^-?[1-9]\d{0,30}$/.test(value.trim())) throw new Error("Use a numeric Telegram chat ID.");
        assertDraft().chatId = value.trim();
        return { kind: "to", screen: "topic" };
      },
      topic: ({ value }) => {
        const topic = value?.trim();
        if (topic && (!/^\d+$/.test(topic) || !Number.isSafeInteger(Number(topic)) || Number(topic) <= 0))
          throw new Error("Use a positive whole topic ID or leave it empty.");
        if (topic) assertDraft().messageThreadId = Number(topic);
        else delete assertDraft().messageThreadId;
        return { kind: "to", screen: "review" };
      },
      save: async ({ signal: actionSignal }) => {
        const destination = providers.get("telegram")?.validate(assertDraft());
        if (!destination) throw new Error("Invalid Telegram destination. Check the bot token and chat ID.");
        await apply(saveDestination(store, selectedId, destination, actionSignal));
        draft = undefined;
        return { kind: "to", screen: "main" };
      },
      remove: async ({ signal: actionSignal }) => {
        await apply(saveDestination(store, selectedId, undefined, actionSignal));
        return { kind: "to", screen: "main" };
      },
      prepareTest: async ({ itemId, signal: actionSignal }) => {
        selectedId = itemId;
        testDestination = { ...knownDestination() };
        const now = Date.now();
        const notification = await notificationMetadata(
          {
            id: `test-${randomUUID()}`,
            sessionId: ctx.sessionManager.getSessionId(),
            sessionName: ctx.sessionManager.getSessionName(),
            cwd: ctx.cwd,
            startedAt: now,
            settledAt: now,
            error: false,
          },
          actionSignal,
        );
        actionSignal.throwIfAborted();
        current();
        testNotification = { ...notification, title: "Pi notification test" };
        return { kind: "to", screen: "testReview" };
      },
      sendTest: async ({ signal: actionSignal }) => {
        current();
        if (!testDestination || !testNotification) throw new Error("Prepare a new test.");
        const destination = testDestination;
        const notification = testNotification;
        const result = await runTask(menuCtx, {
          label: "Sending Telegram test…",
          signal: actionSignal,
          isCurrent,
          task: ({ signal: taskSignal }) => coordinator.send(selectedId, destination, notification, taskSignal),
        });
        actionSignal.throwIfAborted();
        current();
        if (result.kind === "completed")
          ctx.ui.notify(
            result.value.state === "accepted"
              ? "Telegram accepted the test notification."
              : `Telegram test: ${result.value.state === "failed" ? result.value.code : result.value.state}.`,
            result.value.state === "accepted" ? "info" : "warning",
          );
        if (result.kind === "cancelled") return { kind: "close" };
        return { kind: "to", screen: "main" };
      },
    },
  });
  try {
    return await runMenu(menuCtx, menu, {
      signal,
      isCurrent,
      getState: () => ({
        snapshot: store.snapshot,
        editing: resolveSettings(store.snapshot.user, scope === "project" ? store.snapshot.project : {}, providers)
          .effective,
      }),
      onError: () => {
        if (isCurrent())
          ctx.ui.notify(
            "Notify operation failed. Check the input, settings file, and Project selections. No credential values are shown.",
            "error",
          );
      },
    });
  } finally {
    draft = undefined;
    testDestination = undefined;
    testNotification = undefined;
  }
}
