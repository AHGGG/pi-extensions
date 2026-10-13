import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import type { ResolvedSyncBackend } from "../src/backends/backend-types.js";
import { S3HttpError } from "../src/backends/s3/s3-client.js";
import { mergeJournalPath } from "../src/sync/merge-journal.js";
import { mergeTransferError } from "../src/sync/merge-transfer-error.js";
import { mergeSync } from "../src/sync/merged-sync.js";
import { syncErrorGuidance } from "../src/sync/sync-error-guidance.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";

const s3: ResolvedSyncBackend = {
  type: "s3",
  profile: {
    kind: "r2",
    endpoint: "https://r2.example.com?credential=query-secret",
    region: "auto",
    accessKeyId: "private-access-key",
    secretAccessKey: "private/secret-key",
    sessionToken: "private-session-token",
  },
  destination: { bucket: "private", prefix: "home", namespace: "home" },
};

for (const backend of [
  s3,
  {
    type: "webdav",
    profile: {
      kind: "webdav",
      url: "https://cloud.example.com/dav",
      username: "private-user",
      password: "private/password",
    },
    destination: { path: "home", namespace: "home" },
  },
  {
    type: "git",
    profile: { kind: "git", remote: "https://git.example.com/repo?credential=private-query" },
    destination: { branch: "main", directory: "home", namespace: "home" },
  },
] satisfies ResolvedSyncBackend[]) {
  test(`${backend.type} transfer details redact raw and encoded connection credentials`, () => {
    let secrets: string[];
    if (backend.type === "s3") {
      const sessionToken = backend.profile.sessionToken;
      assert.ok(sessionToken);
      secrets = [backend.profile.accessKeyId, backend.profile.secretAccessKey, sessionToken, "query-secret"];
    } else if (backend.type === "webdav") {
      secrets = [
        backend.profile.username,
        backend.profile.password,
        Buffer.from(`${backend.profile.username}:${backend.profile.password}`).toString("base64"),
      ];
    } else secrets = ["private-query"];
    const payload = secrets.flatMap((secret) => [secret, encodeURIComponent(secret)]).join(" ");
    const cause = new Error(payload);
    const error = mergeTransferError(new Error(`S3 request failed: ${payload}`, { cause }), backend);
    const output = syncErrorGuidance(error);
    for (const secret of secrets) {
      assert.equal(output.includes(secret), false);
      assert.equal(output.includes(encodeURIComponent(secret)), false);
    }
    assert.match(output, /\[REDACTED\]/u);
    assert.equal(error.cause instanceof Error, true);
    assert.equal((error.cause as Error).cause, cause);
    assert.match(output, /journal and backup retained/u);
  });
}

test("nested publication errors expose HTTP status and transport codes without stacks", () => {
  const transport = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  const error = mergeTransferError(new Error("Remote publication outcome is unknown", { cause: transport }), s3);
  assert.match(error.message, /Remote publication outcome is unknown → connection reset \(ECONNRESET\)/u);
  assert.doesNotMatch(error.message, /at .*\.ts/u);
  const http = mergeTransferError(new S3HttpError("S3 PUT failed", 403), s3);
  assert.match(syncErrorGuidance(http), /HTTP 403/u);
  assert.match(syncErrorGuidance(http), /credentials and remote permissions/u);
});

test("details redact before truncation and remove terminal and display-direction controls", () => {
  const error = mergeTransferError(
    new Error(`failure\u001b[2J\u202e${"x".repeat(595)}private/secret-key${"x".repeat(2000)}`),
    s3,
  );
  const output = syncErrorGuidance(error);
  assert.ok(output.length < 1200);
  assert.match(output, /details truncated/u);
  assert.equal(output.includes("private/secret"), false);
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.includes("\u202e"), false);
});

test("cycles, deep causes and non-Error values cannot leak unbounded diagnostics", () => {
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  assert.equal(mergeTransferError(cycle, s3).message.split("cycle").length, 2);
  let deep = new Error("withheld fifth cause");
  for (let index = 0; index < 4; index++) deep = new Error(`cause ${index}`, { cause: deep });
  assert.doesNotMatch(mergeTransferError(deep, s3).message, /withheld fifth/u);
  assert.match(mergeTransferError({ password: "unknown-secret" }, s3).message, /No error details available/u);
  const authorization = mergeTransferError(new Error("Authorization: Bearer unknown-token Basic unknown-basic"), s3);
  assert.doesNotMatch(authorization.message, /unknown-token|unknown-basic/u);
});

test("merged publication failure reports redacted details while retaining evidence and never retrying", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local edit\n");
    await f.remoteEdit("settings.json", '{"theme":"remote"}\n');
    const beforeHead = await f.backend.readHead();
    const cause = new S3HttpError(
      `S3 PUT failed (403): ${f.config.backend.type === "s3" ? f.config.backend.profile.secretAccessKey : ""}`,
      403,
    );
    const publish = vi.spyOn(f.backend, "publishSnapshot").mockRejectedValueOnce(cause);
    await assert.rejects(
      mergeSync(f.ctx, mergeOptions, () => f.backend),
      (error: Error) => {
        assert.equal(error.cause, cause);
        assert.match(error.message, /Transfer failure: S3 PUT failed \(403\)/u);
        assert.match(error.message, /\[REDACTED\]/u);
        return true;
      },
    );
    assert.equal(publish.mock.calls.length, 1);
    assert.deepEqual(await f.backend.readHead(), beforeHead);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local edit\n");
    const journal = JSON.parse(await fs.readFile(mergeJournalPath(f.config), "utf8"));
    await fs.access(journal.backup);
    assert.equal(await mergeSync(f.ctx, mergeOptions, () => f.backend), "cancelled");
    assert.equal(publish.mock.calls.length, 1);
    await assert.rejects(fs.access(mergeJournalPath(f.config)), { code: "ENOENT" });
    await fs.access(journal.backup);
  }));
