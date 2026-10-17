import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { migrateLegacyStateDirectory, withStateDirectoryAccess } from "../src/state/state-directory.js";
import { acquireContinuousLease } from "../src/sync/continuous-lease.js";
import {
  continuousStatusLines,
  normalizeContinuousClock,
  REQUEST_WINDOW_MS,
  readContinuousRecord,
  reserveContinuousRequest,
  updateContinuousRecord,
} from "../src/sync/continuous-record.js";
import { continuousBinding, continuousRoot, hashContinuous } from "../src/sync/continuous-storage.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const binding = hashContinuous("test-replica");
const key = hashContinuous("candidate-one");

test("durable reservations survive restart, handoff, timeout and changing candidate keys", async () =>
  withTempHome(async () =>
    withStateDirectoryAccess(async () => {
      let lease = await acquireContinuousLease(binding);
      assert.ok(lease);
      const now = Date.now();
      try {
        await reserveContinuousRequest(binding, lease, key, () => now);
        await reserveContinuousRequest(binding, lease, key, () => now + 1);
      } finally {
        await lease.release();
      }
      lease = await acquireContinuousLease(binding);
      assert.ok(lease);
      try {
        await assert.rejects(
          reserveContinuousRequest(binding, lease, key, () => now + REQUEST_WINDOW_MS + 1),
          /limit reached/,
        );
        // The same evidence stays exhausted even when its rolling window expires.
        const stored = await readContinuousRecord(binding);
        assert.equal(stored.attempts[key], 2);
        await reserveContinuousRequest(binding, lease, hashContinuous("other-one"), () => now + REQUEST_WINDOW_MS + 2);
        await reserveContinuousRequest(binding, lease, hashContinuous("other-two"), () => now + REQUEST_WINDOW_MS + 3);
        await assert.rejects(
          reserveContinuousRequest(binding, lease, hashContinuous("other-three"), () => now + REQUEST_WINDOW_MS + 4),
          /window is full/,
        );
        assert.equal((await readContinuousRecord(binding)).calls.length, 2);
        assert.equal((await readContinuousRecord(binding)).attempts[hashContinuous("other-three")], undefined);
      } finally {
        await lease.release();
      }
    }),
  ));

test("failed reservation publication prevents dispatch, preserves evidence and permits retry", async () =>
  withTempHome(async () =>
    withStateDirectoryAccess(async () => {
      const lease = await acquireContinuousLease(binding);
      assert.ok(lease);
      try {
        await reserveContinuousRequest(binding, lease, key);
        const file = path.join(continuousRoot(), `${binding}.json`);
        const bytes = await fs.readFile(file, "utf8");
        const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk failed"));
        try {
          await assert.rejects(reserveContinuousRequest(binding, lease, key), /disk failed/);
        } finally {
          rename.mockRestore();
        }
        assert.equal(await fs.readFile(file, "utf8"), bytes);
        await reserveContinuousRequest(binding, lease, key);
        assert.equal((await readContinuousRecord(binding)).attempts[key], 2);
      } finally {
        await lease.release();
      }
    }),
  ));

test("future timestamps clamp once without granting extra calls or blocking recovery forever", async () =>
  withTempHome(async () =>
    withStateDirectoryAccess(async () => {
      const lease = await acquireContinuousLease(binding);
      assert.ok(lease);
      const now = Date.now();
      try {
        await updateContinuousRecord(binding, lease, (record) => {
          record.next = now + 999_999_999;
          record.calls = [
            { key, at: now + 999_999_999 },
            { key, at: now + 999_999_999 },
          ];
          record.attempts[key] = 2;
          normalizeContinuousClock(record, now);
        });
        const record = await readContinuousRecord(binding);
        assert.equal(record.next, now + 300_000);
        assert.deepEqual(
          record.calls.map((call) => call.at),
          [now, now],
        );
        await assert.rejects(
          reserveContinuousRequest(binding, lease, hashContinuous("fresh"), () => now + 1),
          /window is full/,
        );
        await reserveContinuousRequest(binding, lease, hashContinuous("fresh"), () => now + REQUEST_WINDOW_MS);
      } finally {
        await lease.release();
      }
    }),
  ));

