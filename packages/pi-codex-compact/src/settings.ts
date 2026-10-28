import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { COMPACTION_MAINTENANCE_MESSAGE } from "./context-management.js";
import type { RemoteCompactionProtocolSetting } from "./model-api.js";

export const CODEX_COMPACT_SETTINGS_FILE = "pi-codex-compact.json";
export const MAX_SETTINGS_BYTES = 64 * 1024;
export const MAX_MAINTENANCE_MESSAGE_BYTES = 16 * 1024;

export type ProviderCompactionSettings = Partial<Pick<CodexCompactSettings, "compactionMode" | "protocol">>;
export const MAX_PROVIDER_OVERRIDES = 128;

export interface CodexCompactSettings {
  enabled: boolean;
  compactionMode: "provider-checkpoint" | "text-summary";
  scratchpadEnabled: boolean;
  appendMaintenanceMessage: boolean;
  maintenanceMessage: string;
  protocol: RemoteCompactionProtocolSetting;
  apiProfiles: Record<string, "codex-responses-v1">;
  providerOverrides: Record<string, ProviderCompactionSettings>;
  requestTimeoutMs: number;
  maxRetries: number;
  replacementTokenBudget: number;
  notifyOnFallback: boolean;
  checkpointRecovery: "summarize" | "cancel";
}

/** Stable key for provider-relevant compaction settings. */
export function compactionSettingsKey(settings: CodexCompactSettings): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(DEFAULT_CODEX_COMPACT_SETTINGS)
        .filter((key) => key !== "providerOverrides")
        .map((key) => [key, settings[key as keyof CodexCompactSettings]]),
    ),
  );
}

export const DEFAULT_CODEX_COMPACT_SETTINGS: Readonly<CodexCompactSettings> = Object.freeze({
  enabled: true,
  compactionMode: "provider-checkpoint",
  scratchpadEnabled: false,
  appendMaintenanceMessage: true,
  maintenanceMessage: COMPACTION_MAINTENANCE_MESSAGE,
  protocol: "auto",
  apiProfiles: {},
  providerOverrides: {},
  requestTimeoutMs: 300_000,
  maxRetries: 2,
  replacementTokenBudget: 64_000,
  notifyOnFallback: true,
  checkpointRecovery: "summarize",
});

const LIMITS = Object.freeze({
  requestTimeoutMs: { minimum: 30_000, maximum: 1_800_000 },
  maxRetries: { minimum: 0, maximum: 2 },
  replacementTokenBudget: { minimum: 8_000, maximum: 128_000 },
});

const BUILT_IN_APIS = new Set([
  "openai-completions",
  "mistral-conversations",
  "openai-codex-responses",
  "openai-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
]);
const MAX_API_PROFILE_ID_LENGTH = 256;

export interface CodexCompactSettingsState {
  kind: "missing" | "loaded" | "invalid";
  path: string;
  settings: CodexCompactSettings;
  document?: Record<string, unknown>;
  issue?: string;
}

export interface CodexCompactSettingsRuntime {
  get(): Readonly<CodexCompactSettingsState>;
  reload(signal?: AbortSignal): Promise<Readonly<CodexCompactSettingsState>>;
  /** A provider target permits only mode/protocol patches; an empty patch resets those overrides. */
  update(
    patch: Partial<CodexCompactSettings>,
    signal?: AbortSignal,
    provider?: string,
  ): Promise<Readonly<CodexCompactSettingsState>>;
  flush(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f;
  });
}

function normalizeApiProfiles(value: unknown): Record<string, "codex-responses-v1"> | undefined {
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return undefined;
  }
  const profiles: Record<string, "codex-responses-v1"> = {};
  for (const [api, profile] of Object.entries(value)) {
    if (
      api.length === 0 ||
      api.length > MAX_API_PROFILE_ID_LENGTH ||
      api.trim() !== api ||
      hasWhitespaceOrControl(api) ||
      BUILT_IN_APIS.has(api) ||
      api === "__proto__" ||
      api === "constructor" ||
      api === "prototype" ||
      profile !== "codex-responses-v1"
    ) {
      return undefined;
    }
    profiles[api] = profile;
  }
  return profiles;
}

/** Resolve only the active provider. Unrelated provider preferences never affect request fingerprints. */
export function effectiveCodexCompactSettings(settings: CodexCompactSettings, provider?: string): CodexCompactSettings {
  const overrides = settings.providerOverrides;
  const override = provider && Object.hasOwn(overrides, provider) ? overrides[provider] : undefined;
  return { ...settings, ...override };
}

