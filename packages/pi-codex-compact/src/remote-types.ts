import type { Api, Context, Model, Provider, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import type { RemoteCompactionProtocol, ResponsesCompactionProfile } from "./model-api.js";
import type { JsonObject } from "./protocol.js";
import type { RequestDiagnostics } from "./request-diagnostics.js";

export interface PriorCheckpointPayload {
  marker: string;
  replacementHistory: readonly unknown[];
}

export interface RemoteCompactionRequest {
  provider: Provider;
  model: Model<Api>;
  profile: ResponsesCompactionProfile;
  context: Context;
  protocol: RemoteCompactionProtocol;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  signal: AbortSignal;
  priorCheckpoint?: PriorCheckpointPayload;
  appendMaintenanceMessage?: boolean;
  maintenanceMessage?: string;
  scratchpadSnapshot?: string;
  /** Set only after valid nonempty notes exceed the complete projection budget. */
  scratchpadOmittedForSize?: boolean;
  requestTimeoutMs?: number;
  maxRetries?: number;
  /** Revalidate captured ownership and route before replaying a truncated stream. */
  beforeStreamRetry?: () => Promise<Pick<RemoteCompactionRequest, "apiKey" | "headers" | "env"> | undefined>;
  fetch?: typeof globalThis.fetch;
  diagnostics?: RequestDiagnostics;
  onProviderStreamEvent?: (event: unknown) => void;
}

export interface RemoteCompactionResponse {
  item: JsonObject;
  promptInput: JsonObject[];
  compactedOutput?: JsonObject[];
  replacementHistory?: JsonObject[];
  usage: Usage;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function abortError(): DOMException {
  return new DOMException("Compaction aborted", "AbortError");
}

export function assertPreparedInput(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.input) || !payload.input.every(isJsonObject)) {
    throw new Error("Prepared compaction payload has invalid input items");
  }
  return structuredClone(payload.input);
}
