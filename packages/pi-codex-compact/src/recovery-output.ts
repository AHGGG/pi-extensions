import type { JsonObject } from "./protocol.js";
import { isJsonObject } from "./remote-types.js";

function safeItem(item: unknown, completed = true): item is JsonObject {
  return (
    isJsonObject(item) &&
    (item.status === undefined || item.status === "completed" || (!completed && item.status === "in_progress")) &&
    (item.type === "reasoning" ||
      (item.type === "message" &&
        item.role === "assistant" &&
        Array.isArray(item.content) &&
        item.content.every(
          (part) => isJsonObject(part) && part.type === "output_text" && typeof part.text === "string",
        )))
  );
}

// Pi emits one text block per message, concatenating its output-text parts.
function outputText(items: JsonObject[]): string {
  return items
    .flatMap((item) =>
      item.type === "message" && Array.isArray(item.content)
        ? [item.content.map((part: { text: string }) => part.text).join("")]
        : [],
    )
    .join("\n");
}

/** Validate the independent wire evidence before trusting the adapter's completion. */
export class RecoveryOutput {
  private readonly added = new Map<number, { id: string; type: unknown }>();
  private readonly done = new Map<number, JsonObject>();
  private readonly ids = new Set<string>();
  private inventoryIncomplete = false;
  private createdId: string | undefined;
  private terminalItems = 0;
  private source = "none";
  private text: string | undefined;
  terminalSeen = false;

  diagnostic(completedText?: string): string {
    return `source=${this.source}; addedItems=${this.added.size}; doneItems=${this.done.size}; terminalItems=${this.terminalItems}; validatedTextBytes=${Buffer.byteLength(this.text ?? "")}; providerTextBytes=${completedText === undefined ? "unknown" : Buffer.byteLength(completedText)}`;
  }

  observe(raw: JsonObject): void {
    if (["response.incomplete", "response.failed", "response.cancelled", "error"].includes(String(raw.type)))
      throw new Error("Checkpoint recovery stream reported unsuccessful completion");
    if (raw.type === "response.created") {
      if (
        this.createdId !== undefined ||
        this.terminalSeen ||
        !isJsonObject(raw.response) ||
        typeof raw.response.id !== "string" ||
        !raw.response.id
      )
        throw new Error("Checkpoint recovery response identity is invalid");
      this.createdId = raw.response.id;
    }
    if (raw.type === "response.output_item.added" || raw.type === "response.output_item.done") {
      if (this.terminalSeen) throw new Error("Checkpoint recovery output arrived after completion");
      const index = raw.output_index;
      const item = raw.item;
      if (!isJsonObject(item) || (item.type !== "message" && item.type !== "reasoning"))
        throw new Error("Unsafe checkpoint recovery output");
      if (!safeItem(item, raw.type === "response.output_item.done"))
        throw new Error("Unsafe checkpoint recovery output");
      if (!Number.isSafeInteger(index) || (index as number) < 0 || typeof item.id !== "string" || !item.id) {
        // Older/custom adapters may supply unindexed done items alongside a full
        // terminal output. That existing path remains valid, but cannot establish
        // the independent complete inventory required for an empty terminal.
        this.inventoryIncomplete = true;
      } else {
        const key = index as number;
        if (raw.type === "response.output_item.added") {
          if (this.added.has(key) || this.ids.has(item.id))
            throw new Error("Duplicate checkpoint recovery output item");
          this.added.set(key, { id: item.id, type: item.type });
          this.ids.add(item.id);
        } else {
          const added = this.added.get(key);
          if (this.done.has(key)) throw new Error("Duplicate checkpoint recovery output item");
          if (!added) this.inventoryIncomplete = true;
          else if (added.id !== item.id || added.type !== item.type)
            throw new Error("Checkpoint recovery output item does not match its start");
          this.done.set(key, item);
        }
      }
    }
    if (raw.type !== "response.completed" && raw.type !== "response.done") return;
    const response = raw.response;
    if (
      this.terminalSeen ||
      !isJsonObject(response) ||
      response.status !== "completed" ||
      (this.createdId !== undefined && response.id !== this.createdId) ||
      response.error != null ||
      response.incomplete_details != null ||
      !Array.isArray(response.output)
    )
      throw new Error("Checkpoint recovery did not complete safely");
    this.terminalItems = response.output.length;
    if (!Array.from(response.output).every((item) => safeItem(item)))
      throw new Error("Unsafe checkpoint recovery terminal output");
    this.source = response.output.length ? "terminal" : "output_item_done";
    // Empty terminal output is a supported adapter shape, not permission to trust
    // arbitrary streamed text. Require a complete, uniquely indexed item lifecycle.
    const indexes = [...this.added.keys()].sort((a, b) => a - b);
    if (
      !response.output.length &&
      (this.inventoryIncomplete ||
        this.added.size !== this.done.size ||
        indexes.some((index, position) => index !== position) ||
        !this.done.size)
    )
      throw new Error(`Checkpoint recovery output inventory is incomplete (${this.diagnostic()})`);
    this.text = outputText(
      response.output.length
        ? (response.output as JsonObject[])
        : [...this.done.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
    );
    this.terminalSeen = true;
  }

  assertMatches(summary: string): void {
    if (summary !== this.text)
      throw new Error(
        `Checkpoint recovery terminal text conflicts with provider completion (${this.diagnostic(summary)})`,
      );
  }
}
