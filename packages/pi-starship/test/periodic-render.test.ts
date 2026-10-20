import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { StarshipCommandOptions } from "../src/commands.js";
import type { ThemeColors } from "../src/format/theme-colors.js";
import type { GitSnapshot, WorkspaceSnapshot } from "../src/modules/types.js";

const readers = vi.hoisted(() => ({
  git: vi.fn<(...args: unknown[]) => Promise<GitSnapshot | undefined>>(),
  workspace: vi.fn<(...args: unknown[]) => Promise<WorkspaceSnapshot>>(),
  command: vi.fn(),
}));
vi.mock("../src/modules/git/runtime.js", async (original) => ({
  ...(await original<object>()),
  readGitSnapshot: readers.git,
}));
vi.mock("../src/runtime/workspace.js", async (original) => ({
  ...(await original<object>()),
  collectWorkspaceSnapshot: readers.workspace,
}));
vi.mock("../src/commands.js", () => ({ handleStarshipCommand: readers.command }));

// Resolve the cold dependency graph outside individual 5-second test deadlines.
const importDirectory = mkdtempSync(join(tmpdir(), "starship-periodic-import-"));
const importEnvironment = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = importDirectory;
try {
  await import("../src/pi-starship.js");
} finally {
  if (importEnvironment === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = importEnvironment;
  rmSync(importDirectory, { recursive: true, force: true });
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function setup(document: string, width = 80, initialColors?: ThemeColors) {
  const directory = mkdtempSync(join(tmpdir(), "starship-periodic-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, "pi-starship.toml"), document);
  vi.resetModules();
  const { default: piStarship } = await import("../src/pi-starship.js");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
  readers.git.mockResolvedValue(undefined);
  readers.workspace.mockResolvedValue({ modules: {} });
  const mock = createMockPi();
  piStarship(mock.pi);
  const context = createMockContext({ mode: "tui" });
  const emit = async (name: string, ctx = context.ctx) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
  };
  await emit("session_start");
  const unsubscribe = vi.fn();
  let branchChange = () => {};
  const render = vi.fn();
  type Factory = Parameters<ExtensionContext["ui"]["setFooter"]>[0];
  let colors = initialColors;
  const footer = (context.footer as NonNullable<Factory>)(
    { requestRender: render } as never,
    {
      get colors() {
        return colors;
      },
    } as never,
    {
      getGitBranch: () => null,
      getAvailableProviderCount: () => 0,
      getExtensionStatuses: () => new Map(),
      onBranchChange: (callback) => {
        branchChange = callback;
        return unsubscribe;
      },
    },
  );
  cleanups.push(async () => {
    footer.dispose?.();
    await emit("session_shutdown");
  });
  await vi.advanceTimersByTimeAsync(0);
  footer.render(width);
  render.mockClear();
  const entries = vi.spyOn((context.ctx as ExtensionContext).sessionManager, "getEntries");
  const branch = vi.spyOn((context.ctx as ExtensionContext).sessionManager, "getBranch");
  return {
    settingsPath: join(directory, "pi-starship.toml"),
    mock,
    context,
    emit,
    footer,
    render,
    entries,
    branch,
    unsubscribe,
    branchChange: () => branchChange(),
    setThemeColors(next: ThemeColors) {
      colors = next;
      footer.invalidate();
    },
  };
}

test("unchanged periodic collectors do not request renders or scan session history", async () => {
  const h = await setup("format = '$git_branch$package'\n");
  const initial = readers.git.mock.calls.length;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(readers.git.mock.calls.length).toBe(initial + 3);
  expect(readers.workspace.mock.calls.at(-1)?.[0]).toMatchObject({ reason: "periodic" });
  expect(h.render).not.toHaveBeenCalled();
  expect(h.entries).not.toHaveBeenCalled();
  expect(h.branch).not.toHaveBeenCalled();
});

test.each([
  ["format = '$time'\n", 80, true],
  ["format = '$time'\n[time]\ndisabled = true\n", 80, false],
  ["format = 'static'\n", 80, false],
  ["format = '$time'\n[time]\nformat = '$symbol'\n", 80, false],
  ["format = '($time$git_branch)'\n", 80, true],
  ["format = '$time'\n", 0, false],
  ["format = '$all'\n[github_pr]\ndisabled = true\n", 80, true],
  ["format = '$all$time'\n[time]\ndisabled = true\n[github_pr]\ndisabled = true\n", 80, false],
])("clock output comparison: %s width %i", async (document, width, changes) => {
  const h = await setup(document, width);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).toHaveBeenCalledTimes(changes ? 1 : 0);
  expect(h.entries).not.toHaveBeenCalled();
  expect(h.branch).not.toHaveBeenCalled();
  if (changes) {
    expect(h.footer.render(width).join("\n")).toContain("12:01");
    h.render.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.render).not.toHaveBeenCalled();
  }
});

test("changed and cleared workspace snapshots publish without an immediate timer redraw", async () => {
  const h = await setup("format = '$package'\n");
  let resolve!: (value: WorkspaceSnapshot) => void;
  readers.workspace.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).not.toHaveBeenCalled();
  resolve({ modules: { package: { version: "v1.0.0" } } });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.render).toHaveBeenCalledTimes(1);
  expect(h.footer.render(80).join("\n")).toContain("v1.0.0");
  h.render.mockClear();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).toHaveBeenCalledTimes(1);
  expect(h.footer.render(80).join("\n")).not.toContain("v1.0.0");
});

