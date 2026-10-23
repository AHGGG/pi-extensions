import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousDependencies, enableContinuous, fakeContinuousTime, waitStatus } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";
import { deferred } from "./startup-check-helpers.js";

for (const boundary of ["agent_start", "session_start", "session_shutdown", "foreground"] as const)
  test(`continuous resolver drains and releases ownership at ${boundary}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
      await f.remoteEdit("AGENTS.md", "remote\n");
      let idle = true;
      const ready = deferred();
      const context = agentContext(
        async () => {
          ready.resolve();
          return new Promise<string>(() => {});
        },
        { isIdle: () => idle },
      );
      const mock = createMockPi();
      const { default: extension } = await import("../src/sync-extension.js");
      extension(mock.pi, continuousDependencies(f.backend));
      fakeContinuousTime();
      try {
        await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
        await ready.promise;
        const options = context.requestOptions[0] as { signal: AbortSignal };
        assert.equal(options.signal.aborted, false);
        const sibling = createMockContext({ mode: "rpc" });
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, sibling.ctx);
        assert.equal(options.signal.aborted, false, "unrelated manager cannot stop the owner");
        idle = false;
        if (boundary === "foreground") await mock.commands.get("sync")?.handler("help", context.ctx);
        else if (boundary === "session_start") {
          const replacement = createMockContext({ mode: "rpc", isIdle: () => false });
          await mock.events.get("session_start")?.[0]?.({ reason: "new" }, replacement.ctx);
          await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, replacement.ctx);
        } else await mock.events.get(boundary)?.[0]?.({ reason: "reload" }, context.ctx);
        assert.equal(options.signal.aborted, true);
        assert.equal(context.requests.length, 1);
        await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/continuous/scheduler.lock")), /ENOENT/);
        await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/agent-resolver/claim.json")), /ENOENT/);
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
      } finally {
        if (boundary !== "session_start")
          await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
        vi.useRealTimers();
      }
    }));

test("one startup cycle, foreground pause and idle resume use fresh authorization", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    const mock = createMockPi();
    const context = agentContext(selectRemote);
    const dependencies = continuousDependencies(f.backend);
    let checks = 0;
    const original = dependencies.loadSyncInspection;
    assert.ok(original);
    dependencies.loadSyncInspection = async () => {
      const module = await original();
      return {
        inspectSync: (...args) => {
          checks++;
          return module.inspectSync(...args);
        },
      };
    };
    const { default: extension } = await import("../src/sync-extension.js");
    extension(mock.pi, dependencies);
    fakeContinuousTime();
    try {
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
      await waitStatus(context.statuses, /waiting for changes/);
      assert.equal(checks, 1, "continuous startup did not also run the one-shot check");
      await mock.events.get("agent_start")?.[0]?.({}, context.ctx);
      assert.equal(context.statuses.get("sync"), undefined);
      await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
      await waitStatus(context.statuses, /waiting for changes/);
      assert.equal(checks, 2);
      await mock.commands.get("sync")?.handler("help", context.ctx);
      await waitStatus(context.statuses, /waiting for changes/);
      assert.equal(checks, 3);
      assert.equal(context.requests.length, 0);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      assert.equal(vi.getTimerCount(), 0);
      vi.useRealTimers();
    }
  }));

test("Help cannot bypass a failed startup recovery barrier", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await fs.mkdir(path.join(agentDir, ".pisync"));
    const context = agentContext(selectRemote);
    const mock = createMockPi();
    const { default: extension } = await import("../src/sync-extension.js");
    extension(mock.pi, continuousDependencies(f.backend));
    fakeContinuousTime();
    try {
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
      assert.ok(context.notifications.some((item) => item.message.startsWith("pi-sync recovery required")));
      await mock.commands.get("sync")?.handler("help", context.ctx);
      const { advanceContinuous } = await import("./continuous-test-helpers.js");
      await advanceContinuous(6000);
      assert.equal(context.requests.length, 0);
      assert.equal(
        context.notifications.some((item) => item.message.startsWith("Continuous sync")),
        false,
      );
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      vi.useRealTimers();
    }
  }));

test("lease loss aborts the actual provider request and rejects stale ownership", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const ready = deferred();
    const context = agentContext(async () => {
      ready.resolve();
      return new Promise<string>(() => {});
    });
    const { createContinuousSync } = await import("../src/sync/continuous-sync.js");
    const { continuousLoaders, advanceContinuous } = await import("./continuous-test-helpers.js");
    const service = createContinuousSync(continuousLoaders(f.backend));
    fakeContinuousTime();
    try {
      service.start(context.ctx, new AbortController().signal);
      await ready.promise;
      const guard = path.join(agentDir, "pi-sync/continuous/scheduler.lock");
      await fs.rename(guard, `${guard}.old`);
      await fs.mkdir(guard);
      const newTime = new Date(Date.now() + 1000);
      await fs.utimes(guard, newTime, newTime);
      await advanceContinuous(11_000);
      await vi.waitFor(() => assert.equal((context.requestOptions[0] as { signal: AbortSignal }).signal.aborted, true));
      await service.stop();
      assert.equal((await fs.stat(guard)).isDirectory(), true, "old cleanup retained the successor guard");
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  }));
