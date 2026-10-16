import type { Api, AuthResult, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { CodexCompactSettings } from "./settings.js";

export const RESPONSES_COMPACTION_APIS = [
  "openai-codex-responses",
  "openai-responses",
  "azure-openai-responses",
] as const;

export type BuiltInResponsesCompactionApi = (typeof RESPONSES_COMPACTION_APIS)[number];
export type ResponsesCompactionApi = BuiltInResponsesCompactionApi;
export type ResponsesCompactionProfile = "codex-responses-v1" | "openai-responses-v1";
export type RemoteCompactionProtocol = "remote-v2" | "responses-compact" | "context-management";
export type RemoteCompactionProtocolSetting = "auto" | RemoteCompactionProtocol;

export type CompactionRoute =
  | { kind: "remote"; protocol: RemoteCompactionProtocol; api: Api; profile: ResponsesCompactionProfile }
  | { kind: "native"; reason: string };

export type CompactionRouteOptions = Pick<CodexCompactSettings, "enabled" | "protocol"> & {
  apiProfiles?: Readonly<Record<string, "codex-responses-v1">>;
};

export interface CompactionRequestAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
}

function resolveResponsesCompactionProfile(
  api: Api | undefined,
  apiProfiles: Readonly<Record<string, "codex-responses-v1">> = {},
): ResponsesCompactionProfile | undefined {
  if (api === "openai-codex-responses") return "codex-responses-v1";
  if (api === "openai-responses" || api === "azure-openai-responses") return "openai-responses-v1";
  return api && Object.hasOwn(apiProfiles, api) && apiProfiles[api] === "codex-responses-v1"
    ? "codex-responses-v1"
    : undefined;
}

export function resolveCompactionRouteForApi(api: Api | undefined, options: CompactionRouteOptions): CompactionRoute {
  if (!options.enabled) return { kind: "native", reason: "remote compaction is disabled" };
  if (!api) return { kind: "native", reason: "no active model" };
  const profile = resolveResponsesCompactionProfile(api, options.apiProfiles);
  if (!profile) {
    return { kind: "native", reason: `API ${api} does not support Responses compaction` };
  }
  const protocol =
    options.protocol === "auto"
      ? profile === "codex-responses-v1"
        ? "remote-v2"
        : "responses-compact"
      : options.protocol;
  return { kind: "remote", protocol, api, profile };
}

export function resolveCompactionRoute(
  model: Model<Api> | undefined,
  options: CompactionRouteOptions,
): CompactionRoute {
  return resolveCompactionRouteForApi(model?.api, options);
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  return baseUrl === "https://api.openai.com/v1" || baseUrl === "https://api.openai.com/v1/";
}

function hasAuthorizationOverride(headers: ProviderHeaders | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => {
    const lower = name.toLowerCase();
    return lower === "authorization" || lower === "cf-aig-authorization";
  });
}

export function isChatGPTCompactionCandidate(
  model: Model<Api> | undefined,
  requestAuth: CompactionRequestAuth,
): boolean {
  return (
    model?.provider === "openai" &&
    model.api === "openai-responses" &&
    isOfficialOpenAIBaseUrl(model.baseUrl) &&
    (requestAuth.baseUrl === undefined || isOfficialOpenAIBaseUrl(requestAuth.baseUrl)) &&
    typeof requestAuth.apiKey === "string" &&
    requestAuth.apiKey.trim().length > 0 &&
    !hasAuthorizationOverride(model.headers) &&
    !hasAuthorizationOverride(requestAuth.headers)
  );
}

export function resolveAuthenticatedCompactionRoute(
  model: Model<Api> | undefined,
  options: CompactionRouteOptions,
  requestAuth: CompactionRequestAuth,
  providerAuth: AuthResult | undefined,
): CompactionRoute {
  const route = resolveCompactionRoute(model, options);
  // Pi's request-auth facade omits provenance. Match a fresh public auth resolution
  // without interpreting token contents or relying on a cached OAuth status.
  if (
    route.kind === "remote" &&
    isChatGPTCompactionCandidate(model, requestAuth) &&
    providerAuth?.source === "OAuth" &&
    providerAuth.auth.apiKey === requestAuth.apiKey
  ) {
    return { ...route, protocol: "context-management" };
  }
  return route;
}