test("clock-bearing previews and preview exit use the effective rendered configuration", async () => {
  const h = await setup("format = 'static'\n");
  let options!: StarshipCommandOptions;
  readers.command.mockImplementation((_args, _ctx, value) => {
    options = value;
  });
  await h.mock.commands.get("starship")?.handler("", h.context.ctx);
  const { normalizeConfig } = await import("../src/config.js");
  const preview = { ...options.getLoaded(), ...normalizeConfig({ format: "$time" }) };
  options.preview?.(preview, h.context.ctx as ExtensionCommandContext);
  h.footer.render(80);
  h.render.mockClear();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.render).toHaveBeenCalledTimes(1);
  options.preview?.(undefined, h.context.ctx as ExtensionCommandContext);
  h.footer.render(80);
  h.render.mockClear();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.render).not.toHaveBeenCalled();
});

test("clock comparison follows wall-clock rollback and fresh host renders", async () => {
  const h = await setup("format = '$time'\n");
  vi.setSystemTime(new Date(2025, 11, 31, 23, 59, 0));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).toHaveBeenCalledTimes(1);
  expect(h.footer.render(20).join("\n")).toContain("23:59");
  h.footer.invalidate();
  h.footer.render(0);
  h.render.mockClear();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).not.toHaveBeenCalled();
  expect(h.footer.render(80).join("\n")).toContain("00:00");
});

test("footer and preview renders read the current callback theme after invalidation", async () => {
  const first = { accent: rgbColor(1, 2, 3) } as ThemeColors;
  const next = { accent: rgbColor(4, 5, 6) } as ThemeColors;
  const document = "format = '[current](pi:accent)'\n";
  const h = await setup(document, 80, first);
  let options!: StarshipCommandOptions;
  readers.command.mockImplementation((_args, _ctx, value) => {
    options = value;
  });
  await h.mock.commands.get("starship")?.handler("", h.context.ctx);
  const config = options.getLoaded();
  expect(h.footer.render(80).join("\n")).toContain("38;2;1;2;3");
  expect(options.renderPreview?.(config, 80, h.context.ctx).join("\n")).toContain("38;2;1;2;3");

  h.setThemeColors(next);
  for (const width of [0, 1, 3, 80]) {
    const lines = h.footer.render(width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    if (width > 0) expect(lines.join("\n")).toContain("38;2;4;5;6");
    expect(lines.join("\n")).not.toContain("38;2;1;2;3");
  }
  expect(options.renderPreview?.(config, 80, h.context.ctx).join("\n")).toContain("38;2;4;5;6");
  const { normalizeConfig } = await import("../src/config.js");
  const preview = { ...config, ...normalizeConfig({ format: "[preview](pi:accent)" }) };
  options.preview?.(preview, h.context.ctx as ExtensionCommandContext);
  expect(h.footer.render(80).join("\n")).toContain("38;2;4;5;6");
  options.preview?.(undefined, h.context.ctx as ExtensionCommandContext);
  expect(h.footer.render(80).join("\n")).toContain("38;2;4;5;6");
  expect(readFileSync(h.settingsPath, "utf8")).toBe(document);
});

test("periodic comparison uses current theme colors instead of the previous render's colors", async () => {
  const first = { accent: rgbColor(1, 2, 3) } as ThemeColors;
  const next = { accent: rgbColor(4, 5, 6) } as ThemeColors;
  const h = await setup("format = '$time'\n[time]\nstyle = 'pi:accent'\n", 80, first);
  h.setThemeColors(next);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.render).toHaveBeenCalledTimes(1);
  expect(h.footer.render(80).join("\n")).toContain("38;2;4;5;6");
  h.render.mockClear();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).not.toHaveBeenCalled();
});

