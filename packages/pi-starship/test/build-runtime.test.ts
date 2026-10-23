import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  type ExtensionCommandContext,
  type ExtensionContext,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { listFiles, registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-starship",
  forbiddenEagerInputs: [
    "src/commands.ts",
    "src/command-inspector.ts",
    "src/command-preset-picker.ts",
    "src/command-preview.ts",
    "src/command-profiles.ts",
    "src/profile-store.ts",
    "src/command-commit.ts",
    "src/presets/catalog.ts",
    "src/runtime/cloud.ts",
    "src/runtime/deployment.ts",
    "src/runtime/development.ts",
    "src/runtime/execution.ts",
    "src/runtime/languages.ts",
    "src/runtime/package.ts",
  ],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit", "yaml"],
  matchExternalSubpaths: false,
  includeDynamicExternals: true,
});

test("generated command registration maps to the authoritative source", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-starship-build-test-"));
  try {
    const first = join(root, "first");
    await builder.buildRuntime({ outputDirectory: first });

    const entrySource = await readFile(join(first, "index.ts"), "utf8");
    const generatedLine = entrySource.split("\n").findIndex((line) => line.includes('pi.registerCommand("starship"'));
    assert.notEqual(generatedLine, -1);
    const sourceMap = new SourceMap(JSON.parse(await readFile(join(first, "index.ts.map"), "utf8")));
    const mapped = sourceMap.findEntry(generatedLine, 0);
    assert.ok("originalSource" in mapped, "expected generated entry to map to source");
    assert.match(mapped.originalSource ?? "", /src\/pi-starship\.ts$/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated runtime refuses to resolve a package at call time", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-starship-build-test-"));
  try {
    const output = join(root, "dist");
    await builder.buildRuntime({ outputDirectory: output });
    await assert.doesNotReject(builder.validateGeneratedFiles(output));

    // What `createRequire(import.meta.url)` compiles to. A compiled Pi binary
    // resolves the package it returns against the binary's embedded graph
    // rather than the directory the package was installed into, so the package
    // is not found there (#1307). The bundler renames the binding, so the
    // factory call is what the gate looks for.
    const chunkName = (await listFiles(output)).find((path) => path.startsWith("chunks/") && path.endsWith(".ts"));
    assert.ok(chunkName);
    const chunkPath = join(output, chunkName);
    const chunkSource = await readFile(chunkPath, "utf8");
    await writeFile(
      chunkPath,
      `${chunkSource}\nvar require2 = createRequire(import.meta.url);\nvar late = require2("smol-toml");\n`,
      "utf8",
    );
    await assert.rejects(
      builder.validateGeneratedFiles(output),
      new RegExp(`resolves a package at call time in ${chunkName.replace(".", "\\.")}`, "u"),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-starship-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    // The settings file is the representative boundary: reading it is the only
    // thing the runtime needs an external package for.
    await writeFile(
      join(agentDir, "pi-starship.toml"),
      'format = "[theme](pi:accent)$directory"\n[directory]\nstyle = "fg:pi:selectedBg bg:pi:accent"\n',
      "utf8",
    );
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
    assert.ok(extension?.commands.has("starship"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));
    assert.ok(extension);
    loaded.runtime.getThinkingLevel = () => "off";
    const tui = createTuiHarness({ width: 80, rows: 24 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const emit = async (name: "session_start" | "session_shutdown") => {
      const event = name === "session_start" ? { type: name, reason: "startup" } : { type: name };
      for (const handler of extension.handlers.get(name) ?? []) await handler(event, context.ctx as ExtensionContext);
    };
    await emit("session_start");
    try {
      const command = extension.commands.get("starship");
      assert.ok(command);
      await command.handler("status", { ...(context.ctx as ExtensionCommandContext), mode: "rpc" });
      assert.match(context.notifications.at(-1)?.message ?? "", /source: user[\s\S]*warnings: none/u);
      // Resolve and exercise the generated command/profile chunks through Jiti, not Vitest imports.
      const running = command.handler("", context.ctx);
      try {
        await tui.waitForOpen();
        tui.press("end");
        assert.match(tui.render().join("\n"), /→ Profiles/u);
        tui.press("tui.select.confirm");
        await tui.waitForOpen();
        const profileFrame = tui.render().join("\n");
        tui.press("ctrl+c");
        await running;
        assert.match(profileFrame, /Profiles/u);
        assert.match(profileFrame, /Save current/u);
      } finally {
        tui.dispose();
        await running;
      }
    } finally {
      await emit("session_shutdown");
      loaded.runtime.invalidate("generated profile smoke complete");
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
