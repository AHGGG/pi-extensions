import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Never rebase inherited or relocated history against the current process cwd. */
export function summaryPathRoot(ctx: ExtensionContext): string | undefined {
  const header = ctx.sessionManager.getHeader();
  return header && !header.parentSession && header.cwd === ctx.cwd && header.cwd === ctx.sessionManager.getCwd()
    ? header.cwd
    : undefined;
}

function rootPrefix(root?: string): { prefix: string; windows: boolean } | undefined {
  if (!root) return undefined;
  const windows = /^[A-Za-z]:[\\/]/.test(root) || /^\\\\[^\\]+\\[^\\]+/.test(root);
  if (!windows && (!root.startsWith("/") || root.startsWith("//"))) return undefined;
  const value = windows ? root.replaceAll("\\", "/") : root;
  // Do not lexically collapse '..' through a possible symlink, or guess a base
  // for drive-relative/root-relative Windows paths. Preserve case on all hosts.
  if (value.split("/").some((part) => part === "." || part === "..")) return undefined;
  return { prefix: `${value.replace(/\/+$/, "")}/`, windows };
}

function displayPath(path: string, root: ReturnType<typeof rootPrefix>): string {
  if (!root) return path;
  const value = root.windows ? path.replaceAll("\\", "/") : path;
  if (value.startsWith(root.prefix)) {
    const relative = value.slice(root.prefix.length);
    return relative && !/^[/@~]|^[A-Za-z]:/.test(relative) ? relative : path;
  }
  // Only spelling aliases with a known base can be merged. Leave paths outside
  // that base, dot segments, case variants, and other drives intact. Do not
  // introduce Pi's leading @/~ path shorthand for a literal filename.
  if (!value.startsWith("/") && !/^[A-Za-z]:/.test(value)) {
    const relative = value.replace(/^(\.\/)+/, "");
    return relative && !/^[/@~]|^[A-Za-z]:/.test(relative) ? relative : path;
  }
  return path;
}

// JSON quoting keeps commas, whitespace, controls, and tag-like filenames exact
// without letting a path introduce a new line or a fake metadata delimiter.
function quote(path: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(path)
    ? path
    : JSON.stringify(path).replace(
        /[<>\u007f-\u009f\u2028\u2029]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
}

function group(paths: string[]): string {
  const directories = new Map<string, string[]>();
  for (const path of paths) {
    const index = path.lastIndexOf("/") + 1;
    const directory = path.slice(0, index);
    const names = directories.get(directory) ?? [];
    names.push(path.slice(index));
    directories.set(directory, names);
  }
  return [...directories]
    .map(([directory, names]) =>
      directory && names.length > 1 && names.every(Boolean)
        ? `${quote(directory)}\n  ${names.map(quote).join(", ")}`
        : names.map((name) => quote(directory + name)).join("\n"),
    )
    .join("\n");
}

/** Model-facing presentation only; callers retain complete raw arrays in details. */
export function formatSummaryFilePaths(readFiles: string[], modifiedFiles: string[], cwd?: string): string {
  const root = rootPrefix(cwd);
  const modified = new Set(modifiedFiles.map((path) => displayPath(path, root)));
  const read = [...new Set(readFiles.map((path) => displayPath(path, root)))].filter((path) => !modified.has(path));
  if (!read.length && !modified.size) return "";
  const legend =
    "File paths: directory headings apply to indented, comma-separated basenames; quoted paths use JSON escapes." +
    (root ? `\nSession root: ${quote(root.prefix)} (plain relative paths are under this root).` : "");
  return (
    `\n\n${legend}` +
    (read.length ? `\n\n<read-files>\n${group(read.sort())}\n</read-files>` : "") +
    (modified.size ? `\n\n<modified-files>\n${group([...modified].sort())}\n</modified-files>` : "")
  );
}
