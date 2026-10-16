import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Destination, deliver, type Notification } from "../src/provider.js";
import { createTelegramProvider } from "../src/telegram.js";
import { clipText } from "../src/text.js";

export const destination: Destination = {
  provider: "telegram",
  label: "Personal",
  botToken: `123:${"s".repeat(30)}`,
  chatId: "-100123",
};
const note: Notification = { id: "1", title: "Test", body: "hello <b>world</b>", settledAt: 0 };
afterEach(() => vi.useRealTimers());

describe("Telegram provider", () => {
  it.each([
    [{ ok: true, result: { message_id: 1 } }, 200, "accepted", undefined],
    [{ ok: false, description: "secret" }, 200, "failed", "api"],
    [{ ok: false }, 403, "failed", "http"],
    [{ ok: false, error_code: 429, parameters: { retry_after: 8 } }, 200, "failed", "rate-limit"],
    [{ ok: false }, 429, "failed", "rate-limit"],
    [[], 200, "failed", "response"],
  ])("normalizes %j / %s", async (body, status, state, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: Number(status) }));
    const provider = createTelegramProvider(fetcher);
    const result = await deliver(new Map([[provider.id, provider]]), destination, note, new AbortController().signal);
    expect(result.state).toBe(state);
    if (result.state === "failed") expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses fixed HTTPS, no redirects, plain text and optional forum topics", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true,"result":{}}'));
    await createTelegramProvider(fetcher).send(
      { ...destination, messageThreadId: 42 },
      { ...note, body: "😀".repeat(4000) },
      new AbortController().signal,
    );
    const call = fetcher.mock.calls[0];
    assert.ok(call);
    const [url, init] = call;
    expect(url).toBe(`https://api.telegram.org/bot${destination.botToken}/sendMessage`);
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text).not.toMatch(/[\ud800-\udbff]…$/);
    expect(body.message_thread_id).toBe(42);
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    expect(body).not.toHaveProperty("parse_mode");
    expect(body).not.toHaveProperty("allow_paid_broadcast");
  });
  it.each([
    null,
    [],
    {},
    { ...destination, provider: "slack" },
    { ...destination, botToken: "https://evil" },
    { ...destination, chatId: 123 },
    { ...destination, messageThreadId: -1 },
    { ...destination, messageThreadId: 1.5 },
  ])("rejects invalid destinations %j", (value) => {
    expect(createTelegramProvider().validate(value)).toBeUndefined();
  });
  it("accepts private, group and supergroup IDs and topic IDs", () => {
    const provider = createTelegramProvider();
    for (const chatId of ["123", "-123", "-100123456789"])
      expect(provider.validate({ ...destination, chatId, messageThreadId: 1 })).toBeDefined();
  });
  it.each(["not JSON", "x".repeat(65537)])("bounds and rejects malformed response bodies", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await createTelegramProvider(fetcher).send(destination, note, new AbortController().signal)).toEqual({
      state: "failed",
      code: "response",
    });
  });
  it("cancels hanging requests and clears timeout resources", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error(destination.botToken)), { once: true }),
          ),
      );
    const controller = new AbortController();
    const sending = createTelegramProvider(fetcher).send(destination, note, controller.signal);
    controller.abort();
    expect(await sending).toEqual({ state: "cancelled", code: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    const timed = createTelegramProvider(fetcher).send(destination, note, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await timed).toEqual({ state: "failed", code: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("redacts transport failures including redirect errors", async () => {
    const provider = createTelegramProvider(
      vi.fn<typeof fetch>().mockRejectedValue(new Error(`redirect to https://evil/${destination.botToken}`)),
    );
    expect(await provider.send(destination, note, new AbortController().signal)).toEqual({
      state: "failed",
      code: "network",
    });
  });
  it("dispatches through a fake provider and propagates cancellation", async () => {
    const signal = new AbortController().signal;
    const send = vi.fn().mockResolvedValue({ state: "accepted" });
    const fake = { id: "telegram", label: "Fake", validate: () => destination, send };
    expect(await deliver(new Map([["telegram", fake]]), destination, note, signal)).toEqual({ state: "accepted" });
    expect(send).toHaveBeenCalledWith(destination, note, signal);
    expect(await deliver(new Map(), destination, note, signal)).toEqual({
      state: "failed",
      code: "unsupported-provider",
    });
    expect(
      await deliver(new Map([["telegram", { ...fake, validate: () => undefined }]]), destination, note, signal),
    ).toEqual({ state: "failed", code: "invalid-destination" });
    send.mockRejectedValue(new Error(destination.botToken));
    expect(await deliver(new Map([["telegram", fake]]), destination, note, signal)).toEqual({
      state: "failed",
      code: "network",
    });
  });
  it("clips Unicode without splitting code points", () => {
    expect(clipText("😀😀😀", 4)).toBe("😀…");
  });
});
