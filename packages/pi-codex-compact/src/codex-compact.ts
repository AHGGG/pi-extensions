import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortable } from "./abortable.js";
import {
  type CodexCheckpointDetails,
  checkpointMarker,
  hasActiveCheckpointClaim,
  latestCheckpoint,
  parseCheckpointDetails,
} from "./checkpoint.js";
import {
  checkpointIssuerRequest,
  PLAINTEXT_CHECKPOINT_TYPE,
  plaintextCheckpointMessages,
  savedPlaintextCheckpoint,
} from "./checkpoint-portability.js";
import { projectSessionCheckpointContext } from "./checkpoint-projection.js";
import { summarizeCheckpoint } from "./checkpoint-recovery.js";
import { rewriteCheckpointForWork } from "./checkpoint-replay.js";
import { activeTools, type CompactionAttempt, compactRemotely } from "./compaction-operation.js";
import { captureCompactionBranch, captureExactCompactionBranch } from "./compaction-ownership.js";
import { type RemoteCompactionProtocol, resolveCompactionRoute } from "./model-api.js";
import { captureCheckpointPreparation, preparedAttempts } from "./prepared-compaction.js";
import {
  COMPACTION_ENGINE_AVAILABLE,
  COMPACTION_ENGINE_REQUEST,
  type CompactionEngineRequest,
  type CompactionEngineV1,
  type PreparedCompactionSource,
} from "./prepared-compaction-protocol.js";
import { hasCheckpointMarker } from "./protocol.js";
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
    model.provider === details.provider &&
    route.api === details.api &&
    route.profile === details.profile
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
      run?: ContinuationRun;
      lastRoute?: { key: string; protocol: RemoteCompactionProtocol };
    };
    const owners = new WeakMap<object, Owner>();
    const activeManagers = new Set<object>();
    const ownerFor = (ctx: ExtensionContext): Owner => {
      let owner = owners.get(ctx.sessionManager);
      const sessionId = ctx.sessionManager.getSessionId();
      if (owner?.controller.signal.aborted) return owner;
      if (!owner || owner.sessionId !== sessionId) {
        owner?.controller.abort();
        if (owner) ctx.ui.setStatus(STATUS_KEY, undefined);
        owner = { controller: new AbortController(), rejected: new RejectedRoutes(), sessionId };
        owners.set(ctx.sessionManager, owner);
        activeManagers.add(ctx.sessionManager);
      }
      return owner;
    };

    const cancelOperation = (ctx: ExtensionContext) => {
      const owner = owners.get(ctx.sessionManager);
      const operation = owner?.operation;
      if (!owner || !operation) return;
      operation.abort();
      if (owners.get(ctx.sessionManager) === owner && owner.operation === operation) {
        owner.operation = undefined;
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    let source: PreparedCompactionSource | undefined;
    const engine: CompactionEngineV1 = {
      version: 1,
      available(ctx) {
        const owner = ownerFor(ctx);
        const route = resolveCompactionRoute(ctx.model, settingsRuntime.get().settings);
        return (
          !owner.controller.signal.aborted &&
          !owner.operation &&
          settingsRuntime.get().settings.enabled &&
          !!ctx.model &&
          route.kind === "remote" &&
          !owner.rejected.hasObserved(rejectionRouteKey(ctx.model, route))
        );
      },
      capture(ctx) {
        if (!engine.available(ctx)) return undefined;
        const owner = ownerFor(ctx);
        return captureCheckpointPreparation(
          pi,
          ctx,
          settingsRuntime,
          owner.controller.signal,
          owner.rejected,
          () => owners.get(ctx.sessionManager) === owner && owner.sessionId === ctx.sessionManager.getSessionId(),
          (protocol) => {
            const route = resolveCompactionRoute(ctx.model, settingsRuntime.get().settings);
            if (!owner.controller.signal.aborted && ctx.model && route.kind === "remote")
              owner.lastRoute = { key: rejectionRouteKey(ctx.model, route), protocol };
          },
          options.fetch,
        );
      },
      checkpointId: (ctx) => activeCheckpoint(ctx)?.details.checkpointId,
      captureBoundary(ctx) {
        const owner = ownerFor(ctx);
        const branchIsCurrent = captureExactCompactionBranch(ctx.sessionManager.getBranch());
        return () =>
          !owner.controller.signal.aborted &&
          owners.get(ctx.sessionManager) === owner &&
          owner.sessionId === ctx.sessionManager.getSessionId() &&
          branchIsCurrent(ctx.sessionManager.getBranch());
      },
      attachSource(candidate) {
        if (source) throw new Error("A prepared-compaction source is already registered");
        source = candidate;
        return () => {
          if (source === candidate) source = undefined;
        };
      },
    };
    let removeDiscovery: (() => void) | undefined;
    const installDiscovery = () => {
      if (!removeDiscovery)
        removeDiscovery = pi.events?.on(COMPACTION_ENGINE_REQUEST, (request: unknown) => {
          if (request && typeof (request as CompactionEngineRequest).accept === "function")
            (request as CompactionEngineRequest).accept(engine);
        });
    };
    installDiscovery();
    pi.events?.emit(COMPACTION_ENGINE_AVAILABLE, engine);

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
          onSettingsChanged: () => {
            cancelOperation(ctx);
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
      installDiscovery();
      pi.events?.emit(COMPACTION_ENGINE_AVAILABLE, engine);
      owners.get(ctx.sessionManager)?.controller.abort();
      const owner: Owner = {
        controller: new AbortController(),
        rejected: new RejectedRoutes(),
        sessionId: ctx.sessionManager.getSessionId(),
      };
      owners.set(ctx.sessionManager, owner);
      activeManagers.add(ctx.sessionManager);
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

    pi.on("session_before_compact", (event, ctx) => {
      const owner = ownerFor(ctx);
      const run = owner.run;

      if (run) run.pending = undefined;
      cancelOperation(ctx);
      const operation = new AbortController();
      owner.operation = operation;
      const settings = settingsRuntime.get().settings;
      const model = ctx.model;
      const route = resolveCompactionRoute(model, settings);
      const key = model && route.kind === "remote" ? rejectionRouteKey(model, route) : undefined;
      const branchIsCurrent = captureCompactionBranch(event.branchEntries);
      const modelKey = JSON.stringify(model);
      const systemPrompt = ctx.getSystemPrompt?.();
      const toolsKey = JSON.stringify([pi.getActiveTools(), activeTools(pi)]);
      const thinkingLevel = pi.getThinkingLevel();
      let statusCleared = false;
      let sourceIsCurrent: (() => boolean) | undefined;
      const isCurrent = () => {
        if (
          owners.get(ctx.sessionManager) !== owner ||
          owner.operation !== operation ||
          operation.signal.aborted ||
          owner.controller.signal.aborted ||
          owner.sessionId !== ctx.sessionManager.getSessionId()
        )
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
        const selectedSource = source;
        if (selectedSource) {
          let supplied: Awaited<ReturnType<PreparedCompactionSource["beforeCompact"]>>;
          try {
            supplied = await selectedSource.beforeCompact(event, ctx, {
              signal: AbortSignal.any([owner.controller.signal, operation.signal]),
              isCurrent,
            });
          } catch {
            // Pi may continue after extension exceptions. Fail closed instead of
            // letting a broken optional source permit unsafe native compaction.
            return { cancel: true };
          }
          if (!supplied || !["absent", "cancel", "ready", "fallback"].includes(supplied.kind)) return { cancel: true };
          if (source !== selectedSource || !isCurrent() || event.signal.aborted) return { cancel: true };
          if (supplied.kind === "cancel") return { cancel: true };
          if (supplied.kind === "ready") {
            if (
              !supplied.result ||
              typeof supplied.result !== "object" ||
              (!supplied.result.compaction && supplied.result.cancel !== true)
            )
              return { cancel: true };
            sourceIsCurrent = () => {
              try {
                return source === selectedSource && (supplied.isCurrent?.() ?? true);
              } catch {
                return false;
              }
            };
            if (!sourceIsCurrent()) return { cancel: true };
            return supplied.result;
          }
          if (supplied.kind === "fallback" && supplied.prepared)
            failedAttempt = preparedAttempts.get(supplied.prepared);
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
          // Both reuse notices and status cleanup can reenter host code. Run
          // those callbacks before the final handoff check, not in finally after it.
          if (owners.get(ctx.sessionManager) === owner && owner.operation === operation) {
            statusCleared = true;
            if (!owner.controller.signal.aborted && owner.sessionId === ctx.sessionManager.getSessionId())
              ctx.ui.setStatus(STATUS_KEY, undefined);
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
          if (
            !isCurrent() ||
            (sourceIsCurrent && !sourceIsCurrent()) ||
            owner.controller.signal.aborted ||
            event.signal.aborted ||
            owner.sessionId !== ctx.sessionManager.getSessionId() ||
            JSON.stringify(ctx.model) !== modelKey ||
            ctx.getSystemPrompt?.() !== systemPrompt ||
            JSON.stringify([pi.getActiveTools(), activeTools(pi)]) !== toolsKey ||
            pi.getThinkingLevel() !== thinkingLevel ||
            !branchIsCurrent(ctx.sessionManager.getBranch())
          ) {
            if (run && owner.run === run) run.pending = undefined;
            return { cancel: true };
          }
          return result;
        })
        .finally(() => {
          if (owners.get(ctx.sessionManager) === owner && owner.operation === operation) {
            owner.operation = undefined;
            if (
              !statusCleared &&
              !owner.controller.signal.aborted &&
              owner.sessionId === ctx.sessionManager.getSessionId()
            ) {
              ctx.ui.setStatus(STATUS_KEY, undefined);
            }
          }
          operation.abort();
        });
    });

    pi.on("session_compact", (event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
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
      const run = owner?.run;
      if (run) run.pending = undefined;
    });

    pi.on("agent_settled", (_event, ctx) => {
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
    });

    pi.on("context", async (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint) return undefined;
      const route = resolveCompactionRoute(ctx.model, settings);
      if (
        route.kind !== "remote" ||
        route.api !== checkpoint.details.api ||
        route.profile !== checkpoint.details.profile
      )
        return undefined;
      const messages = projectSessionCheckpointContext(event.messages, ctx.sessionManager.getBranch(), checkpoint);
      if (!messages) return undefined;
      if (isCheckpointCompatible(checkpoint.details, ctx.model, settings)) return { messages };
      let summary = savedPlaintextCheckpoint(ctx.sessionManager.getBranch(), checkpoint);
      if (summary) return { messages: plaintextCheckpointMessages(messages, checkpoint, summary) };
      const owner = ownerFor(ctx);
      if (owner.controller.signal.aborted || ctx.signal?.aborted) return undefined;
      cancelOperation(ctx);
      const operation = new AbortController();
      owner.operation = operation;
      const signal = AbortSignal.any([owner.controller.signal, operation.signal, ...(ctx.signal ? [ctx.signal] : [])]);
      const model = ctx.model;
      const modelKey = JSON.stringify(model);
      const toolsKey = JSON.stringify([pi.getActiveTools(), activeTools(pi)]);
      const branchIsCurrent = captureCompactionBranch(ctx.sessionManager.getBranch());
      const systemPrompt = ctx.getSystemPrompt();
      const stillCurrent = () =>
        !signal.aborted &&
        owners.get(ctx.sessionManager) === owner &&
        owner.operation === operation &&
        owner.sessionId === ctx.sessionManager.getSessionId() &&
        ctx.model === model &&
        JSON.stringify(ctx.model) === modelKey &&
        JSON.stringify([pi.getActiveTools(), activeTools(pi)]) === toolsKey &&
        JSON.stringify(settingsRuntime.get().settings) === JSON.stringify(settings) &&
        ctx.getSystemPrompt() === systemPrompt &&
        branchIsCurrent(ctx.sessionManager.getBranch());
      let transferred = false;
      let statusCleared = false;
      ctx.ui.setStatus(STATUS_KEY, "Transferring checkpoint through its issuing provider…");
      try {
        if (settings.checkpointRecovery === "cancel") throw new Error("Checkpoint recovery is disabled");
        const marker = messages.find(
          (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === "text" && part.text === checkpointMarker(checkpoint.details.checkpointId),
            ),
        );
        if (!marker) throw new Error("The checkpoint marker is unavailable");
        const request = await abortable(
          checkpointIssuerRequest(ctx, checkpoint, [marker], settings, signal, stillCurrent, options.fetch),
          signal,
        );
        if (!stillCurrent()) return undefined;
        const result = await summarizeCheckpoint(request, {
          maxTokens: Math.min(request.model.maxTokens, settings.replacementTokenBudget),
        });
        if (!stillCurrent()) return undefined;
        summary = result.summary;
        pi.appendEntry(PLAINTEXT_CHECKPOINT_TYPE, {
          entryId: checkpoint.entry.id,
          checkpointId: checkpoint.details.checkpointId,
          summary,
        });
        if (!stillCurrent()) return undefined;
        if (ctx.hasUI)
          ctx.ui.notify(
            "Checkpoint transferred as a plaintext summary through its issuing provider. Encrypted state was not sent to the selected provider.",
            "info",
          );
        if (!stillCurrent()) return undefined;
        statusCleared = true;
        ctx.ui.setStatus(STATUS_KEY, undefined);
        if (!stillCurrent()) return undefined;
        transferred = true;
        return { messages: plaintextCheckpointMessages(messages, checkpoint, summary) };
      } catch {
        if (stillCurrent()) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "Checkpoint transfer could not complete; request stopped and history preserved. Switch back to the checkpoint's issuing provider and verify its authentication, or enable checkpoint summary recovery.",
              "warning",
            );
        }
        return undefined;
      } finally {
        if (
          !transferred &&
          owners.get(ctx.sessionManager) === owner &&
          owner.sessionId === ctx.sessionManager.getSessionId() &&
          (owner.operation === operation || owner.operation === undefined)
        )
          ctx.abort();
        if (owner.operation === operation) {
          owner.operation = undefined;
          if (!statusCleared) ctx.ui.setStatus(STATUS_KEY, undefined);
        }
        operation.abort();
      }
    });

    pi.on("before_provider_request", (event, ctx) => {
      // A normal request satisfies scheduling, but must still distinguish the
      // completed maintenance handoff from the actual task. Do not add a second
      // scheduler when Pi already retries or continues after a tool result.
      const run = owners.get(ctx.sessionManager)?.run;
      if (run?.pending?.entryId) {
        run.pending = undefined;
      }
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint) return undefined;
      const marker = checkpointMarker(checkpoint.details.checkpointId);
      if (!isCheckpointCompatible(checkpoint.details, ctx.model, settings)) {
        if (hasCheckpointMarker(event.payload, marker)) ctx.abort();
        return undefined;
      }
      if (!hasCheckpointMarker(event.payload, marker)) return undefined;
      return rewriteCheckpointForWork(event.payload, marker, checkpoint.details.replacementHistory);
    });

    const beforeNavigation = (_event: unknown, ctx: ExtensionContext) => {
      cancelOperation(ctx);
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
    };
    pi.on("session_before_switch", beforeNavigation);
    pi.on("session_before_fork", beforeNavigation);
    pi.on("session_before_tree", beforeNavigation);
    pi.on("thinking_level_select", beforeNavigation);

    pi.on("session_tree", (_event, ctx) => {
      cancelOperation(ctx);
      const owner = owners.get(ctx.sessionManager);
      if (owner) owner.run = undefined;
    });

    pi.on("model_select", (event, ctx) => {
      cancelOperation(ctx);
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
          "The active Responses checkpoint cannot replay directly on this provider/API. For a compatible API/profile, the next request transfers it through its issuing provider as a plaintext summary; otherwise only the fallback marker and recent messages remain available.",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      activeManagers.delete(ctx.sessionManager);
      if (activeManagers.size === 0) {
        removeDiscovery?.();
        removeDiscovery = undefined;
        source = undefined;
      }
      const owner = owners.get(ctx.sessionManager) ?? ownerFor(ctx);
      owner.controller.abort();
      owner.rejected = new RejectedRoutes();
      owner.operation = undefined;
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
