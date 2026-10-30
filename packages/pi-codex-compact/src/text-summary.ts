import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionProjection,
  convertToLlm,
  type FileOperations,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { fingerprintMessage, parseCheckpointDetails } from "./checkpoint.js";
import { projectedKeptMessages } from "./checkpoint-projection.js";
import { summaryPrefix } from "./checkpoint-recovery.js";
import { MAX_COMPACTION_ITEM_BYTES } from "./protocol.js";

const TEXT_SUMMARY_KIND = "pi-codex-text-summary";
export interface TextSummaryDetails {
  kind: typeof TEXT_SUMMARY_KIND;
  version: 1;
  resultId: string;
  readFiles: string[];
  modifiedFiles: string[];
}
export function createTextSummaryDetails(files: { readFiles: string[]; modifiedFiles: string[] }): TextSummaryDetails {
  return { kind: TEXT_SUMMARY_KIND, version: 1, resultId: randomUUID(), ...files };
}
export function parseTextSummaryDetails(value: unknown): TextSummaryDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as TextSummaryDetails;
  if (
    data.kind !== TEXT_SUMMARY_KIND ||
    data.version !== 1 ||
    typeof data.resultId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(data.resultId) ||
    ![data.readFiles, data.modifiedFiles].every(
      (list) => Array.isArray(list) && list.length <= 100_000 && list.every((path) => typeof path === "string"),
    )
  )
    return undefined;
  if (Buffer.byteLength(JSON.stringify([data.readFiles, data.modifiedFiles])) > MAX_COMPACTION_ITEM_BYTES)
    return undefined;
  return data;
}
/** V1 calls this a checkpoint ID; it identifies either persisted result format. */
export function activeCompactionId(entries: SessionEntry[]): string | undefined {
  const entry = [...entries].reverse().find((candidate) => candidate.type === "compaction");
  return (
    entry && (parseTextSummaryDetails(entry.details)?.resultId ?? parseCheckpointDetails(entry.details)?.checkpointId)
  );
}
export function matchedToolPairs(messages: readonly AgentMessage[]): boolean {
  const pending = new Set<string>();
  // Only convert Pi's message roles; unlike provider normalization this never
  // synthesizes missing tool results. Keep raw messages for history fingerprints.
  for (const message of convertToLlm([...messages])) {
    if (message.role === "assistant") {
      // Pi omits failed/aborted assistant attempts when replaying provider input.
      // Validate that replay without changing the saved messages or raw cut-point
      // fingerprints. Do not synthesize results: Pi closes earlier pending calls
      // before omitting an attempt, so accepting those here could replay duplicates.
      if (pending.size > 0) return false;
      if (message.stopReason === "aborted" || message.stopReason === "error") continue;
      for (const block of message.content)
        if (block.type === "toolCall") {
          if (pending.has(block.id)) return false;
          pending.add(block.id);
        }
    } else if (message.role === "toolResult" && !pending.delete(message.toolCallId)) return false;
    else if (message.role === "user" && pending.size > 0) return false;
  }
  return pending.size === 0;
}
/** Keep a minimal complete raw tail as Pi's native compaction anchor. The summary excludes it. */
export function textSummaryCut(entries: SessionEntry[], messages: AgentMessage[]) {
  const leaf = entries.at(-1)?.id ?? null;
  const projected = buildSessionProjection(entries, leaf).entries;
  for (const entry of [...projected].reverse()) {
    if (
      entry.sourceEntry.type === "compaction" ||
      !entry.messages.some((message) => message.role === "user" || message.role === "assistant")
    )
      continue;
    const kept = projectedKeptMessages(entries, leaf, entry.sourceEntry.id);
    if (!matchedToolPairs(kept)) continue;
    try {
      const prefix = summaryPrefix(messages, kept, fingerprintMessage);
      if (prefix.length && matchedToolPairs(prefix))
        return { firstKeptEntryId: entry.sourceEntry.id, messages: prefix };
    } catch {
      /* Covered opaque messages cannot serve as a plaintext retained tail. */
    }
  }
  return undefined;
}
/** Pi does not export its file-op collector. Match its public message/nested-call shapes. */
export function summaryFileOps(messages: AgentMessage[], entries: SessionEntry[]): FileOperations {
  const files: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
  const previous = [...entries].reverse().find((entry) => entry.type === "compaction");
  if (previous?.details && typeof previous.details === "object") {
    const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
    for (const [value, target] of [
      [details.readFiles, files.read],
      [details.modifiedFiles, files.edited],
    ] as const)
      if (Array.isArray(value)) for (const path of value) if (typeof path === "string") target.add(path);
  }
  const add = (name: string, args: unknown) => {
    const path = args && typeof args === "object" && "path" in args ? args.path : undefined;
    if (typeof path !== "string" || !path) return;
    if (name === "read") files.read.add(path);
    else if (name === "write") files.written.add(path);
    else if (name === "edit") files.edited.add(path);
  };
  for (const message of messages) {
    if (message.role === "assistant")
      for (const block of message.content) if (block.type === "toolCall") add(block.name, block.arguments);
    if (message.role === "toolResult")
      for (const call of message.nestedCalls?.calls ?? []) add(call.name, call.arguments);
  }
  return files;
}

/** Leave usable space on small-context models instead of applying the large-model default blindly. */
export function textSummaryReserve(contextWindow: number, requested = 16_000): number {
  return Math.max(0, Math.floor(Math.min(requested > 0 ? requested : 16_000, contextWindow / 4)));
}
