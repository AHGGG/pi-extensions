import { isOAuthOperationRejection } from "./compaction-failure.js";
import { CodexCompactionProtocolError } from "./protocol.js";

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Only locally verified clean EOFs receive this type, never arbitrary provider prose. */
export class PrematureCompactionEof extends Error {}

/** Retry classification uses observed HTTP/transport facts, not the display diagnostic. */
export function preparationFailureRetryable(
  error: unknown,
  options: { timedOut?: boolean; httpStatus?: number } = {},
): boolean {
  if (error instanceof Error && isOAuthOperationRejection(error)) return false;
  if (options.httpStatus !== undefined && options.httpStatus >= 400)
    return (
      options.httpStatus === 408 ||
      options.httpStatus === 429 ||
      (options.httpStatus >= 500 && options.httpStatus <= 599)
    );
  if (options.timedOut) return true;
  if (!(error instanceof Error) || error instanceof CodexCompactionProtocolError) return false;
  if (error instanceof PrematureCompactionEof || error.name === "TimeoutError") return true;
  if (error.name === "AbortError") return false;
  const cause = error.cause instanceof Error ? error.cause : error;
  return (
    ("code" in cause && typeof cause.code === "string" && NETWORK_CODES.has(cause.code)) ||
    (error instanceof TypeError && error.message === "fetch failed")
  );
}

/** Public diagnostics contain only our fixed labels and allowlisted metadata, never provider prose. */
export function preparationFailureDetail(
  error: unknown,
  options: { timedOut?: boolean; httpStatus?: number; remoteAttempted?: boolean } = {},
): string {
  if (options.timedOut) return "checkpoint request timed out";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (typeof message === "string" && message.length <= 64 * 1024 && isOAuthOperationRejection(message))
    return "ChatGPT OAuth rejected this compaction operation";
  const status = options.httpStatus;
  if (status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599) {
    const reason =
      status === 401
        ? "authentication rejected"
        : status === 403
          ? "access denied"
          : status === 429
            ? "rate limited"
            : status >= 500
              ? "provider service error"
              : "request rejected";
    return `HTTP ${status}: ${reason}`;
  }
  // Only inspect known Error fields. Provider messages can echo prompts or credentials,
  // so even a redacted/truncated arbitrary message is not safe to publish.
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.message === "Context management request timed out")
      return "checkpoint request timed out";
    const cause = error.cause instanceof Error ? error.cause : error;
    const code = "code" in cause ? cause.code : undefined;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return `network request failed (${code})`;
    if (error.message === "Compaction retry binding changed")
      return "local retry cancelled because provider or authentication binding changed";
    if (error.message === "OpenAI Responses stream ended before a terminal response event")
      return "provider stream ended before a terminal response event";
    if (error instanceof CodexCompactionProtocolError) return "invalid compaction response or checkpoint";
    if (error.name === "AbortError") return "provider or transport aborted the checkpoint request";
    if (error instanceof TypeError && error.message === "fetch failed") return "network request failed";
  }
  return options.remoteAttempted
    ? "provider checkpoint preparation failed (no safe error details available)"
    : "checkpoint preparation failed before provider dispatch (no safe error details available)";
}
