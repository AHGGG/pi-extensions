import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { createSnapshot } from "../src/snapshot/snapshot.js";
import { stageMergeBaseline } from "../src/state/merge-baseline-store.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { agentContext } from "./agent-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";
import { deferred, inspectionFixture } from "./startup-check-helpers.js";

for (const boundary of ["agent_start", "session_shutdown", "session_start", "foreground"] as const)
  test(`owned background resolver drains at ${boundary}`, async () =>
    withTempHome(async (agentDir) => {
      const fixture = await createMergeFixture(agentDir);
      const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      settings.syncSetups.home.sync.agentMode = true;
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const config = await loadConfig();
      await stageMergeBaseline(
        config,
        await createSnapshot(config.snapshotIdentity, { include: config.include }),
        await readStateForConfig(config),
      );
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
      await fixture.remoteEdit("AGENTS.md", "remote\n");
      const ready = deferred();
      const context = agentContext(async () => {
        ready.resolve();
        return new Promise<string>(() => {});
      });
      const mock = createMockPi();
      const { default: extension } = await import("../src/sync-extension.js");
      extension(mock.pi, {
        loadSyncInspection: async () => ({
          inspectSync: async (current) =>
            inspectionFixture(current, { localChanged: true, remoteChanged: true, capability: "atomic-conditional" }),
        }),
        loadSyncOperations: async () => ({
          ...(await import("../src/sync/sync-operations.js")),
          syncBoth: (ctx, options) => syncBoth(ctx, options, () => fixture.backend),
        }),
      });
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
      await ready.promise;
      assert.equal(context.statuses.get("sync"), "sync resolving");
      const sibling = createMockPi();
      extension(sibling.pi);
      const siblingContext = createMockContext({ mode: "json", hasUI: false });
      await sibling.events.get("session_start")?.[0]?.({ reason: "startup" }, siblingContext.ctx);
      await sibling.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, siblingContext.ctx);
      assert.equal(
        (context.requestOptions[0] as { signal: AbortSignal }).signal.aborted,
        false,
        "an unrelated session must not cancel the owner",
      );
      if (boundary === "foreground") await mock.commands.get("sync")?.handler("help", context.ctx);
      else if (boundary === "session_start") {
        // A replacement with no model must not inherit the previous conversation/transport.
        const replacement = createMockContext({ mode: "rpc" });
        await mock.events.get("session_start")?.[0]?.({ reason: "new" }, replacement.ctx);
      } else await mock.events.get(boundary)?.[0]?.({ reason: "reload" }, context.ctx);
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      assert.equal(context.requests.length, 1);
      assert.equal((context.requestOptions[0] as { signal: AbortSignal }).signal.aborted, true);
      assert.equal(context.statuses.get("sync"), undefined);
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
      assert.equal(await readMergeJournal(config), undefined);
      await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/agent-resolver/claim.json")), /ENOENT/);
    }));
