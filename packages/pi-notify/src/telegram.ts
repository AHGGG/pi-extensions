import { type DeliveryResult, isObject, type NotificationProvider } from "./provider.js";
import { clipText } from "./text.js";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

/** No user-configurable origin, redirects, paid broadcasts, formatting, or retries. */
export function createTelegramProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "telegram",
    label: "Telegram",
    validate(value) {
      if (!isObject(value) || value.provider !== "telegram") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      if (typeof value.botToken !== "string" || !/^\d{1,20}:[A-Za-z0-9_-]{20,200}$/.test(value.botToken))
        return undefined;
      if (typeof value.chatId !== "string" || !/^-?[1-9]\d{0,30}$/.test(value.chatId)) return undefined;
      if (
        value.messageThreadId !== undefined &&
        (!Number.isSafeInteger(value.messageThreadId) || Number(value.messageThreadId) <= 0)
      )
        return undefined;
      return {
        provider: "telegram",
        label: value.label,
        botToken: value.botToken,
        chatId: value.chatId,
        messageThreadId: value.messageThreadId === undefined ? undefined : Number(value.messageThreadId),
      };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeout.signal]);
      try {
        const response = await fetcher(`https://api.telegram.org/bot${destination.botToken}/sendMessage`, {
          method: "POST",
          redirect: "error",
          signal: combined,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: destination.chatId,
            ...(destination.messageThreadId === undefined ? {} : { message_thread_id: destination.messageThreadId }),
            text: clipText(`${notification.title}\n${notification.body}`, 4096),
            link_preview_options: { is_disabled: true },
          }),
        });
        const reader = response.body?.getReader();
        if (!reader) return { state: "failed", code: "response" };
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            combined.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > MAX_RESPONSE_BYTES) return { state: "failed", code: "response" };
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        combined.throwIfAborted();
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return { state: "failed", code: "response" };
        }
        if (!isObject(body)) return { state: "failed", code: "response" };
        if (response.status === 429 || body.error_code === 429) {
          const retry = isObject(body.parameters) ? body.parameters.retry_after : undefined;
          return {
            state: "failed",
            code: "rate-limit",
            ...(Number.isSafeInteger(retry) && Number(retry) > 0 ? { retryAfterSeconds: Number(retry) } : {}),
          };
        }
        if (!response.ok) return { state: "failed", code: "http" };
        return body.ok === true && isObject(body.result) ? { state: "accepted" } : { state: "failed", code: "api" };
      } catch {
        if (signal.aborted) return { state: "cancelled", code: "cancelled" };
        return { state: "failed", code: timeout.signal.aborted ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const providers = new Map([["telegram", createTelegramProvider()]]);
