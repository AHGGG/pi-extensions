#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";

assert.notEqual(process.platform, "win32", "This benchmark requires POSIX PATH-based browser-launch suppression");
const [name, kind = "package", ...extra] = process.argv.slice(2);
assert(
  ["inspect", "notify"].includes(name),
  "Usage: benchmark-inspect-notify-first-use.mjs <inspect|notify> [source|package]",
);
assert(
  ["source", "package"].includes(kind) && extra.length === 0,
  "Expected source or package, with no trailing arguments",
);
const directory = await mkdtemp(join(tmpdir(), "pi-first-use-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousPath = process.env.PATH;
process.env.PI_CODING_AGENT_DIR = directory;
let harness;
let extension;
let context;
const emit = async (name) => {
  for (const handler of extension.handlers.get(name) ?? []) await handler({}, context);
};
try {
  const entry = resolve(`packages/pi-${name}${kind === "source" ? "/src/index.ts" : ""}`);
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [entry],
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  extension = loaded.extensions[0];
  // This model-free harness supplies only the read-only host actions the viewer needs.
  loaded.runtime.getAllTools = () => [];
  loaded.runtime.getActiveTools = () => [];
  harness = createTuiHarness();
  let url;
  context = {
    cwd: directory,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    sessionManager: SessionManager.inMemory(directory),
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: directory, skills: [] }),
    ui: {
      custom: harness.custom,
      confirm: async () => true,
      notify: (message) => {
        url = message.match(/http:\/\/127\.0\.0\.1:[^\s]+/u)?.[0] ?? url;
      },
      onTerminalInput: () => () => {},
    },
  };
  await emit("session_start");
  // Never launch a desktop browser; no user settings or notification destinations are loaded.
  process.env.PATH = join(directory, "no-executables");
  const startedAt = performance.now();
  let firstUseMs;
  if (name === "notify") {
    const running = extension.commands.get("notify").handler("", context);
    await harness.waitForOpen();
    firstUseMs = performance.now() - startedAt;
    harness.press("ctrl+c");
    await running;
  } else {
    await extension.commands.get("inspect").handler("", context);
    assert.ok(url, "Viewer did not open");
    const origin = new URL(url).origin;
    for (const route of ["/", "/app.js", "/app.css"]) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 200);
      assert((await response.text()).length > 0);
    }
    firstUseMs = performance.now() - startedAt;
    await extension.commands.get("inspect").handler("stop", context);
  }
  console.log(JSON.stringify({ entry, name, kind, firstUseMs }));
} finally {
  try {
    if (extension && context) await emit("session_shutdown");
  } finally {
    harness?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}
