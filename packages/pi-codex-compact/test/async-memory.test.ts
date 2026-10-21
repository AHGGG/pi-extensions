import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { captureWarmCompactionBranch, startWarmCompaction, warmCompactionDraft } from "../src/async-compaction.js";
import { fingerprintJsonSequence } from "../src/compaction-fingerprint.js";
import { RejectedRoutes } from "../src/rejection-state.js";
import { assistant, deferred, fixture } from "./async-compaction-fixture.js";

function response() {
  const item = { type: "compaction", encrypted_content: "opaque" };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
  );
}

function history() {
  const h = fixture();
  for (let cycle = 0; cycle < 3; cycle++) {
    h.manager.appendMessage({ role: "user", content: `historical-${cycle} ${"old ".repeat(10_000)}`, timestamp: 3 });
    const kept = h.manager.appendMessage({ role: "user", content: `kept-${cycle}`, timestamp: 4 });
    h.manager.appendCompaction(`summary-${cycle}`, kept, 90_000);
  }
  h.manager.appendCustomEntry("state", { url: new URL("https://example.test/"), [Symbol("transient")]: "ignored" });
  const tail = h.manager.appendMessage({ role: "user", content: "active tail", timestamp: 5 });
  return { ...h, tail };
}

function start(h: ReturnType<typeof history>) {
  const owner = new AbortController();
  const started = deferred<void>();
  const release = deferred<void>();
  const job = startWarmCompaction(
    h.pi,
    h.ctx,
    h.runtime,
    owner.signal,
    new RejectedRoutes(),
    () => true,
    () => true,
    () => {},
    async () => {
      started.resolve();
      await release.promise;
      return response();
    },
  );
  assert.ok(job);
  return { job, owner, started: started.promise, release: () => release.resolve() };
}

test("fingerprints preserve persisted JSON semantics, value boundaries, and order", () => {
  assert.equal(
    fingerprintJsonSequence([{ url: new URL("https://example.test"), omitted: undefined, [Symbol()]: true }]),
    fingerprintJsonSequence([{ url: "https://example.test/" }]),
  );
  assert.equal(fingerprintJsonSequence([undefined]), fingerprintJsonSequence([null]));
  for (const [left, right] of [
    [
      [1, 23],
      [12, 3],
    ],
    [
      ["a\nb", "c"],
      ["a", "b\nc"],
    ],
    [
      [1, 2],
      [2, 1],
    ],
    [[null], []],
  ])
    assert.notEqual(fingerprintJsonSequence(left), fingerprintJsonSequence(right));
});

test("warm guard fixes the captured length and rejects compacted-out historical mutations", () => {
  const h = history();
  const captured = h.manager.getBranch();
  const current = captureWarmCompactionBranch(captured);
  captured.length = 0;
  assert.equal(current(h.manager.getBranch()), true, "capture must not retain or reread the caller's array");
  const first = h.manager.getEntry(h.first);
  assert.ok(first?.type === "message" && first.message.role === "user");
  first.message.content = "same ID, changed hidden history";
  assert.equal(current(h.manager.getBranch()), false);
});

test("only active provider messages are detached from borrowed, mutable session entries", async () => {
  const h = history();
  const argumentsValue = { nested: { path: "original-path" } };
  h.manager.appendMessage({
    ...assistant(""),
    content: [{ type: "toolCall", id: "call", name: "read", arguments: argumentsValue }],
  });
  h.manager.appendMessage({
    role: "toolResult",
    toolCallId: "call",
    toolName: "read",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: 6,
  });
  let providerContext: Context | undefined;
  const stream = h.provider.stream;
  h.provider.stream = (model, context, options) => {
    providerContext = context;
    return stream(model, context, options);
  };
  const pending = start(h);
  try {
    await pending.started;
    assert.ok(providerContext);
    assert.doesNotMatch(JSON.stringify(providerContext.messages), /historical-/);
    assert.equal("snapshot" in pending.job, false);
    const tail = h.manager.getEntry(h.tail);
    assert.ok(tail?.type === "message" && tail.message.role === "user");
    tail.message.content = "mutated live tail";
    argumentsValue.nested.path = "mutated-path";
    assert.match(JSON.stringify(providerContext.messages), /active tail/);
    assert.match(JSON.stringify(providerContext.messages), /original-path/);
    assert.doesNotMatch(JSON.stringify(providerContext.messages), /mutated live tail|mutated-path/);
    assert.equal(pending.job.isCurrent(), false);
    pending.release();
    assert.deepEqual(await pending.job.promise, { cancel: true });
  } finally {
    pending.owner.abort();
    pending.release();
  }
});

