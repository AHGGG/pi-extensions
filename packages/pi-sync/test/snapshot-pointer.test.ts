import assert from "node:assert/strict";
import { test } from "vitest";
import type { LatestPointer, ResolvedS3Backend } from "../src/backends/backend-types.js";
import { pointerFor } from "../src/backends/s3/s3-backend.js";
import { createLatestPointer, remoteHistoryEntry } from "../src/backends/snapshot-pointer.js";
import { snapshot } from "./helpers.js";

const config: ResolvedS3Backend = {
  type: "s3",
  profile: {
    kind: "s3-compatible",
    endpoint: "https://storage.example.com",
    region: "auto",
    accessKeyId: "access",
    secretAccessKey: "secret",
  },
  destination: { bucket: "bucket", prefix: "pi-sync", namespace: "reviewed" },
};

for (const syncSessions of [undefined, false, true]) {
  for (const filePath of ["settings.json", "sessions/project/session.jsonl"]) {
    for (const selection of [undefined, { version: 1 as const, include: ["settings.json", "sessions"] }]) {
      test(`object-store pointer preserves metadata (${syncSessions}, ${filePath}, selection=${!!selection})`, () => {
        const source = {
          ...snapshot([{ path: filePath, content: Buffer.from("content") }]),
          ...(syncSessions === undefined ? {} : { syncSessions }),
          ...(selection === undefined ? {} : { selection }),
        };
        const expected = {
          version: 1,
          profile: "reviewed",
          snapshot: "snap",
          sha256: "checksum",
          createdAt: "2026-01-01T00:00:00.000Z",
          machine: "test",
          syncSessions: syncSessions === true || filePath.startsWith("sessions/"),
          ...(selection === undefined ? {} : { selection }),
        };
        const pointer = createLatestPointer("reviewed", source, "checksum");
        assert.equal(JSON.stringify(pointer), JSON.stringify(expected));
        assert.deepEqual(pointerFor(config, source, "checksum"), pointer);
        assert.equal(Object.hasOwn(pointer, "selection"), selection !== undefined);
      });
    }
  }
}

for (const syncSessions of [undefined, false, true]) {
  test(`object-store history projection normalizes session metadata ${syncSessions}`, () => {
    const pointer: LatestPointer = {
      version: 1,
      profile: "reviewed",
      snapshot: "snap",
      sha256: "checksum",
      createdAt: "date",
      machine: "machine",
      ...(syncSessions === undefined ? {} : { syncSessions }),
      selection: { version: 1, include: ["sessions"] },
    };
    assert.equal(
      JSON.stringify(remoteHistoryEntry(pointer)),
      JSON.stringify({
        snapshotRef: "snap",
        snapshotId: "snap",
        createdAt: "date",
        machine: "machine",
        syncSessions: syncSessions === true,
      }),
    );
  });
}
