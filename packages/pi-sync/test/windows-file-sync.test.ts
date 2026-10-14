import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { applySnapshotTransaction, recoverPendingSnapshotTransactions } from "../src/snapshot/snapshot-transaction.js";
import { withTempHome } from "./helpers.js";

const fileImage = (content: string) => `file:${createHash("sha256").update(content).digest("hex")}`;
const directoryImage = (content: string) =>
  `directory:${createHash("sha256")
    .update(JSON.stringify([["old.md", fileImage(content)]]))
    .digest("hex")}`;

/** Exercise Windows flush access requirements even when the test host is POSIX. */
async function withWindowsFileSync(run: (synced: string[]) => Promise<void>, failSuffix?: string) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  const open = fs.open.bind(fs);
  const synced: string[] = [];
  const handles: { closed: boolean }[] = [];
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const owned = { closed: false };
    handles.push(owned);
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    spies.push(
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if ((await handle.stat()).isFile()) {
          const target = String(args[0]);
          if (args[1] === "r" || (failSuffix && target.endsWith(failSuffix)))
            throw Object.assign(new Error("EPERM: operation not permitted, fsync"), {
              code: "EPERM",
              syscall: "fsync",
            });
          synced.push(target);
        }
        await sync();
      }),
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        owned.closed = true;
      }),
    );
    return handle;
  });
  try {
    await run(synced);
    assert.ok(handles.length > 0);
    assert.ok(
      handles.every((handle) => handle.closed),
      "every sync handle must close, including after failure",
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
    openSpy.mockRestore();
    Object.defineProperty(process, "platform", platform);
  }
}

async function recoveryFixture(agentDir: string, kind: "file" | "directory") {
  const target = path.join(agentDir, "AGENTS.md");
  const directory = path.join(agentDir, "pi-sync", "transactions", "interrupted");
  const backup = path.join(directory, "before", "0");
  await fs.mkdir(path.dirname(backup), { recursive: true });
  if (kind === "directory") {
    await fs.mkdir(backup);
    await fs.writeFile(path.join(backup, "old.md"), "before");
  } else await fs.writeFile(backup, "before");
  await fs.writeFile(target, "after");
  await fs.writeFile(
    path.join(directory, "journal.json"),
    JSON.stringify({
      version: 2,
      root: agentDir,
      entries: [
        {
          target,
          backupName: "0",
          kind,
          beforeImage: kind === "file" ? fileImage("before") : directoryImage("before"),
          afterImage: fileImage("after"),
          postFiles: [],
        },
      ],
    }),
  );
  return { target, directory, backup };
}

for (const kind of ["file", "directory"] as const) {
  test(`Windows apply syncs ${kind} backups before replacing an existing target`, async () =>
    withTempHome(async (agentDir) =>
      withWindowsFileSync(async (synced) => {
        const target = path.join(agentDir, "AGENTS.md");
        await fs.mkdir(kind === "file" ? agentDir : target, { recursive: true });
        await fs.writeFile(kind === "file" ? target : path.join(target, "old.md"), "before");
        await applySnapshotTransaction({
          writes: [{ target, content: Buffer.from("after") }],
          deletes: kind === "directory" ? [target] : [],
        });
        assert.equal(await fs.readFile(target, "utf8"), "after");
        assert.ok(synced.some((file) => file.includes(`${path.sep}before${path.sep}`)));
        assert.deepEqual(await fs.readdir(path.join(agentDir, "pi-sync", "transactions")), []);
      }),
    ));

  test(`Windows recovery syncs staged files for a ${kind} preimage`, async () =>
    withTempHome(async (agentDir) =>
      withWindowsFileSync(async (synced) => {
        const fixture = await recoveryFixture(agentDir, kind);
        await recoverPendingSnapshotTransactions();
        assert.equal(
          await fs.readFile(kind === "file" ? fixture.target : path.join(fixture.target, "old.md"), "utf8"),
          "before",
        );
        assert.ok(synced.some((file) => file.includes(kind === "file" ? ".restore" : ".restore-tree")));
        await assert.rejects(fs.access(fixture.directory), { code: "ENOENT" });
      }),
    ));
}

test("Windows backup sync failure preserves the target and closes the handle", async () =>
  withTempHome(async (agentDir) =>
    withWindowsFileSync(async () => {
      await fs.mkdir(agentDir, { recursive: true });
      const target = path.join(agentDir, "AGENTS.md");
      await fs.writeFile(target, "before");
      await assert.rejects(
        applySnapshotTransaction({ writes: [{ target, content: Buffer.from("after") }], deletes: [] }),
        { code: "EPERM", syscall: "fsync" },
      );
      assert.equal(await fs.readFile(target, "utf8"), "before");
      const transactions = path.join(agentDir, "pi-sync", "transactions");
      const [transaction] = await fs.readdir(transactions);
      assert.equal(await fs.readFile(path.join(transactions, transaction, "before", "0"), "utf8"), "before");
    }, `${path.sep}before${path.sep}0`),
  ));

test("Windows restoration sync failure preserves the postimage and recovery evidence", async () =>
  withTempHome(async (agentDir) =>
    withWindowsFileSync(async () => {
      const fixture = await recoveryFixture(agentDir, "file");
      await assert.rejects(recoverPendingSnapshotTransactions(), { code: "EPERM", syscall: "fsync" });
      assert.equal(await fs.readFile(fixture.target, "utf8"), "after");
      assert.equal(await fs.readFile(fixture.backup, "utf8"), "before");
      await fs.access(path.join(fixture.directory, "journal.json"));
    }, ".restore"),
  ));
