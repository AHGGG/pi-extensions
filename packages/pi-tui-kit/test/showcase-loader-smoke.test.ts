import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";

test("Pi Jiti loads the repository showcase and opens its lazy Kit menu", async (t) => {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), "kit-showcase-smoke-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  t.onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(agentDir, { recursive: true, force: true });
  });
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [path.resolve("packages/pi-tui-kit/scripts/showcase/extension.ts")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  t.onTestFinished(() => loaded.runtime.invalidate("showcase smoke complete"));
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  const command = loaded.extensions[0].commands.get("tui-kit-showcase");
  expect(command).toBeDefined();
  if (!command) return;

  const tui = createTuiHarness({ width: 80, rows: 30 });
  const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = command.handler("", ctx);
  try {
    await tui.waitForOpen();
    expect(tui.render().join("\n")).toContain("Pi TUI Kit Showcase");
    tui.press("ctrl+c");
    await running;
    expect(tui.isOpen).toBe(false);
  } finally {
    tui.dispose();
  }
});
