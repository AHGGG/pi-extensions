import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test, vi } from "vitest";

const publication = vi.hoisted(() => ({
  fail: false,
  failChmod: false,
  beforeRename: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    chmod: async (...args: Parameters<typeof original.chmod>) => {
      if (publication.failChmod) throw new Error("chmod failed");
      return original.chmod(...args);
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      await publication.beforeRename?.();
      if (publication.fail) throw new Error("rename failed");
      return original.rename(...args);
    },
  };
});

import { DEFAULT_PROGRESS_SETTINGS, loadProgressSettings, saveProgressSettings } from "../src/settings.js";

afterEach(() => {
  publication.fail = false;
  publication.failChmod = false;
  publication.beforeRename = undefined;
});

async function settingsPath(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "pi-progress-save-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "agent", "pi-progress.json");
}

test("first explicit save creates only owned overrides and reloads them", async (t) => {
  const path = await settingsPath(t);
  await loadProgressSettings(path);
  await assert.rejects(access(path));
  const saved = await saveProgressSettings({ enabled: false }, path);
  assert.deepEqual(saved, { ...DEFAULT_PROGRESS_SETTINGS, enabled: false });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: false });
  assert.deepEqual((await loadProgressSettings(path)).settings, saved);
});

test("serializes updates and preserves unknown top-level and nested fields", async (t) => {
  const path = await settingsPath(t);
  await saveProgressSettings({}, path);
  await writeFile(path, JSON.stringify({ future: { enabled: true }, widget: { enabled: false, future: "keep" } }));
  await Promise.all([
    saveProgressSettings({ enabled: true }, path),
    saveProgressSettings({ showProgress: false }, path),
    saveProgressSettings({ enabled: false }, path),
  ]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    future: { enabled: true },
    widget: { enabled: false, future: "keep" },
    enabled: false,
    showProgress: false,
  });
  assert.deepEqual((await loadProgressSettings(path)).settings, {
    ...DEFAULT_PROGRESS_SETTINGS,
    enabled: false,
    showProgress: false,
  });
});

test("protects malformed and invalid documents and rejects invalid updates", async (t) => {
  const path = await settingsPath(t);
  await saveProgressSettings({}, path);
  for (const text of ["{invalid", '{"enabled":"invalid"}', '{"widget":false}']) {
    await writeFile(path, text);
    await assert.rejects(saveProgressSettings({ enabled: false }, path), /invalid settings/u);
    assert.equal(await readFile(path, "utf8"), text);
  }
  await writeFile(path, "{}");
  await assert.rejects(saveProgressSettings({ maxVisibleItems: 51 }, path), /Invalid settings update/u);
  assert.equal(await readFile(path, "utf8"), "{}");
});

test("failed publication preserves the previous file and does not poison the queue", async (t) => {
  const path = await settingsPath(t);
  await saveProgressSettings({ enabled: true }, path);
  const before = await readFile(path);
  publication.fail = true;
  await assert.rejects(saveProgressSettings({ enabled: false }, path), /rename failed/u);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(join(path, "..")), ["pi-progress.json"]);
  publication.fail = false;
  await saveProgressSettings({ showProgress: false }, path);
  assert.equal((await loadProgressSettings(path)).settings.showProgress, false);
});

test("queued reload waits for publication and sees the saved settings", async (t) => {
  const path = await settingsPath(t);
  let ready!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  publication.beforeRename = async () => {
    ready();
    await gate;
  };
  const saving = saveProgressSettings({ enabled: false }, path);
  await reached;
  const loading = loadProgressSettings(path);
  release();
  await saving;
  assert.equal((await loading).settings.enabled, false);
});

test("cancellation before a save leaves the parent absent", async (t) => {
  const path = await settingsPath(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(saveProgressSettings({ enabled: false }, path, controller.signal), /abort/iu);
  await assert.rejects(access(join(path, "..")));
});

test("preserves existing POSIX file permissions", async (t) => {
  if (process.platform === "win32") return;
  const path = await settingsPath(t);
  await saveProgressSettings({ enabled: false }, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await saveProgressSettings({ enabled: true }, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("preserves shared POSIX modes under a stricter process umask", async (t) => {
  if (process.platform === "win32") return;
  const path = await settingsPath(t);
  await saveProgressSettings({}, path);
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `import { chmod, stat } from "node:fs/promises";
     const { saveProgressSettings } = await import(process.argv[1]);
     const path = process.argv[2];
     process.umask(0o077);
     const modes = [];
     for (const mode of [0o664, 0o640, 0o600]) {
       await chmod(path, mode);
       await saveProgressSettings({ enabled: false }, path);
       modes.push((await stat(path)).mode & 0o777);
     }
     await saveProgressSettings({}, path + ".new");
     modes.push((await stat(path + ".new")).mode & 0o777);
     console.log(JSON.stringify(modes));`,
    new URL("../src/settings.ts", import.meta.url).href,
    path,
  ]);
  assert.deepEqual(JSON.parse(stdout), [0o664, 0o640, 0o600, 0o600]);
});

test("chmod failure preserves the previous document and leaves the queue usable", async (t) => {
  const path = await settingsPath(t);
  await saveProgressSettings({ enabled: true }, path);
  const before = await readFile(path);
  const mode = (await stat(path)).mode & 0o777;
  publication.failChmod = true;
  await assert.rejects(saveProgressSettings({ enabled: false }, path), /chmod failed/u);
  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(path)).mode & 0o777, mode);
  assert.deepEqual(await readdir(join(path, "..")), ["pi-progress.json"]);
  publication.failChmod = false;
  await saveProgressSettings({ enabled: false }, path);
  assert.equal((await loadProgressSettings(path)).settings.enabled, false);
});
