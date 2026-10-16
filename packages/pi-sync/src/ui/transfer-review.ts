import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmMergeReview } from "./merge-review.js";

/** Reuse the scrollable safe-default review in TUI; retain RPC's confirmation protocol. */
export async function confirmTransferReview(
  ctx: ExtensionCommandContext | ExtensionContext,
  title: string,
  content: string,
  signal: AbortSignal | undefined,
  validate: () => void,
) {
  validate();
  const isCurrent = () => {
    try {
      validate();
      return true;
    } catch {
      return false;
    }
  };
  const confirmed =
    ctx.mode === "tui" && ctx.hasUI
      ? await confirmMergeReview(ctx, title, content, signal, isCurrent, "apply reviewed transfer", content.split("\n"))
      : await ctx.ui.confirm(title, content, { signal });
  validate();
  return confirmed;
}