function validProviderId(provider: string): boolean {
  return (
    provider.length > 0 &&
    provider.length <= 256 &&
    provider.trim() === provider &&
    ![...provider].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    }) &&
    !["__proto__", "constructor", "prototype"].includes(provider)
  );
}

function normalizeProviderOverrides(value: unknown): Record<string, ProviderCompactionSettings> | undefined {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_PROVIDER_OVERRIDES) return undefined;
  const result: Record<string, ProviderCompactionSettings> = {};
  for (const [provider, override] of entries) {
    if (
      !validProviderId(provider) ||
      !isRecord(override) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(override))
    )
      return undefined;
    if (
      Object.hasOwn(override, "compactionMode") &&
      override.compactionMode !== "provider-checkpoint" &&
      override.compactionMode !== "text-summary"
    )
      return undefined;
    if (
      Object.hasOwn(override, "protocol") &&
      !["auto", "remote-v2", "responses-compact", "context-management"].includes(override.protocol as string)
    )
      return undefined;
    result[provider] = {
      ...(Object.hasOwn(override, "compactionMode")
        ? { compactionMode: override.compactionMode as CodexCompactSettings["compactionMode"] }
        : {}),
      ...(Object.hasOwn(override, "protocol")
        ? { protocol: override.protocol as CodexCompactSettings["protocol"] }
        : {}),
    };
  }
  return result;
}

export function normalizeCodexCompactSettings(value: unknown): CodexCompactSettings | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.hasOwn(value, "scratchpadEnabled") && typeof value.scratchpadEnabled !== "boolean") return undefined;
  if (Object.hasOwn(value, "appendMaintenanceMessage") && typeof value.appendMaintenanceMessage !== "boolean")
    return undefined;
  if (
    Object.hasOwn(value, "maintenanceMessage") &&
    (typeof value.maintenanceMessage !== "string" ||
      value.maintenanceMessage.trim().length === 0 ||
      Buffer.byteLength(value.maintenanceMessage, "utf8") > MAX_MAINTENANCE_MESSAGE_BYTES)
  )
    return undefined;
  if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") return undefined;
  if (
    Object.hasOwn(value, "compactionMode") &&
    value.compactionMode !== "provider-checkpoint" &&
    value.compactionMode !== "text-summary"
  )
    return undefined;
  if (
    Object.hasOwn(value, "protocol") &&
    value.protocol !== "auto" &&
    value.protocol !== "remote-v2" &&
    value.protocol !== "responses-compact" &&
    value.protocol !== "context-management"
  ) {
    return undefined;
  }
  if (
    Object.hasOwn(value, "checkpointRecovery") &&
    value.checkpointRecovery !== "summarize" &&
    value.checkpointRecovery !== "cancel"
  )
    return undefined;
  if (Object.hasOwn(value, "notifyOnFallback") && typeof value.notifyOnFallback !== "boolean") {
    return undefined;
  }
  if (Object.hasOwn(value, "providerOverrides") && normalizeProviderOverrides(value.providerOverrides) === undefined)
    return undefined;
  if (Object.hasOwn(value, "apiProfiles") && normalizeApiProfiles(value.apiProfiles) === undefined) return undefined;
  for (const [field, limits] of Object.entries(LIMITS) as [
    keyof typeof LIMITS,
    { minimum: number; maximum: number },
  ][]) {
    if (Object.hasOwn(value, field) && !validInteger(value[field], limits.minimum, limits.maximum)) {
      return undefined;
    }
  }
  return {
    scratchpadEnabled: typeof value.scratchpadEnabled === "boolean" ? value.scratchpadEnabled : false,
    appendMaintenanceMessage:
      typeof value.appendMaintenanceMessage === "boolean"
        ? value.appendMaintenanceMessage
        : DEFAULT_CODEX_COMPACT_SETTINGS.appendMaintenanceMessage,
    maintenanceMessage:
      typeof value.maintenanceMessage === "string"
        ? value.maintenanceMessage
        : DEFAULT_CODEX_COMPACT_SETTINGS.maintenanceMessage,
    checkpointRecovery: value.checkpointRecovery === "cancel" ? "cancel" : "summarize",
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_CODEX_COMPACT_SETTINGS.enabled,
    compactionMode: value.compactionMode === "text-summary" ? "text-summary" : "provider-checkpoint",
    protocol:
      value.protocol === "remote-v2" ||
      value.protocol === "responses-compact" ||
      value.protocol === "context-management"
        ? value.protocol
        : DEFAULT_CODEX_COMPACT_SETTINGS.protocol,
    providerOverrides: normalizeProviderOverrides(value.providerOverrides) ?? {},
    apiProfiles: normalizeApiProfiles(value.apiProfiles) ?? structuredClone(DEFAULT_CODEX_COMPACT_SETTINGS.apiProfiles),
    requestTimeoutMs:
      typeof value.requestTimeoutMs === "number"
        ? value.requestTimeoutMs
        : DEFAULT_CODEX_COMPACT_SETTINGS.requestTimeoutMs,
    maxRetries: typeof value.maxRetries === "number" ? value.maxRetries : DEFAULT_CODEX_COMPACT_SETTINGS.maxRetries,
    replacementTokenBudget:
      typeof value.replacementTokenBudget === "number"
        ? value.replacementTokenBudget
        : DEFAULT_CODEX_COMPACT_SETTINGS.replacementTokenBudget,
    notifyOnFallback:
      typeof value.notifyOnFallback === "boolean"
        ? value.notifyOnFallback
        : DEFAULT_CODEX_COMPACT_SETTINGS.notifyOnFallback,
  };
}

