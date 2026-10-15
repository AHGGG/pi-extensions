import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { resolveRoot } from "../src/files.js";
import { selectDiagnosticRoutes, selectFixRoute } from "../src/routes.js";
import { runDiagnostics, runFix } from "../src/runner.js";
import { fixture } from "./lifecycle-support.js";

for (const root of [undefined, "", "  ", ".", "nested", " nested "]) {
  test(`root helper, routes, and runners use an explicit cwd for ${JSON.stringify(root)}`, async () => {
    const f = fixture();
    const workspace = path.join(f.root, "workspace");
    const nested = path.join(workspace, "nested");
    mkdirSync(workspace);
    mkdirSync(nested);
    const target = root?.trim() === "nested" ? nested : workspace;
    const file = path.join(target, "main.go");
    writeFileSync(file, "package session\n");
    const ctx = { ...f.ctx, cwd: workspace };
    vi.spyOn(process, "cwd").mockReturnValue(f.root);
    try {
      assert.equal(resolveRoot(workspace, root), target);
      assert.equal(resolveRoot(workspace, f.root), f.root);
      assert.throws(() => resolveRoot(workspace, "missing"), /Workspace root does not exist/);
      assert.throws(
        () => resolveRoot(workspace, path.relative(workspace, file)),
        /Expected workspace root to be a directory/,
      );
      const diagnostics = selectDiagnosticRoutes(workspace, [f.adapter], { root, paths: ["main.go"] }, 50);
      assert.equal(diagnostics.root, target);
      assert.deepEqual(diagnostics.routes[0].files, [file]);
      assert.equal(selectFixRoute(workspace, [f.adapter], { root, path: "main.go" }).root, target);
      const result = await f.track(
        runDiagnostics(f.adapter, { root, paths: ["main.go"] }, 1_000, f.controller.signal, ctx, "lsp"),
      );
      assert.equal((result.details as { root: string }).root, target);
      await f.track(runFix(f.adapter, { root, path: "main.go", write: true }, 1_000, f.controller.signal, ctx, "lsp"));
      assert.equal(readFileSync(file, "utf8"), "// fixed\npackage session\n");
      assert.equal(readFileSync(f.file, "utf8"), "package main\n");
    } finally {
      await f.dispose();
      vi.restoreAllMocks();
    }
  });
}

for (const kind of ["diagnostics", "fix"] as const) {
  for (const rootCase of ["omitted", "blank", "relative", "absolute"] as const) {
    test(`${kind}: ${rootCase} root follows the session, not the process cwd`, async () => {
      const f = fixture();
      const agentDir = path.join(f.root, "agent");
      const workspace = path.join(f.root, "workspace");
      const nested = path.join(workspace, "nested");
      const external = path.join(f.root, "external");
      for (const dir of [agentDir, workspace, nested, external]) mkdirSync(dir);
      const target = rootCase === "absolute" ? external : rootCase === "relative" ? nested : workspace;
      const file = path.join(target, "main.go");
      writeFileSync(file, "package session\n");
      // The launch copy makes incorrect selection succeed silently on the baseline.
      vi.spyOn(process, "cwd").mockReturnValue(f.root);
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      vi.resetModules();
      writeFileSync(
        path.join(agentDir, "pi-lsp.json"),
        JSON.stringify({
          timeout: 1_000,
          servers: {
            fixture: {
              command: [f.adapter.defaultCommand.command, ...f.adapter.defaultCommand.args],
              extensions: [".go"],
              env: f.adapter.env,
            },
          },
        }),
      );
      const { default: lsp } = await import("../src/pi-lsp.js");
      const mock = createMockPi();
      lsp(mock.pi);
      const tool = mock.tools.find((tool) => tool.name === `lsp_${kind}`);
      assert.ok(tool);
      const launch = createMockContext({ cwd: f.root }).ctx;
      const session = createMockContext({ cwd: workspace }).ctx;
      const root =
        rootCase === "omitted"
          ? {}
          : { root: rootCase === "blank" ? "  " : rootCase === "relative" ? "nested" : target };
      try {
        for (const handler of mock.events.get("session_start") ?? []) {
          await handler({ type: "session_start", reason: "startup" }, launch);
        }
        for (const handler of mock.events.get("session_shutdown") ?? []) {
          await handler({ type: "session_shutdown", reason: "resume" }, launch);
        }
        for (const handler of mock.events.get("session_start") ?? []) {
          await handler({ type: "session_start", reason: "resume" }, session);
        }
        await f.track(
          (tool.execute as (...args: unknown[]) => Promise<unknown>)(
            "test",
            { path: "main.go", paths: ["main.go"], server: "fixture", write: kind === "fix", ...root },
            f.controller.signal,
            undefined,
            session,
          ),
        );
        const events = f.events() as Array<{
          method: string;
          cwd?: string;
          params?: { rootUri?: string; textDocument?: { uri: string; text: string } };
        }>;
        assert.equal(events.find((event) => event.method === "ready")?.cwd, realpathSync(target));
        assert.equal(
          events.find((event) => event.method === "initialize")?.params?.rootUri,
          pathToFileURL(`${target}${path.sep}`).href,
        );
        const opened = events.find((event) => event.method === "textDocument/didOpen")?.params?.textDocument;
        assert.equal(opened?.uri, pathToFileURL(file).href);
        assert.equal(opened?.text, "package session\n");
        assert.equal(readFileSync(file, "utf8"), kind === "fix" ? "// fixed\npackage session\n" : "package session\n");
        assert.equal(readFileSync(f.file, "utf8"), "package main\n");
      } finally {
        for (const handler of mock.events.get("session_shutdown") ?? []) {
          await handler({ type: "session_shutdown", reason: "quit" }, session);
        }
        await f.dispose();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    });
  }
}
