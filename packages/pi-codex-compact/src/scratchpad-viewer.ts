import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ScratchpadError, type ScratchpadItem, type ScratchpadStore } from "./scratchpad-store.js";
import { terminalText } from "./terminal.js";

/** Local, read-only UI: never publishes notes to the model or changes tool exposure. */
export async function showScratchpad(
  ctx: ExtensionCommandContext,
  store: ScratchpadStore,
  sessionId: string,
  owner: { signal: AbortSignal; isCurrent(): boolean },
): Promise<void> {
  const current = () => !owner.signal.aborted && owner.isCurrent();
  if (!current()) return;
  const file = terminalText(join(store.directory, `${sessionId}.json`));
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const message = `Scratchpad viewer requires TUI mode. Notes file: ${file}. Use /scratchpad show in an interactive session.`;
    if (ctx.hasUI) ctx.ui.notify(message, "info");
    else throw new Error(message);
    return;
  }
  let items: ScratchpadItem[];
  try {
    items = await store.readSnapshot(sessionId, owner);
  } catch (error) {
    if (!current()) return;
    const detail = error instanceof ScratchpadError ? `${error.code}: ${error.message}` : "Unable to read notes.";
    ctx.ui.notify(
      `Could not read scratchpad: ${terminalText(detail)}\nNotes file: ${file}. No notes were changed.`,
      "error",
    );
    return;
  }
  if (!current()) return;
  // UI import, compatibility and rendering errors are not storage failures.
  // Never include an arbitrary renderer exception: it may contain note text.
  try {
    const { runDocumentReview } = await import("@narumitw/pi-tui-kit");
    if (!current()) return;
    if (typeof runDocumentReview !== "function") {
      ctx.ui.notify(
        "Could not display scratchpad: the installed UI library is incompatible. Update the extension and restart Pi. Notes were not changed.",
        "error",
      );
      return;
    }
    const content = items.length
      ? items
          .map((item) => `#${item.id}\nCreated: ${item.createdAt}\nUpdated: ${item.updatedAt}\n\n${item.text}`)
          .join("\n\n────────────────────\n\n")
      : "No scratchpad notes for this session yet.";
    // Keep line breaks, but strip terminal sequences/control bytes before layout.
    // Notes are plain text, never Markdown, hyperlinks, or executable terminal content.
    const safeContent = stripVTControlCharacters(content).split("\n").map(terminalText).join("\n");
    await runDocumentReview(ctx, {
      title: `Scratchpad — ${items.length} item${items.length === 1 ? "" : "s"}`,
      lines: [`Session: ${terminalText(sessionId)}`, "Read-only snapshot; reopen to refresh."],
      content: safeContent,
      format: { kind: "text" },
      viewportSize: "adaptive",
      hint: "close",
      signal: owner.signal,
      isCurrent: current,
      onError: () => {
        if (current()) ctx.ui.notify("Could not display the scratchpad. Notes were not changed.", "error");
      },
    });
  } catch {
    if (current())
      ctx.ui.notify(
        "Could not display scratchpad: the viewer could not be loaded or rendered. Notes were not changed.",
        "error",
      );
  }
}