export function codexCompactSettingsPath(): string {
  return join(getAgentDir(), CODEX_COMPACT_SETTINGS_FILE);
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Settings operation aborted", "AbortError");
}

export async function loadCodexCompactSettings(
  path = codexCompactSettingsPath(),
  signal?: AbortSignal,
): Promise<CodexCompactSettingsState> {
  aborted(signal);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const stats = await handle.stat();
      aborted(signal);
      if (!stats.isFile()) throw new Error("settings path is not a regular file");
      if (stats.size > MAX_SETTINGS_BYTES) throw new Error("settings file exceeds 64 KiB");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    aborted(signal);
    const document = JSON.parse(text) as unknown;
    const settings = normalizeCodexCompactSettings(document);
    if (!settings || !isRecord(document)) throw new Error("invalid settings shape or bounds");
    return { kind: "loaded", path, settings, document };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        kind: "missing",
        path,
        settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
        document: {},
      };
    }
    return {
      kind: "invalid",
      path,
      settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
      issue:
        isNodeError(error) && error.code === "ELOOP"
          ? "symbolic links are not accepted"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

async function savePatch(
  path: string,
  patch: Partial<CodexCompactSettings>,
  signal?: AbortSignal,
  provider?: string,
): Promise<CodexCompactSettingsState> {
  const latest = await loadCodexCompactSettings(path, signal);
  if (latest.kind === "invalid") {
    throw new Error("Cannot overwrite an invalid pi-codex-compact.json; repair it and reload first");
  }
  let document = { ...latest.document, ...patch };
  if (provider !== undefined) {
    if (!validProviderId(provider) || Object.keys(patch).some((key) => key !== "compactionMode" && key !== "protocol"))
      throw new Error("Invalid provider compaction settings patch");
    const overrides = {
      ...(latest.document?.providerOverrides as Record<string, Record<string, unknown>> | undefined),
    };
    const previous = Object.hasOwn(overrides, provider) ? overrides[provider] : {};
    const next = { ...previous, ...patch };
    if (Object.keys(patch).length === 0) {
      delete next.compactionMode;
      delete next.protocol;
    }
    if (Object.keys(next).length) overrides[provider] = next;
    else delete overrides[provider];
    document = { ...latest.document };
    if (Object.keys(overrides).length) document.providerOverrides = overrides;
    else delete document.providerOverrides;
  }
  const settings = normalizeCodexCompactSettings(document);
  if (!settings) throw new Error("Refusing to save invalid Codex compaction settings");
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_BYTES) {
    throw new Error("Refusing to save settings exceeding 64 KiB");
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  aborted(signal);
  try {
    await writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    aborted(signal);
    const current = await loadCodexCompactSettings(path, signal);
    if (
      current.kind === "invalid" ||
      current.kind !== latest.kind ||
      JSON.stringify(current.document) !== JSON.stringify(latest.document)
    ) {
      throw new Error("pi-codex-compact.json changed while saving; reopen settings and retry");
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { kind: "loaded", path, settings, document };
}

export function createCodexCompactSettingsRuntime(path = codexCompactSettingsPath()): CodexCompactSettingsRuntime {
  let state: CodexCompactSettingsState = {
    kind: "missing",
    path,
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
    document: {},
  };
  let queue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    get: () => structuredClone(state),
    reload: (signal) =>
      enqueue(async () => {
        state = await loadCodexCompactSettings(path, signal);
        return structuredClone(state);
      }),
    update: (patch, signal, provider) =>
      enqueue(async () => {
        state = await savePatch(path, patch, signal, provider);
        return structuredClone(state);
      }),
    flush: () => queue,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
