import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { generateImageRequest } from "../src/image-client.js";
import type { ImagegenMenuOwner, showImagegenMenu } from "../src/menu.js";

const IMAGE = "UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAEM1VICIC0f9oYAIA";
type Factory = typeof import("../src/codex-imagegen.js")["createImagegenExtension"];
type Overrides = NonNullable<Parameters<Factory>[0]>;
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(options: { document?: unknown; mode?: ExtensionContext["mode"]; overrides?: Overrides } = {}) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "pi-imagegen-extension-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  if (options.document !== undefined) {
    await fs.mkdir(agentDir);
    await fs.writeFile(join(agentDir, "pi-codex-imagegen.json"), JSON.stringify(options.document));
  }
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  // getAgentDir is deliberately evaluated at session_start, never at module load.
  const { createImagegenExtension } = await import("../src/codex-imagegen.js");
  const mock = createMockPi();
  const nativeSettings = { images: { autoResize: false, blockImages: false }, terminal: { showImages: false } };
  const api = Object.assign(mock.rawPi, { getSettings: () => nativeSettings }) as unknown as ExtensionAPI;
  const request = vi.fn<typeof generateImageRequest>(async () => ({ base64: IMAGE, requestId: "fixture-request" }));
  let owner: ImagegenMenuOwner | undefined;
  const menu = vi.fn<typeof showImagegenMenu>(async (_ctx, value) => {
    owner = value;
  });
  createImagegenExtension({ request, menu, ...options.overrides })(api);
  const context = createMockContext({ cwd: root, mode: options.mode ?? "tui" });
  const ctx = context.ctx as ExtensionCommandContext;
  const emit = async (type: "session_start" | "session_shutdown", target: ExtensionContext = ctx) => {
    for (const handler of mock.events.get(type) ?? []) await handler({ type, reason: "quit" }, target);
  };
  const command = (args = "") => {
    const registered = mock.commands.get("imagegen");
    if (!registered) throw new Error("Missing imagegen command");
    return registered.handler(args, ctx);
  };
  const tool = () => mock.tools.at(-1) as unknown as ToolDefinition;
  const execute = (params = { prompt: "A small red cube" }, signal?: AbortSignal) =>
    tool().execute("image-call", params, signal, undefined, ctx as never);
  const getOwner = async () => {
    await command();
    if (!owner) throw new Error("Missing menu owner");
    return owner;
  };
  return {
    ...mock,
    ...context,
    api,
    ctx,
    root,
    agentDir,
    request,
    nativeSettings,
    emit,
    command,
    tool,
    execute,
    getOwner,
  };
}