test("failed refreshes keep an already empty footer quiet", async () => {
  const h = await setup("format = '$git_branch$package'\n");
  readers.git.mockRejectedValue(new Error("unavailable"));
  readers.workspace.mockRejectedValue(new Error("unavailable"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.render).not.toHaveBeenCalled();
});

test("changed Git snapshots redraw, equal results do not, and missing results clear output", async () => {
  const h = await setup("format = '$git_branch'\n");
  const { parseGitStatusPorcelain } = await import("../src/pi-starship.js");
  readers.git.mockResolvedValue({
    branch: { name: "changed", detached: false },
    status: parseGitStatusPorcelain(""),
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).toHaveBeenCalledTimes(1);
  expect(h.footer.render(80).join("\n")).toContain("changed");
  h.render.mockClear();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).not.toHaveBeenCalled();
  readers.git.mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).toHaveBeenCalledTimes(1);
  expect(h.footer.render(80).join("\n")).not.toContain("changed");
});

test.each(["dispose", "shutdown", "replace"])("pending periodic reads cannot render after %s", async (action) => {
  const h = await setup("format = '$package$time'\n");
  let resolve!: (snapshot: WorkspaceSnapshot) => void;
  let signal!: AbortSignal;
  readers.workspace.mockImplementationOnce((input) => {
    signal = (input as { signal: AbortSignal }).signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.render).not.toHaveBeenCalled();
  const replacementRender = vi.fn();
  let replacementOutput = () => "";
  if (action === "replace") {
    const replacement = createMockContext({ mode: "tui" });
    await h.emit("session_start", replacement.ctx);
    type Factory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
    const footer = (replacement.footer as Factory)({ requestRender: replacementRender } as never, {} as never, {
      getGitBranch: () => null,
      getAvailableProviderCount: () => 0,
      getExtensionStatuses: () => new Map(),
      onBranchChange: () => () => {},
    });
    replacementOutput = () => footer.render(80).join("\n");
    footer.render(80);
    cleanups.push(async () => {
      footer.dispose?.();
      await h.emit("session_shutdown", replacement.ctx);
    });
    // Disposing the old footer must not stop the replacement's controller.
    h.footer.dispose?.();
  } else if (action === "shutdown") await h.emit("session_shutdown");
  else h.footer.dispose?.();
  expect(signal.aborted).toBe(true);
  resolve({ modules: { package: { version: "stale" } } });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.render).not.toHaveBeenCalled();
  if (action === "replace") {
    expect(replacementRender).toHaveBeenCalledTimes(1);
    expect(replacementOutput()).not.toContain("stale");
    replacementRender.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replacementRender).toHaveBeenCalledTimes(1); // live clock, not stale package
  } else {
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.render).not.toHaveBeenCalled();
  }
});

test("branch changes retain immediate redraw and repeated disposal releases periodic work", async () => {
  const h = await setup("format = '$time'\n");
  h.branchChange();
  expect(h.render).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  h.footer.dispose?.();
  h.footer.dispose?.();
  expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  h.render.mockClear();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(h.render).not.toHaveBeenCalled();
});
