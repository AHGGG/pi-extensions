import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { portableSnapshot } from "../src/sync/local-fields.js";
import { pull, push } from "../src/sync/sync-mutations.js";
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
async function fixture(root: string) {
  await fs.mkdir(root, { recursive: true });
  const settings = v3S3Settings();
  Object.assign(settings.syncSetups.home.sync, { localFields: [] });
  await fs.writeFile(localConfigPath(), JSON.stringify({ ...settings, version: 4 }));
  const bytes = '{"theme":"base","machine":"local-value"}';
  await fs.writeFile(path.join(root, "settings.json"), bytes);
  const context = createMockContext({ hasUI: true, mode: "rpc" });
  const ctx = context.ctx as ExtensionContext;
  const backend = new MemorySyncBackend();
  await push(ctx, options, undefined, () => backend);
  const config = await loadConfig();
  return { ...context, ctx, backend, config, bytes, state: await readStateForConfig(config) };
}

for (const route of ["push", "pull"] as const) {
  test(`${route} migration cancellation clears activity and changes neither bytes, state nor head`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      settings.syncSetups.home.sync.localFields = ["machine"];
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      if (route === "pull") {
        const current = await f.backend.readHead();
        assert.ok(current);
        const matching = portableSnapshot(await f.backend.readSnapshot(current.snapshotRef), ["machine"]);
        await f.backend.publishSnapshot(matching, { kind: "revision", revision: current.revision });
      }
      const head = await f.backend.readHead();
      f.ctx.ui.confirm = async () => false;
      const result =
        route === "push"
          ? await push(f.ctx, { ...options, force: true }, undefined, () => f.backend)
          : await pull(f.ctx, { ...options, force: true }, () => f.backend);
      assert.equal(result, "cancelled");
      assert.equal(f.statuses.get("sync"), undefined);
      assert.deepEqual(await readStateForConfig(f.config), f.state);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), f.bytes);
    }));
}

for (const decision of ["accept", "decline", "abort", "local-edit", "settings-edit", "same-policy"] as const) {
  test(`force push reviews refreshed remote policy with --yes: ${decision}`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      const readHead = f.backend.readHead.bind(f.backend);
      let reads = 0;
      let changedHead = await readHead();
      vi.spyOn(f.backend, "readHead").mockImplementation(async (signal) => {
        const head = await readHead(signal);
        if (++reads !== 2) return head;
        assert.ok(head);
        const current = await f.backend.readSnapshot(head.snapshotRef);
        const incoming = portableSnapshot(current, decision === "same-policy" ? [] : ["machine"]);
        changedHead = (await f.backend.publishSnapshot(incoming, { kind: "revision", revision: head.revision })).head;
        return changedHead;
      });
      const publication = vi.spyOn(f.backend, "publishSnapshot");
      const controller = new AbortController();
      const reviews: string[] = [];
      f.ctx.ui.confirm = async (title, message, inputOptions) => {
        reviews.push(`${title}\n${message}`);
        assert.equal(inputOptions?.signal, controller.signal);
        if (decision === "abort") controller.abort(new DOMException("Session replaced", "AbortError"));
        if (decision === "local-edit") await fs.writeFile(path.join(root, "settings.json"), '{"machine":"newer"}');
        if (decision === "settings-edit") {
          const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
          settings.syncSetups.home.sync.localFields = ["machine"];
          await fs.writeFile(localConfigPath(), JSON.stringify(settings));
        }
        return decision !== "decline";
      };
      const operation = push(f.ctx, { ...options, force: true, signal: controller.signal }, undefined, () => f.backend);
      if (decision === "abort") await assert.rejects(operation, { name: "AbortError" });
      else if (decision === "local-edit") await assert.rejects(operation, /Local content changed/);
      else if (decision === "settings-edit") await assert.rejects(operation, /Settings changed/);
      else if (decision === "decline") assert.equal(await operation, "cancelled");
      else assert.equal(await operation, "applied");
      assert.equal(reviews.length, decision === "same-policy" ? 0 : 1);
      if (reviews.length) {
        const review = reviews[0];
        assert.ok(review);
        assert.match(review, /Migrate portable settings policy\?/);
        assert.match(review, /required even with --yes/);
        assert.doesNotMatch(review, /local-value/);
      }
      const published = decision === "accept" || decision === "same-policy";
      assert.equal(publication.mock.calls.length, published ? 2 : 1); // Concurrent client publication, then authorized push only.
      if (published) {
        const head = await readHead();
        assert.ok(head);
        const snapshot = await f.backend.readSnapshot(head.snapshotRef);
        assert.deepEqual(snapshot.localFields, []);
        const file = snapshot.files[0];
        assert.ok(file);
        assert.match(Buffer.from(file.contentBase64, "base64").toString(), /local-value/);
      } else {
        assert.deepEqual(await readHead(), changedHead);
        assert.deepEqual(await readStateForConfig(f.config), f.state);
      }
      if (decision !== "local-edit") assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), f.bytes);
      if (decision === "decline") assert.equal(f.statuses.get("sync"), undefined);
    }));
}
