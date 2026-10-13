import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { loadConfig, syncConfigReviewIdentity } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { createSnapshot } from "../src/snapshot/snapshot.js";
import { readStateForConfig, statePathForConfig } from "../src/state/sync-state-store.js";
import { portableSnapshot, sameLocalFields } from "../src/sync/local-fields.js";
import { push, syncBoth } from "../src/sync/sync-mutations.js";
import { syncPolicyChanged } from "../src/sync/sync-state.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

const options: CommandOptions = {
  args: [],
  yes: true,
  force: false,
  stale: false,
  silent: false,
  reload: false,
  auto: false,
};

for (const [left, right, expected] of [
  [undefined, undefined, true],
  [undefined, [], false],
  [[], undefined, false],
  [[], [], true],
  [undefined, ["machine"], false],
  [["machine"], [], false],
  [["x", "y"], ["y", "x"], true],
] as const) {
  test(`policy presence: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`, () => {
    assert.equal(sameLocalFields(left, right), expected);
  });
}

test("opting a sibling setup into v4 leaves absent policy, identity, baseline and v1 publications unchanged", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
    await fs.writeFile(path.join(root, "settings.json"), '{"theme":"base","machine":"portable-until-opt-in"}');
    const { ctx } = createMockContext({ hasUI: true });
    const backend = new MemorySyncBackend();
    await push(ctx, options, undefined, () => backend);
    const before = await loadConfig();
    const beforeState = await readStateForConfig(before);
    await updateLocalConfig((current) => {
      const home = current.syncSetups.home;
      assert.ok(home);
      return {
        ...current,
        version: 4,
        syncSetups: {
          ...current.syncSetups,
          sibling: {
            storage: { ...home.storage, path: "pi-sync/sibling" },
            sync: { ...home.sync, localFields: ["machine"] },
          },
        },
      };
    });
    const after = await loadConfig();
    assert.equal(after.localFields, undefined);
    assert.equal(syncConfigReviewIdentity(after), syncConfigReviewIdentity(before));
    assert.equal(syncPolicyChanged(beforeState, after), false);
    assert.deepEqual((await loadConfig("sibling")).localFields, ["machine"]);
    const publication = vi.spyOn(backend, "publishSnapshot");
    await syncBoth(ctx, options, () => backend);
    assert.equal(publication.mock.calls.length, 0);
    await push(ctx, options, undefined, () => backend);
    const head = await backend.readHead();
    assert.ok(head);
    const remote = await backend.readSnapshot(head.snapshotRef);
    assert.equal(remote.version, 1);
    assert.equal(remote.localFields, undefined);
    const file = remote.files[0];
    assert.ok(file);
    assert.match(Buffer.from(file.contentBase64, "base64").toString(), /portable-until-opt-in/);
    assert.equal((await readStateForConfig(after)).localFields, undefined);
  }));

for (const settingsVersion of [3, 4]) {
  test(`absent setup policy in settings v${settingsVersion} cannot accept explicitly empty portable remote`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(localConfigPath(), JSON.stringify({ ...v3S3Settings(), version: settingsVersion }));
      await fs.writeFile(path.join(root, "settings.json"), '{"theme":"base"}');
      const config = await loadConfig();
      const local = await createSnapshot(config.snapshotIdentity, { include: config.include });
      const backend = new MemorySyncBackend();
      await backend.publishSnapshot(portableSnapshot(local, []), { kind: "missing" });
      const head = await backend.readHead();
      const { ctx } = createMockContext({ hasUI: true });
      await assert.rejects(
        syncBoth(ctx, options, () => backend),
        /local-field policy differs/,
      );
      await assert.rejects(fs.stat(statePathForConfig(config)), { code: "ENOENT" });
      assert.deepEqual(await backend.readHead(), head);
      assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), '{"theme":"base"}');
    }));
}

test("explicit empty policy requires migration from an accepted absent policy", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
    await fs.writeFile(path.join(root, "settings.json"), '{"theme":"base"}');
    const { ctx } = createMockContext({ hasUI: true });
    const backend = new MemorySyncBackend();
    await push(ctx, options, undefined, () => backend);
    const state = await readStateForConfig(await loadConfig());
    await updateLocalConfig((current) => {
      const home = current.syncSetups.home;
      assert.ok(home);
      return {
        ...current,
        version: 4,
        syncSetups: {
          ...current.syncSetups,
          home: { ...home, sync: { ...home.sync, localFields: [] } },
        },
      };
    });
    assert.equal(syncPolicyChanged(state, await loadConfig()), true);
    await assert.rejects(
      syncBoth(ctx, options, () => backend),
      /Local-field rules changed/,
    );
    const head = await backend.readHead();
    (ctx as ExtensionContext).ui.confirm = async () => false;
    assert.equal(await push(ctx, { ...options, force: true }, undefined, () => backend), "cancelled");
    assert.deepEqual(await backend.readHead(), head);
    (ctx as ExtensionContext).ui.confirm = async () => true;
    await push(ctx, { ...options, force: true }, undefined, () => backend);
    const acceptedHead = await backend.readHead();
    assert.ok(acceptedHead);
    const remote = await backend.readSnapshot(acceptedHead.snapshotRef);
    assert.equal(remote.version, 2);
    assert.deepEqual(remote.localFields, []);
    await syncBoth(ctx, options, () => backend);
  }));
