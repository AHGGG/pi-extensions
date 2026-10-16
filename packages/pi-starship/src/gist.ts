import { spawn } from "node:child_process";

export const GIST_FILENAME = "pi-starship.toml";
export const MAX_GIST_DOCUMENT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type GhApi = (args: string[], input: string | undefined, signal: AbortSignal) => Promise<string>;

/** Gists are intentionally limited to github.com; never forward auth to a pasted host. */
export function gistId(value: string): string {
  const text = value.trim();
  if (/^[a-f\d]{5,64}$/iu.test(text)) return text;
  try {
    const url = new URL(text);
    const match = /^\/(?:[\w-]+\/)?([a-f\d]{5,64})\/?$/iu.exec(url.pathname);
    if (
      url.protocol === "https:" &&
      url.hostname === "gist.github.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      match?.[1]
    )
      return match[1];
  } catch {
    // Report one fixed error without echoing untrusted input.
  }
  throw new Error("Enter a github.com Gist ID or https://gist.github.com/<owner>/<id> URL.");
}

export function checkGistDocument(rawDocument: string): void {
  if (!rawDocument.trim()) throw new Error("The Gist settings document is empty.");
  if (Buffer.byteLength(rawDocument, "utf8") > MAX_GIST_DOCUMENT_BYTES) {
    throw new Error("The Gist settings document exceeds 64 KiB.");
  }
}

export async function createSettingsGist(
  rawDocument: string,
  signal: AbortSignal,
  api: GhApi = executeGhApi,
): Promise<string> {
  checkGistDocument(rawDocument);
  const response = JSON.parse(
    await api(
      ["/gists", "--method", "POST", "--input", "-"],
      JSON.stringify({
        description: "pi-starship footer settings",
        public: false,
        files: { [GIST_FILENAME]: { content: rawDocument } },
      }),
      signal,
    ),
  ) as unknown;
  signal.throwIfAborted();
  if (!isRecord(response) || response.public !== false || typeof response.html_url !== "string") {
    throw new Error("GitHub returned an invalid Gist response. Check your Gists before retrying.");
  }
  return `https://gist.github.com/${gistId(response.html_url)}`;
}

export async function fetchSettingsGist(
  value: string,
  signal: AbortSignal,
  api: GhApi = executeGhApi,
): Promise<string> {
  const id = gistId(value);
  const response = JSON.parse(await api([`/gists/${id}`, "--method", "GET"], undefined, signal)) as unknown;
  signal.throwIfAborted();
  const file = isRecord(response) && isRecord(response.files) ? response.files[GIST_FILENAME] : undefined;
  if (!isRecord(file) || typeof file.content !== "string" || file.truncated !== false) {
    throw new Error(`The Gist must contain a complete ${GIST_FILENAME} file. Truncated files are not supported.`);
  }
  checkGistDocument(file.content);
  return file.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bound output and lifetime, keep request bodies on stdin, and never expose gh stderr. */
export const executeGhApi: GhApi = (args, input, signal) => {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "gh.exe" : "gh", ["api", "--hostname", "github.com", ...args], {
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "", GH_DEBUG: "" },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const onAbort = () => stop(new Error("Gist request cancelled."));
    const timer = setTimeout(
      () => stop(new Error("Gist request timed out. Check GitHub before retrying an upload.")),
      REQUEST_TIMEOUT_MS,
    );
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) stop(new Error("GitHub Gist response exceeds 512 KiB."));
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {
      stop(new Error("Unable to send settings to gh."));
    });
    child.on("error", () => {
      failure ??= new Error("Unable to start gh. Install GitHub CLI and run gh auth login with Gist access.");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            "Gist request failed. Check gh auth status, Gist access, and connectivity. An upload may already exist.",
          ),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (signal.aborted) onAbort();
    child.stdin.end(input);
  });
};
