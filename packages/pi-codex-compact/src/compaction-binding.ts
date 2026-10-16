import { createHash } from "node:crypto";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type CompactionRoute,
  isChatGPTCompactionCandidate,
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

/** Resolve auth through the same public Pi APIs for preparation and adoption. */
export async function resolveCompactionBinding(
  ctx: ExtensionContext,
  model: Model<Api>,
  settings: CodexCompactSettings,
  isCurrent: () => boolean,
) {
  let route = resolveCompactionRoute(model, settings);
  if (route.kind !== "remote") throw new Error("The active Responses route is unavailable");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!isCurrent()) throw new DOMException("Compaction ownership changed", "AbortError");
  if (!auth.ok) throw new Error(auth.error);
  let providerAuth: Awaited<ReturnType<typeof ctx.modelRegistry.getProviderAuth>> | undefined;
  if (route.protocol !== "context-management" && isChatGPTCompactionCandidate(model, auth)) {
    providerAuth = await ctx.modelRegistry.getProviderAuth?.(model.provider);
    if (!isCurrent()) throw new DOMException("Compaction ownership changed", "AbortError");
    const authenticatedRoute = resolveAuthenticatedCompactionRoute(model, settings, auth, providerAuth);
    if (authenticatedRoute.kind === "remote") route = authenticatedRoute;
  }
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error("The active Responses provider is unavailable");
  const binding: CompactionBinding = {
    // Only this digest leaves the request scope; never persist authentication material.
    key: createHash("sha256")
      .update(JSON.stringify([model, route, auth, providerAuth]))
      .digest("hex"),
    provider,
    stream: provider.stream,
    streamSimple: provider.streamSimple,
  };
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
