import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createSyncBackend } from "../src/backends/backend-factory.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import { push } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { snapshot, v3WebDavSettings, withTempHome } from "./helpers.js";
import { mergeOptions } from "./merged-sync-fixture.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

for (const trigger of ["command", "startup"] as const)
  test(`generated Jiti runtime resolves a real WebDAV conflict via ${trigger}`, async () =>
    withTempHome(async (agentDir) => {
      const server = await new MockWebDavServer().start();
      const buildDir = await fs.mkdtemp(path.resolve("packages/pi-sync/.pi-sync-build-test-"));
      let runtime: ReturnType<DefaultResourceLoader["getExtensions"]>["runtime"] | undefined;
      try {
        await fs.mkdir(agentDir, { recursive: true });
        const settings = v3WebDavSettings({ include: ["AGENTS.md"] });
        settings.storageConnections.dav.url = server.url;
        Object.assign(settings.syncSetups.home.sync, { agentMode: true });
        await fs.writeFile(localConfigPath(), JSON.stringify(settings));
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "base\n");
        const mock = agentContext(selectRemote);
        await push(mock.ctx, mergeOptions);
        const backend = await createSyncBackend(await loadConfig());
        const head = await backend.readHead();
        assert.ok(head);
        const remote = await backend.readSnapshot(head.snapshotRef);
        await backend.publishSnapshot(
          regenerateSnapshotIdentity({
            ...remote,
            files: snapshot([{ path: "AGENTS.md", content: Buffer.from("remote\n") }]).files,
          }),
          { kind: "revision", revision: head.revision },
        );
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
        const builderPath = pathToFileURL(path.resolve("packages/pi-sync/scripts/build-runtime.mjs")).href;
        const builder = (await import(builderPath)) as {
          buildRuntime(options: { outputDirectory: string }): Promise<unknown>;
        };
        await builder.buildRuntime({ outputDirectory: path.join(buildDir, "dist") });
        const loader = new DefaultResourceLoader({
          cwd: buildDir,
          agentDir,
          settingsManager: SettingsManager.inMemory({}),
          additionalExtensionPaths: [path.join(buildDir, "dist/index.ts")],
        });
        await loader.reload();
        const loaded = loader.getExtensions();
        runtime = loaded.runtime;
        assert.deepEqual(loaded.errors, []);
        const extension = loaded.extensions[0];
        assert.ok(extension);
        if (trigger === "command") {
          await extension.commands.get("sync")?.handler("sync", mock.ctx as ExtensionCommandContext);
        } else {
          let done!: () => void;
          const complete = new Promise<void>((resolve) => {
            done = resolve;
          });
          const notify = mock.ctx.ui.notify.bind(mock.ctx.ui);
          mock.ctx.ui.notify = (message, level) => {
            notify(message, level);
            if (message.includes("No automatic reload.") || message.includes("stopped:")) done();
          };
          for (const start of extension.handlers.get("session_start") ?? [])
            await start({ type: "session_start", reason: "startup" }, mock.ctx);
          await complete;
        }
        for (const stop of extension.handlers.get("session_shutdown") ?? [])
          await stop({ type: "session_shutdown", reason: "reload" }, mock.ctx);
        assert.equal(mock.requests.length, 1, JSON.stringify(mock.notifications));
        assert.equal(
          await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"),
          "remote\n",
          JSON.stringify(mock.notifications),
        );
        assert.equal(mock.statuses.get("sync"), undefined);
      } finally {
        runtime?.invalidate("agent Jiti test complete");
        await server.close();
        await fs.rm(buildDir, { recursive: true, force: true });
      }
    }));
