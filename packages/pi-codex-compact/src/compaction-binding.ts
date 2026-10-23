import { createHash } from "node:crypto";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionTimings } from "./compaction-timing.js";
import {
  type CompactionRoute,
  isChatGPTCompactionCandidate,
  isVerifiedChatGPTOAuth,
  resolveAuthenticatedCompactionRoute,
  resolveCompactionRoute,
} from "./model-api.js";
import type { CodexCompactSettings } from "./settings.js";

export interface CompactionBinding {
  key: string;
  provider: Provider;
  stream: Provider["stream"];
  streamSimple: Provider["streamSimple"];
}

const componentLabels = [
  "model changed",
  "route changed",
  "request authentication changed",
  "provider authentication changed",
] as const;
// Request-scoped diagnostics only: never attach these digests to enumerable state,
// checkpoint details, notifications, or debug output. Weak keys follow job lifetime.
const componentDigests = new WeakMap<CompactionBinding, string[]>();
const digest = (serialized: string) => createHash("sha256").update(serialized).digest("hex");

/** Resolve auth through the same public Pi APIs for preparation and adoption. */
export async function resolveCompactionBinding(
  ctx: ExtensionContext,
  model: Model<Api>,
  settings: CodexCompactSettings,
  isCurrent: () => boolean,
  timings?: CompactionTimings,
) {
  let route = resolveCompactionRoute(model, settings);
  if (route.kind !== "remote") throw new Error("The active Responses route is unavailable");
  const pendingAuth = () => ctx.modelRegistry.getApiKeyAndHeaders(model);
  const auth = await (timings ? timings.wait("authWait", pendingAuth) : pendingAuth());
  if (!isCurrent()) throw new DOMException("Compaction ownership changed", "AbortError");
  if (!auth.ok) throw new Error(auth.error);
  let providerAuth: Awaited<ReturnType<typeof ctx.modelRegistry.getProviderAuth>> | undefined;
  if (isChatGPTCompactionCandidate(model, auth)) {
    const pendingProviderAuth = () => Promise.resolve(ctx.modelRegistry.getProviderAuth?.(model.provider));
    providerAuth = await (timings ? timings.wait("authWait", pendingProviderAuth) : pendingProviderAuth());
    if (!isCurrent()) throw new DOMException("Compaction ownership changed", "AbortError");
    const authenticatedRoute = resolveAuthenticatedCompactionRoute(model, settings, auth, providerAuth);
    if (authenticatedRoute.kind === "remote") route = authenticatedRoute;
  }
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error("The active Responses provider is unavailable");
  const exact = JSON.stringify([model, route, auth, providerAuth]);
  const components = JSON.parse(exact);
  // Single-login policy: ordinary OAuth refresh must not discard prepared work.
  // Preserve every non-token field and keep custom serialization/mismatched auth strict.
  // Pi exposes no stable login identity, so cancel preparation before switching accounts.
  if (
    isVerifiedChatGPTOAuth(model, auth, providerAuth) &&
    components[2]?.apiKey === auth.apiKey &&
    components[3]?.auth?.apiKey === auth.apiKey
  ) {
    delete components[2].apiKey;
    delete components[3].auth.apiKey;
  }
  const serialized = JSON.stringify(components);
  const binding: CompactionBinding = {
    // Keep only the guard digest; never persist authentication material.
    key: digest(serialized),
    provider,
    stream: provider.stream,
    streamSimple: provider.streamSimple,
  };
  // Diagnose the same normalized components without another auth resolution or
  // invocation of provider/model serialization hooks.
  componentDigests.set(
    binding,
    (JSON.parse(serialized) as unknown[]).map((value) => digest(JSON.stringify(value))),
  );
  return { auth, route: route as Extract<CompactionRoute, { kind: "remote" }>, provider, binding };
}

export function sameCompactionBinding(left: CompactionBinding | undefined, right: CompactionBinding): boolean {
  return (
    !!left &&
    left.key === right.key &&
    left.provider === right.provider &&
    left.stream === right.stream &&
    left.streamSimple === right.streamSimple
  );
}

/** Explain a rejection using fixed labels only; never change the acceptance guard. */
export function compactionBindingChanges(left: CompactionBinding | undefined, right: CompactionBinding): string[] {
  if (!left) return ["prepared binding unavailable"];
  if (sameCompactionBinding(left, right)) return [];
  const changes: string[] = [];
  if (left.key !== right.key) {
    const before = componentDigests.get(left);
    const after = componentDigests.get(right);
    if (before && after)
      for (const [index, label] of componentLabels.entries()) if (before[index] !== after[index]) changes.push(label);
    // Preserve an explanation for legacy/test bindings without component data.
    if (changes.length === 0) changes.push("binding changed");
  }
  if (left.provider !== right.provider) changes.push("provider instance changed");
  if (left.stream !== right.stream) changes.push("stream function changed");
  if (left.streamSimple !== right.streamSimple) changes.push("streamSimple function changed");
  return changes;
}
