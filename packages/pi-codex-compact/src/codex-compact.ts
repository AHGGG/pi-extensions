import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { adoptWarmCompaction, startWarmCompaction, type WarmCompactionJob } from "./async-compaction.js";
import {
  type CodexCheckpointDetails,
  checkpointMarker,
  hasActiveCheckpointClaim,
  latestCheckpoint,
  parseCheckpointDetails,
} from "./checkpoint.js";
import { projectSessionCheckpointContext } from "./checkpoint-projection.js";
import { type CompactionAttempt, compactRemotely } from "./compaction-operation.js";
import { type RemoteCompactionProtocol, resolveCompactionRoute } from "./model-api.js";
import { hasCheckpointMarker, rewriteCheckpointMarker } from "./protocol.js";
import { RejectedRoutes, rejectionRouteKey } from "./rejection-state.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  compactionSettingsKey,
  createCodexCompactSettingsRuntime,
} from "./settings.js";
import { terminalText } from "./terminal.js";

const STATUS_KEY = "codex-compact";
const CONTINUATION_TYPE = "codex-compact:continue-v1";
const CONTINUATION_MESSAGE =
  "Conversation compaction is complete. Continue unfinished work under the original conversation instructions, " +
  "using tools when needed. If the work is already complete, provide the final result without repeating completed actions.";

function activeCheckpoint(ctx: ExtensionContext) {
  return latestCheckpoint(ctx.sessionManager.getBranch());
}

function isCheckpointCompatible(
  details: CodexCheckpointDetails,
  model: Model<Api> | undefined,
  settings: CodexCompactSettings,
): boolean {
  const route = resolveCompactionRoute(model, settings);
  return (
    route.kind === "remote" &&
    model !== undefined &&
    route.api === details.api &&
    route.profile === details.profile &&
    model.id === details.modelId
  );
}

