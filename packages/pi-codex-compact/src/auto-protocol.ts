import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type CompactionBinding, sameCompactionBinding } from "./compaction-binding.js";
import { type CompactionRequestAuth, isOfficialOpenAIBaseUrl } from "./model-api.js";

/** Auto negotiation is limited to third-party endpoints using the built-in Responses adapter. */
export function isAutomaticProxyCompaction(model: Model<Api>, auth: CompactionRequestAuth): boolean {
  return model.api === "openai-responses" && !isOfficialOpenAIBaseUrl(auth.baseUrl ?? model.baseUrl);
}

export function isCompactEndpointRejection(status: number | undefined): boolean {
  return status === 403 || status === 404 || status === 405 || status === 501;
}

/** Exact dispatch identity without retaining URL credentials or query values. */
export function compactionEndpointKey(endpoint: string): string {
  return createHash("sha256").update(new URL(endpoint).href).digest("hex");
}

export function contextManagementEndpointKey(compactEndpoint: string): string | undefined {
  const url = new URL(compactEndpoint);
  if (!url.pathname.endsWith("/responses/compact") || url.hostname === "api.openai.com") return undefined;
  url.pathname = url.pathname.slice(0, -"/compact".length);
  return compactionEndpointKey(url.href);
}

/** Successful compatibility observations only; session-owned, bounded, and never persisted. */
export class AutoCompactionProtocols {
  private readonly bindings = new Map<string, { binding: CompactionBinding; endpointKey: string }>();

  contextManagementEndpoint(binding: CompactionBinding): string | undefined {
    const remembered = this.bindings.get(binding.key);
    return remembered && sameCompactionBinding(remembered.binding, binding) ? remembered.endpointKey : undefined;
  }

  rememberContextManagement(binding: CompactionBinding, endpointKey: string): void {
    if (this.bindings.has(binding.key) || this.bindings.size < 128)
      this.bindings.set(binding.key, { binding, endpointKey });
  }

  forget(binding: CompactionBinding): void {
    this.bindings.delete(binding.key);
  }
}