for (const changed of ["hidden", "active"] as const)
  test(`preparation rejects ${changed} in-place mutation during authentication before provider dispatch`, async () => {
    const h = history();
    const authStarted = deferred<void>();
    const authRelease = deferred<void>();
    const getAuth = h.ctx.modelRegistry.getApiKeyAndHeaders.bind(h.ctx.modelRegistry);
    h.ctx.modelRegistry.getApiKeyAndHeaders = async (...args) => {
      authStarted.resolve();
      await authRelease.promise;
      return getAuth(...args);
    };
    const pending = start(h);
    try {
      await authStarted.promise;
      const entry = h.manager.getEntry(changed === "hidden" ? h.first : h.tail);
      assert.ok(entry?.type === "message" && entry.message.role === "user");
      entry.message.content = "mutated during authentication";
      authRelease.resolve();
      assert.deepEqual(await pending.job.promise, { cancel: true });
      assert.equal(h.captured.length, 0);
    } finally {
      authRelease.resolve();
      pending.owner.abort();
      pending.release();
    }
  });

for (const change of ["hidden", "suffix", "append", "cancel"] as const)
  test(`borrowed auto-adoption rejects ${change} changes during authentication`, async () => {
    const h = history();
    const pending = start(h);
    const authStarted = deferred<void>();
    const authRelease = deferred<void>();
    const applying = new AbortController();
    try {
      await pending.started;
      pending.release();
      await pending.job.promise;
      assert.equal(pending.job.state, "Ready");
      const suffix = h.manager.appendMessage({ role: "user", content: "new suffix", timestamp: 6 });
      const getAuth = h.ctx.modelRegistry.getApiKeyAndHeaders.bind(h.ctx.modelRegistry);
      h.ctx.modelRegistry.getApiKeyAndHeaders = async (...args) => {
        authStarted.resolve();
        await authRelease.promise;
        return getAuth(...args);
      };
      const adoption = warmCompactionDraft(pending.job, h.ctx, h.runtime, applying.signal, () => true);
      await authStarted.promise;
      if (change === "cancel") applying.abort();
      else if (change === "append") h.manager.appendCustomEntry("bookkeeping", {});
      else {
        const entry = h.manager.getEntry(change === "hidden" ? h.first : suffix);
        assert.ok(entry?.type === "message" && entry.message.role === "user");
        entry.message.content = "changed while authenticating";
      }
      authRelease.resolve();
      assert.equal(await adoption, undefined);
    } finally {
      applying.abort();
      authRelease.resolve();
      pending.owner.abort();
      pending.release();
    }
  });

test("repeated preparation, cancellation, ready adoption, and cleanup preserve history", async () => {
  const h = history();
  const original = JSON.stringify(h.manager.getBranch());
  for (let cycle = 0; cycle < 8; cycle++) {
    const pending = start(h);
    try {
      await pending.started;
      if (cycle % 2 === 0) pending.owner.abort();
      pending.release();
      const result = await pending.job.promise;
      if (cycle % 2 === 0) assert.deepEqual(result, { cancel: true });
      else {
        assert.equal(pending.job.state, "Ready");
        const draft = await warmCompactionDraft(pending.job, h.ctx, h.runtime, pending.owner.signal, () => true);
        assert.equal(draft?.type, "compaction");
      }
      assert.equal(JSON.stringify(h.manager.getBranch()), original, "preview and cleanup never mutate live history");
      if (cycle % 2 !== 0) assert.equal(h.statuses.get("codex-compact"), undefined);
    } finally {
      pending.owner.abort();
      pending.release();
    }
  }
});