it("registers a hidden tool and one command without resolving auth or creating files", async () => {
  const h = await setup();
  expect([...h.commands.keys()]).toEqual(["imagegen"]);
  expect(h.tool().exposure).toBe("hidden");
  expect(h.request).not.toHaveBeenCalled();
  await expect(fs.stat(h.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
  await h.emit("session_start");
  await expect(fs.stat(h.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(h.execute()).rejects.toThrow(/disabled/);
  expect(h.request).not.toHaveBeenCalled();
  await h.emit("session_shutdown");
});

it("saves the original bytes under the custom agent directory with structured tool details", async () => {
  const h = await setup({ document: { toolEnabled: true } });
  await h.emit("session_start");
  expect(h.tool().exposure).toBe("direct");
  const result = await h.execute({ prompt: "  unmodified prompt  ", filename: "cube.webp" } as never);
  const details = result.details as { path: string; requestId: string };
  expect(details.path).toBe(join(h.agentDir, "pi-codex-imagegen", "cube.webp"));
  expect(await fs.readFile(details.path)).toEqual(Buffer.from(IMAGE, "base64"));
  expect(result.structuredContent).toEqual(result.details);
  expect(details.requestId).toBe("fixture-request");
  expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/webp", data: IMAGE });
  expect(h.request.mock.calls[0]?.[1]).toEqual({ prompt: "  unmodified prompt  ", transparentBackground: false });
  expect(h.statuses.get("codex-imagegen")).toBeUndefined();
  await h.emit("session_shutdown");
});

it("manual generation remains available with the tool hidden and appends without a model turn", async () => {
  const h = await setup();
  await h.emit("session_start");
  const owner = await h.getOwner();
  await owner.generate("A landscape", owner.signal);
  expect(h.tool().exposure).toBe("hidden");
  expect(h.sentUserMessages).toEqual([]);
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0]?.options).toEqual({ triggerTurn: false });
  expect(h.sentMessages[0]?.message).toMatchObject({ customType: "codex-imagegen:result", display: true });
  await h.emit("session_shutdown");
});

it("manual publication honors Pi's image-block setting", async () => {
  const h = await setup();
  await h.emit("session_start");
  h.nativeSettings.images.blockImages = true;
  const owner = await h.getOwner();
  await owner.generate("An image", owner.signal);
  const message = h.sentMessages[0]?.message as { content: { type: string }[] };
  expect(message.content.map((block) => block.type)).toEqual(["text"]);
  await h.emit("session_shutdown");
});

it.each(["../escape.png", "bad\nname.png"])(
  "rejects an unsafe filename before authentication or HTTP: %j",
  async (filename) => {
    const h = await setup({ document: { toolEnabled: true } });
    await h.emit("session_start");
    await expect(h.execute({ prompt: "image", filename } as never)).rejects.toThrow();
    expect(h.request).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  },
);

it("preflights symlink roots and an occupied explicit filename before consuming quota", async () => {
  const h = await setup({ document: { toolEnabled: true } });
  await h.emit("session_start");
  const owner = await h.getOwner();
  const outside = join(h.root, "outside");
  await fs.mkdir(outside);
  const linked = join(h.root, "linked");
  await fs.symlink(outside, linked, "dir");
  await owner.saveSettings({ outputDir: linked });
  await expect(h.execute()).rejects.toThrow(/symlinks/);
  await owner.saveSettings({ outputDir: outside });
  await fs.writeFile(join(outside, "occupied.webp"), "user file");
  await expect(h.execute({ prompt: "image", filename: "occupied.webp" } as never)).rejects.toThrow(/already exists/);
  expect(await fs.readFile(join(outside, "occupied.webp"), "utf8")).toBe("user file");
  expect(h.request).not.toHaveBeenCalled();
  await h.emit("session_shutdown");
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([undefined, "image", "image.webp"])(
  "rejects an unsearchable output directory before consuming quota: %j",
  async (filename) => {
    const h = await setup({ document: { toolEnabled: true } });
    await h.emit("session_start");
    const owner = await h.getOwner();
    const directory = join(h.root, "unsearchable");
    await fs.mkdir(directory);
    await owner.saveSettings({ outputDir: directory });
    await fs.chmod(directory, 0o600);
    try {
      await expect(h.execute({ prompt: "image", filename } as never)).rejects.toMatchObject({ code: "EACCES" });
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      await fs.chmod(directory, 0o700);
      await h.emit("session_shutdown");
    }
  },
);

it.each(["images\n", "images\u202e", "images\ud800"])(
  "uses one output path policy for settings and requests: %j",
  async (outputDir) => {
    const h = await setup({ document: { toolEnabled: true, outputDir } });
    await h.emit("session_start");
    expect(h.tool().exposure).toBe("hidden");
    const owner = await h.getOwner();
    await expect(owner.saveSettings({ outputDir })).rejects.toThrow(/Invalid/);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.notifications.length).toBeGreaterThan(0);
    await h.emit("session_shutdown");
  },
);

it("applies setting changes immediately, rejects busy changes, and guards captured tool implementations", async () => {
  const h = await setup();
  await h.emit("session_start");
  const owner = await h.getOwner();
  await owner.saveSettings({ toolEnabled: true, transparentBackground: true });
  const enabled = h.tool();
  await h.execute();
  expect(h.request.mock.calls[0]?.[1].transparentBackground).toBe(true);
  await owner.saveSettings({ toolEnabled: false });
  expect(h.tool().exposure).toBe("hidden");
  await expect(
    enabled.execute("stale-tool", { prompt: "image" }, undefined, undefined, h.ctx as never),
  ).rejects.toThrow(/disabled/);
  const idle = h.ctx.isIdle;
  h.ctx.isIdle = () => false;
  await expect(owner.saveSettings({ toolEnabled: true })).rejects.toThrow(/idle/);
  h.ctx.isIdle = idle;
  await h.emit("session_shutdown");
});

it("rolls back partial tool-registration failure together with settings publication", async () => {
  const h = await setup();
  await h.emit("session_start");
  const owner = await h.getOwner();
  const register = h.rawPi.registerTool;
  let fail = true;
  h.rawPi.registerTool = (tool) => {
    register(tool);
    if ((tool as ToolDefinition).exposure === "direct" && fail) {
      fail = false;
      throw new Error("runtime failure");
    }
  };
  await expect(owner.saveSettings({ toolEnabled: true })).rejects.toThrow();
  expect(owner.getSettings().toolEnabled).toBe(false);
  expect(h.tool().exposure).toBe("hidden");
  await expect(fs.stat(join(h.agentDir, "pi-codex-imagegen.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await owner.saveSettings({ toolEnabled: true });
  expect(h.tool().exposure).toBe("direct");
  await h.emit("session_shutdown");
});

it("aborts a running request on session shutdown, releases busy state, and clears only its status", async () => {
  const started = deferred<void>();
  const request = vi.fn<typeof generateImageRequest>(async (_registry, _params, { signal }) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
    return { base64: IMAGE };
  });
  const h = await setup({ document: { toolEnabled: true }, overrides: { request } });
  await h.emit("session_start");
  h.statuses.set("other-extension", "untouched");
  const running = h.execute();
  const failed = expect(running).rejects.toThrow();
  await started.promise;
  await expect(h.execute()).rejects.toThrow(/already running/);
  await h.emit("session_shutdown");
  await failed;
  expect(h.statuses.get("codex-imagegen")).toBeUndefined();
  expect(h.statuses.get("other-extension")).toBe("untouched");
  await h.emit("session_shutdown");
});

it("replaces headless sessions by manager identity even when they share the no-op UI", async () => {
  const h = await setup({ document: { toolEnabled: true }, mode: "print" });
  await h.emit("session_start");
  const oldTool = h.tool();
  const next = createMockContext({ mode: "print", cwd: h.root, ui: h.ctx.ui }).ctx as ExtensionContext;
  await h.emit("session_start", next);
  await expect(oldTool.execute("old", { prompt: "image" }, undefined, undefined, h.ctx as never)).rejects.toThrow(
    /unavailable/,
  );
  const result = await h.tool().execute("new", { prompt: "image" }, undefined, undefined, next as never);
  expect(result.content[0]?.type).toBe("text");
  await h.emit("session_shutdown", next);
});

it("revalidates a delayed response and never publishes after cancellation", async () => {
  const response = deferred<{ base64: string }>();
  const started = deferred<void>();
  const publish = vi.fn<NonNullable<Overrides["publish"]>>();
  const h = await setup({
    document: { toolEnabled: true },
    overrides: {
      request: async () => {
        started.resolve();
        return response.promise;
      },
      publish,
    },
  });
  await h.emit("session_start");
  const controller = new AbortController();
  const running = h.execute({ prompt: "image" }, controller.signal);
  const failed = expect(running).rejects.toThrow();
  await started.promise;
  controller.abort();
  response.resolve({ base64: IMAGE });
  await failed;
  expect(publish).not.toHaveBeenCalled();
  expect(h.sentMessages).toEqual([]);
  await h.emit("session_shutdown");
});

it("renderers sanitize control text and handle incomplete or historical results", async () => {
  const h = await setup();
  await h.emit("session_start");
  const theme = { fg: (_role: unknown, text: string) => text, bold: (text: string) => text } as Theme;
  const resultRenderer = h.tool().renderResult;
  if (!resultRenderer) throw new Error("Missing tool renderer");
  const rendered = resultRenderer(
    { content: [{ type: "text", text: "Sign in\x1b]0;injected\x07" }], details: undefined },
    {} as never,
    theme,
    {} as never,
  )
    .render(60)
    .join("\n");
  expect(rendered).toContain("Sign in");
  expect(rendered).not.toContain("injected");
  const renderer = h.messageRenderers.get("codex-imagegen:result");
  if (!renderer) throw new Error("Missing message renderer");
  const component = renderer({ content: "history", details: undefined }, {}, theme) as {
    render(width: number): string[];
  };
  expect(component.render(40).join("\n")).toContain("path unavailable");
  await h.emit("session_shutdown");
});
