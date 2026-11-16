import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseTextSummaryDetails } from "./text-summary.js";

const TEXT_SUMMARY_WORK_BOUNDARY = "Compaction complete. Please continue.";

/**
 * Clarify our active summary in request context only; do not schedule a run.
 * Applying a summary starts a new prefix epoch. Keep this suffix deterministic
 * across ordinary requests and leave saved history and the retained tail intact.
 */
export function textSummaryMessagesForWork(
  messages: AgentMessage[],
  entries: SessionEntry[],
): AgentMessage[] | undefined {
  const entry = [...entries].reverse().find((candidate) => candidate.type === "compaction");
  if (!entry || !parseTextSummaryDetails(entry.details)) return undefined;

  const projectedSummary = `${entry.summary}\n\n${TEXT_SUMMARY_WORK_BOUNDARY}`;
  const matches = messages.flatMap((message, index) =>
    message.role === "compactionSummary" && (message.summary === entry.summary || message.summary === projectedSummary)
      ? [index]
      : [],
  );
  // Do not guess when another extension has replaced or duplicated the summary.
  if (matches.length !== 1) return undefined;
  const index = matches[0];
  const message = messages[index];
  if (message.role !== "compactionSummary" || message.summary === projectedSummary) return undefined;

  return messages.map((current, currentIndex) =>
    currentIndex === index && current.role === "compactionSummary"
      ? { ...current, summary: projectedSummary }
      : current,
  );
}