export function createCodexCompactExtension(
  options: { fetch?: typeof globalThis.fetch; settingsRuntime?: CodexCompactSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const providerWarnings = new Set<string>();
    const settingsRuntime = options.settingsRuntime ?? createCodexCompactSettingsRuntime();
    type ContinuationRun = {
      used: boolean;
      pending?: {
        checkpointId: string;
        routeKey: string;
        settingsKey: string;
        entryId?: string;
      };
    };
    type Owner = {
      controller: AbortController;
      rejected: RejectedRoutes;
      sessionId: string;
      operation?: AbortController;
      warm?: WarmCompactionJob;
      compactionPending?: boolean;
      run?: ContinuationRun;
      lastRoute?: { key: string; protocol: RemoteCompactionProtocol };
    };
    const owners = new WeakMap<object, Owner>();
    const ownerFor = (ctx: ExtensionContext): Owner => {
      let owner = owners.get(ctx.sessionManager);
      const sessionId = ctx.sessionManager.getSessionId();
      if (owner?.controller.signal.aborted) return owner;
      if (!owner || owner.sessionId !== sessionId) {
        owner?.controller.abort();
        if (owner) ctx.ui.setStatus(STATUS_KEY, undefined);
        owner = { controller: new AbortController(), rejected: new RejectedRoutes(), sessionId };
        owners.set(ctx.sessionManager, owner);
      }
      return owner;
    };

    // Lifecycle-only notices: never include prompts, checkpoints, auth, or provider errors.
    const logCompaction = (ctx: ExtensionContext, message: string) => {
      const owner = owners.get(ctx.sessionManager);
      if (
        ctx.hasUI &&
        settingsRuntime.get().settings.logCompaction &&
        owner &&
        !owner.controller.signal.aborted &&
        owner.sessionId === ctx.sessionManager.getSessionId()
      )
        ctx.ui.notify(`[codex-compact] ${message}`, "info");
    };

    const cancelWarm = (ctx: ExtensionContext) => {
      const owner = owners.get(ctx.sessionManager);
      if (!owner?.warm) return;
      if (owner.warm.state !== "Failed")
        logCompaction(
          ctx,
          owner.warm.state === "Ready" ? "Async compaction checkpoint discarded." : "Async compaction cancelled.",
        );
      owner.warm.controller.abort();
      owner.warm = undefined;
      if (!owner.operation) ctx.ui.setStatus(STATUS_KEY, undefined);
    };

    const cancelOperation = (ctx: ExtensionContext) => {
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.compactionPending = false;
      const operation = owner?.operation;
      if (!owner || !operation) return;
      operation.abort();
      if (owners.get(ctx.sessionManager) === owner && owner.operation === operation) {
        owner.operation = undefined;
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    pi.registerCommand("codex-compact", {
      description: "Compact now or configure Responses compaction",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /codex-compact");
        const owner = ownerFor(ctx);
        const controller = owner.controller;
        const { showCodexCompactMenu } = await import("./settings-menu.js");
        if (owners.get(ctx.sessionManager) !== owner || controller.signal.aborted) return;
        await showCodexCompactMenu(settingsRuntime, ctx, {
          signal: controller.signal,
          isCurrent: () =>
            owners.get(ctx.sessionManager) === owner &&
            !controller.signal.aborted &&
            ctx.sessionManager.getSessionId() === owner.sessionId,
          isPaused: () => {
            const route = resolveCompactionRoute(ctx.model, settingsRuntime.get().settings);
            return (
              !!ctx.model && route.kind === "remote" && owner.rejected.hasObserved(rejectionRouteKey(ctx.model, route))
            );
          },
          lastProtocol: () => {
            const route = resolveCompactionRoute(ctx.model, settingsRuntime.get().settings);
            return ctx.model && route.kind === "remote" && owner.lastRoute?.key === rejectionRouteKey(ctx.model, route)
              ? owner.lastRoute.protocol
              : undefined;
          },
          backgroundStatus: () => (owner.warm?.state === "Failed" ? undefined : owner.warm?.state),
          onSettingsChanged: () => {
            cancelOperation(ctx);
            cancelWarm(ctx);
          },
          hasCheckpoint: () => hasActiveCheckpointClaim(ctx.sessionManager.getBranch()),
          canReplayCheckpoint: () => {
            const checkpoint = activeCheckpoint(ctx);
            return (
              !!checkpoint && isCheckpointCompatible(checkpoint.details, ctx.model, settingsRuntime.get().settings)
            );
          },
        });
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      owners.get(ctx.sessionManager)?.controller.abort();
      const owner: Owner = {
        controller: new AbortController(),
        rejected: new RejectedRoutes(),
        sessionId: ctx.sessionManager.getSessionId(),
      };
      owners.set(ctx.sessionManager, owner);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      const sessionId = ctx.sessionManager.getSessionId();
      providerWarnings.clear();
      let state: Readonly<CodexCompactSettingsState>;
      try {
        state = await settingsRuntime.reload(owner.controller.signal);
      } catch (error) {
        if (
          owner.controller.signal.aborted ||
          owners.get(ctx.sessionManager) !== owner ||
          ctx.sessionManager.getSessionId() !== sessionId
        )
          return;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-codex-compact.json; using defaults. ${terminalText(error instanceof Error ? error.message : String(error))}`,
            "warning",
          );
        }
        return;
      }
      if (
        owner.controller.signal.aborted ||
        owners.get(ctx.sessionManager) !== owner ||
        ctx.sessionManager.getSessionId() !== sessionId
      ) {
        return;
      }
      if (ctx.hasUI && state.kind === "invalid") {
        ctx.ui.notify(
          `Invalid pi-codex-compact.json; using defaults without overwriting it. ${terminalText(state.issue ?? "unknown validation error")}`,
          "warning",
        );
      }
    });

    // before_agent_start follows pre-prompt compaction and runs once per user run,
    // unlike agent_start, which also fires for Pi retries and our continuation.
    pi.on("before_agent_start", (_event, ctx) => {
      const owner = ownerFor(ctx);
      if (!owner.controller.signal.aborted) owner.run = { used: false };
    });

    pi.on("turn_end", (event, ctx) => {
      const owner = ownerFor(ctx);
      if (event.outcome !== "completed" || ctx.signal?.aborted) {
        cancelWarm(ctx);
        return;
      }
      if (owner.warm && !owner.warm.isCurrent()) cancelWarm(ctx);
      if (owner.warm || owner.operation || owner.controller.signal.aborted) return;
      let warm: WarmCompactionJob | undefined;
      warm = startWarmCompaction(
        pi,
        ctx,
        settingsRuntime,
        owner.controller.signal,
        owner.rejected,
        () => owners.get(ctx.sessionManager) === owner && owner.sessionId === ctx.sessionManager.getSessionId(),
        () => owners.get(ctx.sessionManager) === owner && owner.warm === warm && !owner.operation,
        (protocol) => {
          const route = resolveCompactionRoute(ctx.model, settingsRuntime.get().settings);
          if (ctx.model && route.kind === "remote")
            owner.lastRoute = { key: rejectionRouteKey(ctx.model, route), protocol };
        },
        options.fetch,
      );
      owner.warm = warm;
      if (warm) {
        logCompaction(ctx, "Async compaction triggered: preparing a checkpoint in the background.");
        const job = warm;
        const report = (message: string) => {
          if (owners.get(ctx.sessionManager) === owner && owner.warm === job && job.isCurrent())
            logCompaction(ctx, message);
        };
        void job.promise.then(
          () =>
            report(
              job.state === "Ready"
                ? "Async compaction ready: checkpoint prepared; history is unchanged until actual compaction."
                : "Async compaction failed: actual compaction will use the foreground recovery path.",
            ),
          () => report("Async compaction failed: actual compaction will use the foreground path."),
        );
      }
    });

    pi.on("session_before_compact", (event, ctx) => {
      const owner = ownerFor(ctx);
      const run = owner.run;
      const reason = event.reason === "manual" ? "manual" : event.reason === "overflow" ? "overflow" : "threshold";
      logCompaction(ctx, `Actual compaction triggered (${reason}).`);
      if (run) run.pending = undefined;
      cancelOperation(ctx);
      owner.compactionPending = true;
      if (event.reason === "manual") cancelWarm(ctx);
      const warm = owner.warm;
      const operation = new AbortController();
      owner.operation = operation;
      const settings = settingsRuntime.get().settings;
      const model = ctx.model;
      const route = resolveCompactionRoute(model, settings);
      const key = model && route.kind === "remote" ? rejectionRouteKey(model, route) : undefined;
      const isCurrent = () => {
        if (owners.get(ctx.sessionManager) !== owner || owner.operation !== operation || operation.signal.aborted)
          return false;
        const currentSettings = settingsRuntime.get().settings;
        const currentRoute = resolveCompactionRoute(ctx.model, currentSettings);
        return (
          compactionSettingsKey(currentSettings) === compactionSettingsKey(settings) &&
          (key === undefined ||
            (!!ctx.model && currentRoute.kind === "remote" && rejectionRouteKey(ctx.model, currentRoute) === key))
        );
      };
      const execute = async () => {
        let failedAttempt: CompactionAttempt | undefined;
        if (warm) {
          if (warm.state === "Preparing" && warm.isCurrent())
            logCompaction(ctx, "Actual compaction is waiting for the in-flight async checkpoint.");
          const adoption = await adoptWarmCompaction(
            warm,
            event,
            ctx,
            settingsRuntime,
            AbortSignal.any([owner.controller.signal, operation.signal]),
            isCurrent,
          );
          if (owner.warm === warm) owner.warm = undefined;
          warm.controller.abort();
          if (adoption.kind === "cancel") return { cancel: true };
          if (adoption.kind === "ready") {
            if (isCurrent()) logCompaction(ctx, "Actual compaction is reusing the async checkpoint.");
            return adoption.result;
          }
          if (isCurrent()) logCompaction(ctx, "Async checkpoint unavailable; using the foreground compaction path.");
          if (adoption.kind === "failed") failedAttempt = adoption.attempt;
        }
        return compactRemotely(
          pi,
          event,
          ctx,
          settings,
          AbortSignal.any([owner.controller.signal, operation.signal]),
          owner.rejected,
          isCurrent,
          () => owners.get(ctx.sessionManager) === owner && owner.operation === operation,
          (protocol) => {
            if (isCurrent() && key) owner.lastRoute = { key, protocol };
          },
          options.fetch,
          { failedAttempt },
        );
      };
      return execute()
        .then((result) => {
          if (isCurrent() && !owner.controller.signal.aborted && !event.signal.aborted) {
            if (result && "cancel" in result && result.cancel) {
              logCompaction(ctx, "Actual compaction cancelled; history preserved.");
              owner.compactionPending = false;
            } else if (!result) {
              logCompaction(ctx, "Actual compaction handed to Pi native compaction.");
            }
          }
          const details =
            result && "compaction" in result ? parseCheckpointDetails(result.compaction?.details) : undefined;
          if (
            run &&
            owner.run === run &&
            !run.used &&
            isCurrent() &&
            !owner.controller.signal.aborted &&
            event.reason !== "manual" &&
            !event.willRetry &&
            route.kind === "remote" &&
            key &&
            // Auto/V2 preferences can resolve to Context Management for ChatGPT OAuth.
            // Arm continuation from the successful checkpoint, not the preference.
            details?.protocol === "context-management"
          ) {
            // A returned result is not yet a committed checkpoint. Only the matching
            // session_compact event can arm it for the settlement boundary.
            run.pending = {
              checkpointId: details.checkpointId,
              routeKey: key,
              settingsKey: compactionSettingsKey(settings),
            };
          }
          return result;
        })
        .finally(() => {
          if (owners.get(ctx.sessionManager) === owner && owner.operation === operation) {
            owner.operation = undefined;
            if (!owner.controller.signal.aborted && owner.sessionId === ctx.sessionManager.getSessionId()) {
              ctx.ui.setStatus(STATUS_KEY, undefined);
            }
          }
          operation.abort();
        });
    });

    pi.on("session_compact", (event, ctx) => {
      cancelWarm(ctx);
      const owner = owners.get(ctx.sessionManager);
      if (owner?.compactionPending) {
        logCompaction(ctx, "Actual compaction completed: checkpoint committed.");
        owner.compactionPending = false;
      }
      const run = owner?.run;
      const pending = run?.pending;
      if (!owner || !run || !pending || pending.entryId) return;
      const checkpoint = activeCheckpoint(ctx);
      if (
        !owner.controller.signal.aborted &&
        owner.sessionId === ctx.sessionManager.getSessionId() &&
        event.fromExtension &&
        event.reason !== "manual" &&
        !event.willRetry &&
        checkpoint?.entry.id === event.compactionEntry.id &&
        checkpoint.details.checkpointId === pending.checkpointId
      ) {
        pending.entryId = checkpoint.entry.id;
      } else {
        run.pending = undefined;
      }
    });

    pi.on("agent_before_settle", (event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      const run = owner?.run;
      const pending = run?.pending;
      if (!owner || !run || !pending?.entryId) return;
      // Consume the candidate even when another participant already continues.
      // Repeated events cannot replay it at a later or unrelated boundary.
      run.pending = undefined;
      const settings = settingsRuntime.get().settings;
      const route = resolveCompactionRoute(ctx.model, settings);
      const checkpoint = activeCheckpoint(ctx);
      if (
        run.used ||
        owner.controller.signal.aborted ||
        ctx.signal?.aborted ||
        owner.sessionId !== ctx.sessionManager.getSessionId() ||
        event.outcome !== "completed" ||
        route.kind !== "remote" ||
        checkpoint?.details.protocol !== "context-management" ||
        !ctx.model ||
        rejectionRouteKey(ctx.model, route) !== pending.routeKey ||
        compactionSettingsKey(settings) !== pending.settingsKey ||
        checkpoint?.entry.id !== pending.entryId ||
        checkpoint.details.checkpointId !== pending.checkpointId ||
        !isCheckpointCompatible(checkpoint.details, ctx.model, settings) ||
        (event.continue && event.context.canContinue) ||
        // Boundary pendingMessages also includes context-only custom messages.
        // They can make canContinue true without scheduling any provider request.
        (ctx.hasPendingMessages() && event.context.canContinue) ||
        !projectSessionCheckpointContext(event.context.contextMessages, ctx.sessionManager.getBranch(), checkpoint)
      ) {
        return;
      }
      run.used = true;
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message" as const,
            customType: CONTINUATION_TYPE,
            content: CONTINUATION_MESSAGE,
            display: false,
            details: { checkpointId: pending.checkpointId },
          },
        ],
        continue: true,
      };
    });

    pi.on("session_compact_failed", (_event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      if (owner?.compactionPending) {
        logCompaction(ctx, "Actual compaction did not complete (failed or cancelled).");
        owner.compactionPending = false;
      }
      const run = owner?.run;
      if (run) run.pending = undefined;
    });

    pi.on("agent_settled", (event, ctx) => {
      if (event.aborted) cancelWarm(ctx);
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
    });

    pi.on("context", (event, ctx) => {
      const warm = owners.get(ctx.sessionManager)?.warm;
      if (warm && !warm.isCurrent()) cancelWarm(ctx);
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model, settings)) return undefined;
      const messages = projectSessionCheckpointContext(event.messages, ctx.sessionManager.getBranch(), checkpoint);
      return messages ? { messages } : undefined;
    });

    pi.on("before_provider_request", (event, ctx) => {
      // This hook is for normal session requests, not the separate maintenance
      // call. Mid-turn compaction and queued work already satisfy continuation.
      const run = owners.get(ctx.sessionManager)?.run;
      if (run?.pending?.entryId) run.pending = undefined;
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model, settings)) return undefined;
      const marker = checkpointMarker(checkpoint.details.checkpointId);
      if (!hasCheckpointMarker(event.payload, marker)) return undefined;
      return rewriteCheckpointMarker(event.payload, marker, checkpoint.details.replacementHistory);
    });

    const beforeNavigation = (_event: unknown, ctx: ExtensionContext) => {
      cancelOperation(ctx);
      cancelWarm(ctx);
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
    };
    pi.on("session_before_switch", beforeNavigation);
    pi.on("session_before_fork", beforeNavigation);
    pi.on("session_before_tree", beforeNavigation);
    pi.on("thinking_level_select", beforeNavigation);

    pi.on("session_tree", (_event, ctx) => {
      cancelOperation(ctx);
      cancelWarm(ctx);
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
    });

    pi.on("model_select", (event, ctx) => {
      cancelOperation(ctx);
      cancelWarm(ctx);
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
      if (!settingsRuntime.get().settings.enabled) return;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || isCheckpointCompatible(checkpoint.details, event.model, settings)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (providerWarnings.has(key)) return;
      providerWarnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The active Responses checkpoint cannot replay on this model; Pi will expose only its fallback marker and retained recent messages.",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const owner = owners.get(ctx.sessionManager) ?? ownerFor(ctx);
      owner.controller.abort();
      owner.rejected = new RejectedRoutes();
      owner.operation = undefined;
      owner.warm = undefined;
      owner.run = undefined;
      // Keep an aborted tombstone until session_start so queued old-context
      // events cannot recreate an active controller after shutdown.
      providerWarnings.clear();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      await settingsRuntime.flush();
    });
  };
}

export default createCodexCompactExtension();
