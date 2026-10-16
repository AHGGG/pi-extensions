import assert from "node:assert/strict";
import { test } from "vitest";
import { throwIfAborted } from "../src/sync/signals.js";

for (const signal of [undefined, new AbortController().signal]) {
  test(`cancellation checkpoint accepts ${signal ? "an active signal" : "no signal"}`, () => {
    assert.doesNotThrow(() => throwIfAborted(signal));
  });
}

for (const reason of [
  undefined,
  new Error("cancelled"),
  new DOMException("cancelled", "AbortError"),
  "cancelled",
  42,
  null,
  { cancelled: true },
]) {
  test(`cancellation checkpoint preserves Error reasons and normalizes ${String(reason)}`, () => {
    const controller = new AbortController();
    controller.abort(reason);
    assert.throws(
      () => throwIfAborted(controller.signal),
      (error: unknown) => {
        if (controller.signal.reason instanceof Error) {
          assert.equal(error, controller.signal.reason);
        } else {
          assert.ok(error instanceof DOMException);
          assert.equal(error.name, "AbortError");
          assert.equal(error.message, "The operation was aborted");
        }
        return true;
      },
    );
  });
}
