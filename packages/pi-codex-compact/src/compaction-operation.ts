import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Tool } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { abortable } from "./abortable.js";
import {
  buildReplacementHistory,
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  hasActiveCheckpointClaim,
  latestCheckpoint,
  REPLACEMENT_BYTE_BUDGET,
} from "./checkpoint.js";
import { checkpointIssuerRequest } from "./checkpoint-portability.js";
import { projectedKeptMessages, projectSessionCheckpointContext } from "./checkpoint-projection.js";
import { recoverCheckpoint, summaryPrefix } from "./checkpoint-recovery.js";
import { type CompactionBinding, resolveCompactionBinding } from "./compaction-binding.js";
import {
  compactionFailureDetail,
  compactionFailureMessage,
  inspectFailureResponse,
  isOAuthOperationRejection,
  observeSseRejections,
  streamOperationRejection,
} from "./compaction-failure.js";
import { captureCompactionBranch } from "./compaction-ownership.js";
import { validateContextManagementHistory } from "./context-management.js";
import { type CompactionRoute, type RemoteCompactionProtocol, resolveCompactionRoute } from "./model-api.js";
import { preparationFailureDetail } from "./preparation-failure.js";
import { type RejectedRoutes, rejectionRouteKey } from "./rejection-state.js";
import { requestRemoteCompaction } from "./remote.js";
import { RequestDiagnostics } from "./request-diagnostics.js";
import type { CodexCompactSettings } from "./settings.js";

const STATUS_KEY = "codex-compact";

export interface CompactionAttempt {
  binding?: CompactionBinding;
  failure?: {
    diagnostic: string;
  };
}

export interface CompactionOperationOptions {
  preparation?: {
    attempt: CompactionAttempt;
    branchIsCurrent: (current: SessionBeforeCompactEvent["branchEntries"]) => boolean;
  };
  deadlineSignal?: AbortSignal;
}

function keptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  return projectedKeptMessages(event.branchEntries, leafId, event.preparation.firstKeptEntryId);
}

export function activeTools(pi: ExtensionAPI): Tool[] {
  const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  return pi.getActiveTools().flatMap((name) => {
    const tool = available.get(name);
    return tool
      ? [
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        ]
      : [];
  });
}

export function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  route: Extract<CompactionRoute, { kind: "remote" }>,
): { messages: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  const prior = latestCheckpoint(event.branchEntries);
  if (!prior) return { messages: session.messages };
  if (prior.details.api !== route.api || prior.details.profile !== route.profile) {
    throw new Error("The active opaque checkpoint belongs to an incompatible Responses API/profile");
  }
  const projected = projectSessionCheckpointContext(session.messages, event.branchEntries, prior);
  if (!projected) {
    throw new Error(
      "The saved transcript cannot verify the previous opaque checkpoint projection. History preserved; " +
        "use /tree to branch before that checkpoint and compact the saved transcript there. Opaque state cannot be decoded locally.",
    );
  }
  return { messages: projected, prior: prior.details };
}

