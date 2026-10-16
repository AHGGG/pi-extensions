import { isDeepStrictEqual } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { requireSettings, updateLocalConfig } from "../settings/settings-store.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import { confirmMergeReview } from "./merge-review.js";
import { safeTerminalText } from "./terminal-text.js";

export const AGENT_MODE_DESCRIPTION =
  "This setup, experimental: one autonomous merged sync next startup and on Sync now. Sends eligible conflict text to the selected Pi model; may incur costs and replace/delete selected local and remote content without transfer prompts. No automatic reload. Unsupported conflicts pause.";

export async function saveAgentMode(
  ctx: ExtensionCommandContext,
  setupName: string,
  enabled: boolean,
  signal?: AbortSignal,
) {
  const validate = captureMutationOwner(ctx, signal);
  const settings = await requireSettings();
  validate();
  const setup = settings.syncSetups[setupName];
  if (!setup || settings.activeSyncSetup !== setupName) throw new Error("Current sync setup changed; reopen Settings.");
  if (Boolean(setup.sync.agentMode) === enabled) return true;
  if (enabled) {
    const summary = [
      `Setup: ${safeTerminalText(setupName)}`,
      `Storage connection: ${safeTerminalText(setup.storage.connection)}`,
      `Storage path: ${safeTerminalText(setup.storage.path)}`,
      ...(setup.storage.bucket ? [`Bucket: ${safeTerminalText(String(setup.storage.bucket))}`] : []),
      ...(setup.storage.branch ? [`Branch: ${safeTerminalText(String(setup.storage.branch))}`] : []),
      `Included paths: ${setup.sync.include.map(safeTerminalText).join(", ")}`,
      AGENT_MODE_DESCRIPTION,
      "Only bounded Markdown/plain-text conflicts and atomic global settings choices are eligible. Model errors can change intended behavior. Session histories, code, deletion conflicts and path collisions are not model-resolved.",
      "The existing baseline, selection, secret-scan and publication checks remain. Pi Sync cannot exclude arbitrary concurrent local writers. Disabling does not undo completed transfers or provider charges. No transfer starts from Settings.",
    ].join("\n\n");
    if (
      !(await confirmMergeReview(
        ctx,
        "Enable experimental Agent mode?",
        summary,
        signal,
        () => !signal?.aborted,
        "Enable Agent mode",
        summary.split("\n"),
      ))
    )
      return false;
    validate();
  }
  await updateLocalConfig((current) => {
    validate();
    if (
      current.activeSyncSetup !== setupName ||
      !isDeepStrictEqual(current.syncSetups[setupName], setup) ||
      !isDeepStrictEqual(
        current.storageConnections[setup.storage.connection],
        settings.storageConnections[setup.storage.connection],
      )
    )
      throw new Error("Sync setup or connection changed during Agent mode review; reopen Settings.");
    return {
      ...current,
      syncSetups: { ...current.syncSetups, [setupName]: { ...setup, sync: { ...setup.sync, agentMode: enabled } } },
    };
  }, signal);
  validate();
  return true;
}
