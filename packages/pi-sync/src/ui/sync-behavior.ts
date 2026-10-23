export const AUTOMATIC_SYNC_DESCRIPTION =
  "This setup: check remote state once at startup in TUI/RPC. At shutdown, push all selected content only when sessions are included; reload skips that push. Saves apply to subsequent operations; a new check waits for the next session start. This does not enable startup transfer.";

export const STARTUP_TRANSFER_DESCRIPTION =
  "This setup: separate opt-in for one idle startup transfer in TUI/RPC. Requires an accepted baseline, matching remote included paths, and conditional or lease-protected publication (Git, verified WebDAV, or R2/S3 with verified conditional writes). May upload, replace, or remove selected files. Never reloads resources. Enabling applies next session start; opening Settings cancels pending work. Completed transfers are not undone.";

export function startupTransferSummary(config: {
  automaticTransfer?: boolean;
  backend: { type: "s3" | "git" | "webdav" };
}) {
  if (!config.automaticTransfer) return "Off";
  return config.backend.type === "s3"
    ? "On (next idle startup; R2/S3 conditional-write verification required)"
    : "On (next idle startup; baseline and remote policy checks required)";
}