function notifyFailure(
  ctx: ExtensionContext,
  error: unknown,
  settings: CodexCompactSettings,
  requestValues: readonly string[],
  checkpointPresent = false,
  routePaused = true,
  diagnostic = "",
): void {
  if (!ctx.hasUI || !settings.notifyOnFallback) return;
  const diagnosis = compactionFailureMessage(error, requestValues) + (diagnostic ? ` [${diagnostic}]` : "");
  const message = routePaused
    ? diagnosis
    : diagnosis.replace(
        "This route is paused for this session; /reload retries it. ",
        "This failure did not pause the route. ",
      );
  ctx.ui.notify(
    checkpointPresent
      ? message.replace(
          "Responses compaction failed; using Pi compaction. ",
          "Responses compaction failed; applying checkpoint recovery (summary or safe cancellation). ",
        )
      : message,
    "warning",
  );
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

export async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: CodexCompactSettings,
  ownerSignal: AbortSignal,
  rejected: RejectedRoutes,
  isCurrent: () => boolean,
  ownsStatus: () => boolean,
  onRouteResolved: (protocol: RemoteCompactionProtocol) => void,
  fetch?: typeof globalThis.fetch,
  options: CompactionOperationOptions = {},
) {
  const model = ctx.model;
  const configuredRoute = resolveCompactionRoute(model, settings);
  const signal = AbortSignal.any([event.signal, ownerSignal]);
  if (signal.aborted) return { cancel: true };
  if (configuredRoute.kind === "native" || !model)
    return settings.enabled && hasActiveCheckpointClaim(ctx.sessionManager.getBranch()) ? { cancel: true } : undefined;
  let route = configuredRoute;
  // Keep the preference identity stable; the dispatch identity uses resolved auth.
  const publicRouteKey = rejectionRouteKey(model, configuredRoute);
  let routeKey = publicRouteKey;
  let endpointObserved = false;
  let paused = false;
  const sessionId = ctx.sessionManager.getSessionId();
  const checkpoint = latestCheckpoint(event.branchEntries);
  const checkpointPresent = hasActiveCheckpointClaim(event.branchEntries);
  const branchIsCurrent = options.preparation?.branchIsCurrent ?? captureCompactionBranch(event.branchEntries);
  const systemPrompt = ctx.getSystemPrompt?.();
  const tools = JSON.stringify([pi.getActiveTools(), activeTools(pi)]);
  const stillCurrent = () =>
    sessionStillOwned(ctx, sessionId, signal) &&
    isCurrent() &&
    ctx.getSystemPrompt?.() === systemPrompt &&
    JSON.stringify([pi.getActiveTools(), activeTools(pi)]) === tools &&
    branchIsCurrent(ctx.sessionManager.getBranch());
  const operationStarted = performance.now();
  let outcome: "failed" | "prepared" | "ready" | "recovered" = "failed";
  let validationMs = 0;
  const diagnostics = new RequestDiagnostics();
  diagnostics.configure(settings.protocol);
  const markDeadline = () => {
    diagnostics.deadline = true;
  };
  options.deadlineSignal?.addEventListener("abort", markDeadline, { once: true });
  let requestValues: string[] = [settings.maintenanceMessage];
  let remoteAttempted = false;
  const diagnosticCleanups: (() => void)[] = [];
  let lastHttpStatus: number | undefined;
  let lastTransportFailure: string | undefined;
  let rejectionError: Error | undefined;
  const remoteController = new AbortController();
  const remoteSignal = AbortSignal.any([
    signal,
    remoteController.signal,
    ...(options.deadlineSignal ? [options.deadlineSignal] : []),
  ]);
  const recordRejection = (error: Error) => {
    if (!remoteAttempted || !stillCurrent() || rejectionError) return;
    rejectionError = error;
    rejected.add(routeKey);
    rejected.observe(publicRouteKey, routeKey);
    // Stream callbacks can run inside a TransformStream; abort after that callback
    // unwinds to avoid reentrant stream teardown. This controller owns only this task.
    queueMicrotask(() => remoteController.abort());
  };
  if (ownsStatus()) ctx.ui.setStatus(STATUS_KEY, "Preparing Responses compaction…");
  try {
    if (checkpointPresent && !checkpoint)
      throw new Error("The active opaque checkpoint is invalid or unsupported; history preserved");
    const resolved = await abortable(
      diagnostics.wait("binding", () => resolveCompactionBinding(ctx, model, settings, stillCurrent, diagnostics)),
      remoteSignal,
    );
    if (!stillCurrent()) return { cancel: true };
    const { auth, provider } = resolved;
    route = resolved.route;
    diagnostics.configure(settings.protocol, route.protocol, settings.appendMaintenanceMessage);
    if (options.preparation) options.preparation.attempt.binding = resolved.binding;
    requestValues = [
      settings.maintenanceMessage,
      auth.apiKey,
      ...Object.values(auth.headers ?? {}),
      ...Object.values(auth.env ?? {}),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    onRouteResolved(route.protocol);
    if (ownsStatus())
      ctx.ui.setStatus(
        STATUS_KEY,
        route.protocol === "context-management"
          ? "Responses Context Management (experimental)…"
          : route.protocol === "remote-v2"
            ? "Responses Remote V2…"
            : "Responses Compact API…",
      );
    const current = projectedCurrentMessages(event, route);
    if (checkpoint && current.prior && checkpoint.details.provider !== model.provider) {
      // Prepared handles only carry opaque checkpoints. Plaintext transfer belongs
      // to the foreground/context owner, never to an unusable speculative result.
      if (options.preparation || settings.checkpointRecovery === "cancel") return { cancel: true };
      if (ownsStatus()) ctx.ui.setStatus(STATUS_KEY, "Transferring checkpoint through its issuing provider…");
      const messages = summaryPrefix(current.messages, keptMessages(event), fingerprintMessage);
      const request = await abortable(
        checkpointIssuerRequest(ctx, checkpoint, messages, settings, remoteSignal, stillCurrent, fetch),
        remoteSignal,
      );
      if (!stillCurrent()) return { cancel: true };
      const compaction = await abortable(recoverCheckpoint(request, event), remoteSignal).catch(() => {
        throw new Error("Checkpoint transfer through its issuing provider failed; history preserved");
      });
      if (!stillCurrent()) return { cancel: true };
      return { compaction };
    }
    const preparationStarted = performance.now();
    const context: Context = {
      systemPrompt: ctx.getSystemPrompt(),
      // Prepared operations borrow raw ancestry under persisted-value guards. Keep
      // provider-owned input isolated from later live-entry mutations, but copy
      // only the projected messages, not historical payloads already compacted out.
      messages: convertToLlm(
        options.preparation ? (JSON.parse(JSON.stringify(current.messages)) as AgentMessage[]) : current.messages,
      ),
      tools: activeTools(pi),
    };
    diagnostics.record("preparation", preparationStarted);
    diagnostics.phase = "request";
    const response = await abortable(
      requestRemoteCompaction({
        diagnostics,
        provider,
        model,
        context,
        protocol: route.protocol,
        profile: route.profile,
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: remoteSignal,
        priorCheckpoint: current.prior
          ? {
              marker: checkpointMarker(current.prior.checkpointId),
              replacementHistory: current.prior.replacementHistory,
            }
          : undefined,
        appendMaintenanceMessage: settings.appendMaintenanceMessage,
        maintenanceMessage: settings.maintenanceMessage,
        requestTimeoutMs: settings.requestTimeoutMs,
        maxRetries: settings.maxRetries,
        onProviderStreamEvent: (raw) => {
          if (route.protocol !== "context-management") diagnostics.observe(raw);
          const error = streamOperationRejection(raw);
          if (error) recordRejection(error);
        },
        fetch: async (input, init) => {
          if (remoteSignal.aborted) throw remoteSignal.reason;
          if (!stillCurrent()) throw new Error("Compaction ownership changed before dispatch");
          const endpoint = input instanceof Request ? input.url : String(input);
          routeKey = rejectionRouteKey(model, route, endpoint);
          endpointObserved = true;
          rejected.observe(publicRouteKey, routeKey);
          paused = rejected.has(routeKey);
          if (paused) {
            // Cancel only the remote subrequest, including adapter-owned retries.
            // Keep the parent compaction signal available for checkpoint recovery.
            remoteController.abort();
            return Response.json(
              { error: { message: "Remote compaction route is paused after an OAuth operation rejection" } },
              { status: 409, headers: { "x-should-retry": "false" } },
            );
          }
          remoteAttempted = true;
          lastHttpStatus = undefined;
          lastTransportFailure = undefined;
          const diagnosticAttempt =
            route.protocol === "context-management" ? diagnostics.currentAttempt : diagnostics.beginAttempt();
          if (route.protocol !== "context-management") {
            const providerSignals = [
              ...(init?.signal ? [init.signal] : []),
              ...(input instanceof Request ? [input.signal] : []),
            ];
            const providerSignal = providerSignals.length ? AbortSignal.any(providerSignals) : undefined;
            const markProviderAbort = () => diagnostics.providerAborted(diagnosticAttempt);
            if (providerSignal?.aborted) markProviderAbort();
            providerSignal?.addEventListener("abort", markProviderAbort, { once: true });
            diagnosticCleanups.push(() => providerSignal?.removeEventListener("abort", markProviderAbort));
          }
          const response = await (fetch ?? globalThis.fetch)(input, {
            ...init,
            signal: AbortSignal.any([
              remoteSignal,
              ...(init?.signal ? [init.signal] : []),
              ...(input instanceof Request ? [input.signal] : []),
            ]),
          }).catch((error: unknown) => {
            const detail = preparationFailureDetail(error, { remoteAttempted: true });
            lastTransportFailure =
              detail.startsWith("network request failed") ||
              detail === "checkpoint request timed out" ||
              detail === "provider or transport aborted the checkpoint request"
                ? detail
                : "network request failed";
            throw error;
          });
          diagnostics.headers(response, diagnosticAttempt);
          lastHttpStatus = response.ok ? undefined : response.status;
          if (remoteSignal.aborted || !stillCurrent()) {
            void response.body?.cancel().catch(() => undefined);
            throw new Error("Compaction ownership changed after response");
          }
          const signals = [
            remoteSignal,
            ...(init?.signal ? [init.signal] : []),
            ...(input instanceof Request ? [input.signal] : []),
          ];
          const requestSignal = AbortSignal.any(signals);
          let observed = response;
          if (route.protocol !== "context-management" && observed.body) {
            const transform = new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, destination) {
                diagnostics.chunk(chunk.byteLength, diagnosticAttempt);
                destination.enqueue(chunk);
              },
              flush() {
                diagnostics.end(diagnosticAttempt);
              },
            });
            void observed.body.pipeTo(transform.writable, { signal: requestSignal }).catch(() => {
              diagnostics.pipeError(diagnosticAttempt, requestSignal.aborted);
            });
            observed = new Response(transform.readable, {
              status: observed.status,
              statusText: observed.statusText,
              headers: observed.headers,
            });
          }
          const failure = await inspectFailureResponse(observed, requestSignal);
          if (!stillCurrent()) {
            void failure.response.body?.cancel().catch(() => undefined);
            throw new Error("Compaction ownership changed during error inspection");
          }
          if (failure.rejection) recordRejection(failure.rejection);
          return route.protocol === "responses-compact"
            ? failure.response
            : observeSseRejections(failure.response, requestSignal, recordRejection);
        },
      }),
      remoteSignal,
    );
    diagnostics.seal();
    if (!stillCurrent()) return { cancel: true };
    const validationStarted = performance.now();
    let replacementHistory: ReturnType<typeof buildReplacementHistory>;
    try {
      replacementHistory =
        route.protocol === "context-management"
          ? validateContextManagementHistory(response.replacementHistory ?? [], {
              byteBudget: REPLACEMENT_BYTE_BUDGET,
              tokenBudget: settings.replacementTokenBudget,
            })
          : buildReplacementHistory(response.compactedOutput?.slice(0, -1) ?? response.promptInput, response.item, {
              tokenBudget: settings.replacementTokenBudget,
            });
    } finally {
      validationMs = performance.now() - validationStarted;
    }
    const details = createCheckpointDetails({
      provider: model.provider,
      api: route.api,
      profile: route.profile,
      modelId: model.id,
      protocol: route.protocol,
      replacementHistory,
      keptMessages: keptMessages(event),
    });
    outcome = options.preparation ? "prepared" : "ready";
    return {
      compaction: {
        summary: fallbackSummary(details.checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
        details,
      },
    };
  } catch (error) {
    diagnostics.callerAbort ||= event.signal.aborted;
    diagnostics.seal();
    if (!stillCurrent()) return { cancel: true };
    if (remoteAttempted && isOAuthOperationRejection(error))
      recordRejection(error instanceof Error ? error : new Error(String(error)));
    if (options.preparation) {
      const detail = options.deadlineSignal?.aborted
        ? "checkpoint request timed out"
        : (lastTransportFailure ??
          preparationFailureDetail(rejectionError ?? error, {
            httpStatus: lastHttpStatus,
            remoteAttempted,
          }));
      options.preparation.attempt.failure = {
        diagnostic:
          route.protocol === "context-management"
            ? `${detail.split(" (no safe error details available)")[0]} [${diagnostics.compact()}]`
            : detail,
      };
      return undefined;
    }
    if (!paused || remoteAttempted)
      notifyFailure(
        ctx,
        rejectionError ?? error,
        settings,
        requestValues,
        checkpointPresent,
        rejected.has(routeKey),
        route.protocol === "context-management" ? diagnostics.summary() : "",
      );
    if (!checkpointPresent) return undefined;
    if (!checkpoint) return { cancel: true };
    if (checkpoint.details.provider !== model.provider) return { cancel: true };
    if (settings.checkpointRecovery === "cancel") return { cancel: true };
    let nativeFallbackAllowed = false;
    const recoveryDiagnostics = new RequestDiagnostics();
    recoveryDiagnostics.configure(settings.protocol, route.protocol, false, "recovery");
    let recoveryOutcome: "failed" | "ready" = "failed";
    try {
      const current = projectedCurrentMessages(event, route);
      if (!current.prior) throw new Error("Checkpoint recovery lost its checkpoint");
      const messages = summaryPrefix(current.messages, keptMessages(event), fingerprintMessage);
      // Native fallback is intentionally lossy, but never bypass projection or ownership checks.
      nativeFallbackAllowed = true;
      const auth = await recoveryDiagnostics.wait("authWait", () => ctx.modelRegistry.getApiKeyAndHeaders(model));
      if (!stillCurrent()) return { cancel: true };
      if (!auth.ok) throw new Error(auth.error);
      requestValues = [
        ...requestValues,
        auth.apiKey,
        ...Object.values(auth.headers ?? {}),
        ...Object.values(auth.env ?? {}),
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) throw new Error("The active Responses provider is unavailable");
      if (ownsStatus()) ctx.ui.setStatus(STATUS_KEY, "Checkpoint recovery summary…");
      const compaction = await recoverCheckpoint(
        {
          diagnostics: recoveryDiagnostics,
          provider,
          model,
          context: { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages), tools: [] },
          profile: route.profile,
          protocol: route.protocol,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          signal,
          priorCheckpoint: {
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          },
          requestTimeoutMs: settings.requestTimeoutMs,
          maxRetries: settings.maxRetries,
          fetch: async (input, init) => {
            if (!stillCurrent()) throw new Error("Checkpoint recovery ownership changed before dispatch");
            const endpoint = new URL(input instanceof Request ? input.url : String(input));
            // Unary compaction derives /responses/compact from the provider's
            // inference endpoint. Compare that exact public dispatch identity.
            if (route.protocol === "responses-compact") endpoint.pathname += "/compact";
            if (endpointObserved && rejectionRouteKey(model, route, endpoint.toString()) !== routeKey) {
              nativeFallbackAllowed = false;
              return Response.json(
                { error: { message: "Checkpoint recovery backend changed before dispatch" } },
                { status: 400, headers: { "x-should-retry": "false" } },
              );
            }
            const diagnosticAttempt = recoveryDiagnostics.currentAttempt;
            const response = await (fetch ?? globalThis.fetch)(input, init);
            recoveryDiagnostics.headers(response, diagnosticAttempt);
            return response;
          },
        },
        event,
      );
      if (!stillCurrent()) return { cancel: true };
      recoveryOutcome = "ready";
      outcome = "recovered";
      return { compaction };
    } catch (recoveryError) {
      if (!stillCurrent()) return { cancel: true };
      if (ctx.hasUI && settings.notifyOnFallback) {
        const outcome = nativeFallbackAllowed
          ? "using Pi native compaction. Older context stored only in the opaque checkpoint may be lost."
          : "compaction cancelled and history preserved.";
        ctx.ui.notify(
          `Checkpoint recovery could not complete; ${outcome} ${compactionFailureDetail(recoveryError, requestValues)} [${recoveryDiagnostics.summary()}]`,
          "warning",
        );
      }
      return nativeFallbackAllowed ? undefined : { cancel: true };
    } finally {
      if (ctx.hasUI && stillCurrent()) {
        recoveryDiagnostics.seal();
        ctx.ui.notify(`[codex-compact] Recovery outcome=${recoveryOutcome}; ${recoveryDiagnostics.summary()}`, "info");
      }
    }
  } finally {
    if (remoteAttempted && ctx.hasUI && stillCurrent()) {
      diagnostics.callerAbort ||= event.signal.aborted;
      diagnostics.seal();
      ctx.ui.notify(
        `[codex-compact] Compaction outcome=${outcome}; operationMs=${Math.floor(performance.now() - operationStarted)} validationMs=${Math.floor(validationMs)}; ${diagnostics.summary()}`,
        "info",
      );
    }
    for (const cleanup of diagnosticCleanups) cleanup();
    options.deadlineSignal?.removeEventListener("abort", markDeadline);
    remoteController.abort();
    if (!ownerSignal.aborted && ctx.sessionManager.getSessionId() === sessionId && ownsStatus()) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }
}
