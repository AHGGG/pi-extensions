import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, sep } from "node:path";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { Notification } from "./provider.js";
import { clipText } from "./text.js";

export interface Metadata {
  id: string;
  sessionId: string;
  sessionName?: string;
  cwd: string;
  startedAt: number;
  settledAt: number;
  error: boolean;
}
export const safeText = (value: string) => clipText(sanitizeTerminalText(value).replaceAll("@", "＠"), 400);
export function displayPath(raw: string): string {
  const path = safeText(raw);
  const home = safeText(homedir());
  return path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
function git(cwd: string, args: string[], signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", ...args],
      { signal, timeout: 1500, maxBuffer: 8192, encoding: "utf8", windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout.trim()),
    );
  });
}
export async function notificationMetadata(data: Metadata, signal: AbortSignal): Promise<Notification> {
  const [root, common, branch] = await Promise.all([
    git(data.cwd, ["--show-toplevel"], signal),
    git(data.cwd, ["--git-common-dir"], signal),
    git(data.cwd, ["--abbrev-ref", "HEAD"], signal),
  ]);
  signal.throwIfAborted();
  const detached = branch === "HEAD" ? await git(data.cwd, ["--short", "HEAD"], signal) : undefined;
  signal.throwIfAborted();
  const lines = [
    `Computer: ${safeText(hostname())}`,
    `Session: ${data.sessionName ? `${safeText(data.sessionName)} ` : ""}(${safeText(data.sessionId)})`,
    `Workspace: ${displayPath(data.cwd)}`,
  ];
  if (root) {
    // Sanitize before splitting paths. Common Git directory names identify linked worktrees.
    const cleanRoot = safeText(root);
    const cleanCommon = common ? safeText(common) : undefined;
    const commonDirectory = cleanCommon && isAbsolute(cleanCommon) ? cleanCommon : undefined;
    const repository =
      commonDirectory && basename(commonDirectory) === ".git"
        ? basename(dirname(commonDirectory))
        : basename(cleanRoot);
    lines.push(`Repository: ${repository}`, `Worktree: ${displayPath(root)}`);
    if (branch) lines.push(`Branch: ${safeText(branch === "HEAD" ? `detached ${detached ?? "HEAD"}` : branch)}`);
  }
  lines.push(
    `Elapsed: ${Math.max(0, Math.floor((data.settledAt - data.startedAt) / 1000))}s`,
    `Stopped: ${new Date(data.settledAt).toISOString()}`,
  );
  return {
    id: data.id,
    title: data.error ? "Pi stopped with an error" : "Pi is ready for review",
    body: lines.join("\n"),
    settledAt: data.settledAt,
  };
}
