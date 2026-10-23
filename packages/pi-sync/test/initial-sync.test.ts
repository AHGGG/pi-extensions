import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { loadConfig } from "../src/settings/config.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { SyncDecisionRequiredError } from "../src/sync/sync-errors.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

const content = '{"theme":"dark"}\n';
const cases = [
  { name: "empty local and remote", local: undefined, remote: undefined, result: "Pushed" },
  { name: "local source", local: content, remote: undefined, result: "Pushed" },
  { name: "remote source", local: undefined, remote: content, result: "Pulled" },
  { name: "matching sources", local: content, remote: content, result: "state initialized" },
  { name: "empty remote snapshot", local: content, remote: "", result: "Pushed" },
  { name: "empty sources with remote snapshot", local: undefined, remote: "", result: "already up to date" },
  { name: "divergent sources", local: content, remote: '{"theme":"light"}\n', result: "decision" },
];

for (const auto of [false, true]) {
  for (const fixture of cases) {
    test(`initial sync ${fixture.name} preserves ${auto ? "automatic rejection" : "source selection"}`, async () => {
      await withTempHome(async (root) => {
        await updateLocalConfig(() => v3S3Settings() as PiSyncSettingsV3);
        const config = await loadConfig();
        if (fixture.local !== undefined) await fs.writeFile(path.join(root, "settings.json"), fixture.local);
        const backend = new MemorySyncBackend();
        if (fixture.remote !== undefined) {
          await backend.publishSnapshot(
            {
              ...snapshot(fixture.remote ? [{ path: "settings.json", content: Buffer.from(fixture.remote) }] : []),
              profile: config.snapshotIdentity,
              selection: { version: 1, include: config.include },
            },
            { kind: "missing" },
          );
        }
        const head = await backend.readHead();
        const { ctx, notifications } = createMockContext({ hasUI: true });
        const options: CommandOptions = {
          args: [],
          yes: true,
          force: false,
          stale: false,
          silent: false,
          reload: false,
          auto,
        };
        if (auto || fixture.result === "decision") {
          await assert.rejects(
            syncBoth(ctx, options, () => backend),
            auto ? /Automatic transfer is not authorized/ : SyncDecisionRequiredError,
          );
          assert.deepEqual(await backend.readHead(), head);
          assert.equal((await readStateForConfig(config)).lastAppliedSnapshot, undefined);
          assert.equal(
            await fs.readFile(path.join(root, "settings.json"), "utf8").catch(() => undefined),
            fixture.local,
          );
          return;
        }
        await syncBoth(ctx, options, () => backend);
        const currentHead = await backend.readHead();
        assert.ok(currentHead);
        const state = await readStateForConfig(config);
        assert.equal(state.lastAppliedSnapshot, currentHead.snapshotId);
        assert.equal(state.lastRemoteRevision, currentHead.revision);
        assert.ok(notifications.some(({ message }) => message.includes(fixture.result)));
        assert.equal(
          await fs.readFile(path.join(root, "settings.json"), "utf8").catch(() => undefined),
          fixture.local ?? (fixture.remote || undefined),
        );
      });
    });
  }
}
