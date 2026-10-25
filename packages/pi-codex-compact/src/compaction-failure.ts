import { MAX_SSE_BYTES } from "./protocol.js";
import { abortError, isJsonObject } from "./remote-types.js";
import { terminalText } from "./terminal.js";

// Codex adapters can discard structured HTTP error fields when formatting a
// friendly stream error. Observe a bounded failed response before that conversion.
export async function inspectFailureResponse(
  response: Response,
  signal: AbortSignal,
): Promise<{ response: Response; rejection?: Error }> {
  if (response.ok || !response.body) return { response };
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const part = await reader.read();
      if (signal.aborted) throw abortError();
      if (part.done) {
        complete = true;
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) throw new Error("Compaction error response exceeded 64 KiB");
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks);
    const message = body.toString("utf8");
    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      rejection: isOAuthOperationRejection(message) ? new Error(message) : undefined,
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export function streamOperationRejection(raw: unknown): Error | undefined {
  if (!isJsonObject(raw)) return undefined;
  const error =
    raw.error ?? (raw.type === "response.failed" && isJsonObject(raw.response) ? raw.response.error : undefined);
  if (error === undefined) return undefined;
  const message = JSON.stringify(error);
  return isOAuthOperationRejection(message) ? new Error(message) : undefined;
}

// OpenAI's SDK can throw on a top-level SSE error before Pi's event callback.
// Forward bytes unchanged while inspecting complete bounded data frames only.
export function observeSseRejections(
  response: Response,
  signal: AbortSignal,
  observe: (error: Error) => void,
): Response {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, destination) {
        bytes += chunk.byteLength;
        if (bytes > MAX_SSE_BYTES) throw new Error("Compaction error inspection stream exceeded the size limit");
        pending += decoder.decode(chunk, { stream: true });
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(pending);
          if (!boundary) break;
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          if (Buffer.byteLength(frame) > 64 * 1024) continue;
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          let raw: unknown;
          try {
            raw = JSON.parse(data);
          } catch {
            continue;
          }
          const rejection = streamOperationRejection(raw);
          if (rejection) observe(rejection);
        }
        destination.enqueue(chunk);
      },
    }),
    { signal },
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function isOAuthOperationRejection(errorValue: unknown): boolean {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  // Pi's adapter exposes a formatted error string, not the SDK's structured error.
  // Require the exact returned code/type pair; a mention in diagnostic prose is not evidence.
  const start = message.indexOf("{");
  if (start < 0) return false;
  try {
    const body: unknown = JSON.parse(message.slice(start));
    if (!body || typeof body !== "object") return false;
    const error = "error" in body ? body.error : body;
    return (
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "hardened_oauth_rule_missing" &&
      "type" in error &&
      error.type === "rejected_by_hardened_oauth_boundary"
    );
  } catch {
    return false;
  }
}

function redactRequestValues(message: string, requestValues: readonly string[]): string {
  const values = new Set<string>();
  for (const value of requestValues) {
    if (!value) continue;
    values.add(value);
    // Header-owned auth can omit apiKey; redact a bare bearer or Basic credential too.
    const credential = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
    if (credential) values.add(credential);
  }
  const representations = [...values].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
  for (const value of [...new Set(representations)].sort((a, b) => b.length - a.length)) {
    message = message.split(value).join("[redacted]");
  }
  return message;
}

export function compactionFailureDetail(error: unknown, requestValues: readonly string[] = []): string {
  return terminalText(redactRequestValues(error instanceof Error ? error.message : String(error), requestValues));
}

export function compactionFailureMessage(
  error: unknown,
  requestValues: readonly string[] = [],
  safeDetail?: string,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const guidance = isOAuthOperationRejection(raw)
    ? "ChatGPT OAuth is not authorized for this compaction operation. " +
      "This route is paused for this session; /reload retries it. Without a checkpoint, using Pi compaction; " +
      "with a checkpoint, applying Checkpoint recovery (summary or safe cancellation). " +
      "Compatible checkpoint replay remains enabled. "
    : "Responses compaction failed; using Pi compaction. ";
  return guidance + (safeDetail ?? compactionFailureDetail(error, requestValues));
}
