import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-codex-compact",
  forbiddenEagerInputs: ["src/settings-menu.ts", "src/scratchpad-viewer.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-codex-compact-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("codex-compact"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_compact"));
    assert.ok(extension?.handlers.has("agent_before_settle"));
    assert.ok(extension?.handlers.has("agent_settled"));
    assert.ok(extension?.handlers.has("session_shutdown"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

test("managed package layouts load settings and the scratchpad viewer without physical Pi peers", async () => {
  const builder = await loadBuilder();
  const buildRoot = await mkdtemp(join(packageRoot, ".pi-codex-compact-build-test-"));
  const isolatedRoot = await mkdtemp(join(tmpdir(), "pi-codex-compact-isolated-"));
  const agentDir = join(isolatedRoot, "agent");
  const output = join(buildRoot, "dist");
  const tuiKitRoot = resolve(fileURLToPath(import.meta.resolve("@narumitw/pi-tui-kit")), "../..");
  const isolatedTuiKitRoot = join(isolatedRoot, "node_modules", "@narumitw", "pi-tui-kit");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await cp(output, join(isolatedRoot, "dist"), { recursive: true });
    await cp(join(packageRoot, "package.json"), join(isolatedRoot, "package.json"));
    await mkdir(isolatedTuiKitRoot, { recursive: true });
    await cp(join(tuiKitRoot, "package.json"), join(isolatedTuiKitRoot, "package.json"));
    await cp(join(tuiKitRoot, "dist"), join(isolatedTuiKitRoot, "dist"), { recursive: true });
    // Kit's document renderer imports its declared Diff dependency even for plain text.
    // Copy it like a managed npm install would; Pi peers must still be host-provided.
    const kitRequire = createRequire(join(tuiKitRoot, "package.json"));
    const diffRoot = resolve(kitRequire.resolve("diff/package.json"), "..");
    await cp(diffRoot, join(isolatedRoot, "node_modules", "diff"), { recursive: true });
    await assert.rejects(access(join(isolatedRoot, "node_modules", "@earendil-works", "pi-tui")));
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: isolatedRoot,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(isolatedRoot, "dist", "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    const command = extension.commands.get("codex-compact");
    assert.ok(command);
    const { ctx } = createMockContext({ cwd: isolatedRoot, mode: "tui" });
    await assert.doesNotReject(() => command.handler("", ctx));
    loaded.runtime.getAllTools = () => [];
    loaded.runtime.getActiveTools = () => [];
    const tui = createTuiHarness();
    const viewerContext = createMockContext({ cwd: isolatedRoot, mode: "tui", hasUI: true, custom: tui.custom });
    for (const handler of extension.handlers.get("session_start") ?? []) {
      await handler({ type: "session_start" }, viewerContext.ctx);
    }
    const scratchpad = extension.commands.get("scratchpad");
    assert.ok(scratchpad);
    const running = scratchpad.handler("show", viewerContext.ctx);
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    tui.press("tui.select.cancel");
    await running;
    assert.match(frame, /No scratchpad notes/);
    assert.deepEqual(viewerContext.notifications, []);
    for (const handler of extension.handlers.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown" }, viewerContext.ctx);
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(buildRoot, { force: true, recursive: true });
    await rm(isolatedRoot, { force: true, recursive: true });
  }
});