for (const bad of ["{broken", JSON.stringify({ version: 99 }), "null"])
  test(`unsafe scheduler record stays untouched ${bad}`, async () =>
    withTempHome(async () =>
      withStateDirectoryAccess(async () => {
        const lease = await acquireContinuousLease(binding);
        assert.ok(lease);
        try {
          const file = path.join(continuousRoot(), `${binding}.json`);
          await fs.writeFile(file, bad, { mode: 0o600 });
          await assert.rejects(readContinuousRecord(binding));
          await assert.rejects(reserveContinuousRequest(binding, lease, key));
          assert.equal(await fs.readFile(file, "utf8"), bad);
        } finally {
          await lease.release();
        }
      }),
    ));

test("reservation time is sampled under the durable accounting lock", async () =>
  withTempHome(async () => {
    const lease = await acquireContinuousLease(binding);
    assert.ok(lease);
    try {
      await reserveContinuousRequest(binding, lease, key, () => {
        assert.equal(
          JSON.parse(readFileSync(path.join(continuousRoot(), "../lock"), "utf8")).command,
          "continuous-state",
        );
        return 123;
      });
      assert.equal((await readContinuousRecord(binding)).calls[0]?.at, 123);
    } finally {
      await lease.release();
    }
  }));

for (const corruption of ["missing", "undercounted"] as const)
  test(`inconsistent request accounting stays untouched: ${corruption}`, async () =>
    withTempHome(async () => {
      const lease = await acquireContinuousLease(binding);
      assert.ok(lease);
      try {
        await reserveContinuousRequest(binding, lease, key);
        await reserveContinuousRequest(binding, lease, key);
        const record = await readContinuousRecord(binding);
        if (corruption === "missing") record.attempts = {};
        else record.attempts[key] = 1;
        const bytes = JSON.stringify(record);
        const file = path.join(continuousRoot(), `${binding}.json`);
        await fs.writeFile(file, bytes, { mode: 0o600 });
        await assert.rejects(readContinuousRecord(binding));
        await assert.rejects(reserveContinuousRequest(binding, lease, key));
        assert.equal(await fs.readFile(file, "utf8"), bytes);
      } finally {
        await lease.release();
      }
    }));

test("state-directory migration keeps the replica binding and spent request evidence", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(path.join(agentDir, ".pisync"), { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
    const config = await loadConfig();
    const before = await continuousBinding(config);
    await withStateDirectoryAccess(async () => {
      const lease = await acquireContinuousLease(before);
      assert.ok(lease);
      try {
        await reserveContinuousRequest(before, lease, key);
        await reserveContinuousRequest(before, lease, key);
      } finally {
        await lease.release();
      }
    });
    assert.equal((await migrateLegacyStateDirectory()).status, "migrated");
    assert.equal(await continuousBinding(config), before);
    await withStateDirectoryAccess(async () => {
      const lease = await acquireContinuousLease(before);
      assert.ok(lease);
      try {
        await assert.rejects(reserveContinuousRequest(before, lease, key), /limit reached/);
      } finally {
        await lease.release();
      }
    });
  }));

test("private metadata rejects symlinks and status never creates or mutates scheduler state", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const settings = v3S3Settings();
    Object.assign(settings.syncSetups.home.sync, { continuous: true, agentMode: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const config = await loadConfig();
    await continuousStatusLines(config);
    await assert.rejects(fs.stat(path.join(agentDir, "pi-sync")), /ENOENT/);
    await withStateDirectoryAccess(async () => {
      const lease = await acquireContinuousLease(binding);
      assert.ok(lease);
      try {
        const outside = path.join(agentDir, "outside.json");
        await fs.writeFile(outside, "{}", { mode: 0o600 });
        await fs.symlink(outside, path.join(continuousRoot(), `${binding}.json`));
        await assert.rejects(readContinuousRecord(binding), /Unsafe/);
        assert.equal(await fs.readFile(outside, "utf8"), "{}");
      } finally {
        await lease.release();
      }
    });
  }));
