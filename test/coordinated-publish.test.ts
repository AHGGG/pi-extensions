import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { assertSuccess, consumer, publishFixture, unrelated } from "./coordinated-publish-fixture.js";

const kit = "@narumitw/pi-tui-kit";
const fixtures: ReturnType<typeof publishFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function fixture(options?: Parameters<typeof publishFixture>[0]) {
  const value = publishFixture(options);
  fixtures.push(value);
  return value;
}

function tarball(value: ReturnType<typeof fixture>) {
  const artifact = value.releases[0]?.tarball;
  assert.ok(artifact);
  return artifact;
}

function publishedCalls(value: ReturnType<typeof fixture>) {
  return value.state().calls.filter((call) => call[0] === "publish");
}

test("the active script invokes native artifact publishing Kit first and retains its reports", async () => {
  const value = fixture();
  assertSuccess(await value.run());
  assert.deepEqual(value.state().published, [kit, unrelated, consumer]);
  assert.deepEqual(
    value.events().map((event) => event.packageName),
    [kit, unrelated, consumer],
  );
  assert.equal(publishedCalls(value).length, 3);
  for (const call of publishedCalls(value)) assert.match(call[1] ?? "", /\.tgz$/u);
  const downloads = value.state().calls.filter((call) => call[0] === "pack");
  assert.ok(downloads.length >= 3);
  const caches = downloads.map((call) => call[call.indexOf("--cache") + 1]);
  assert.equal(new Set(caches).size, caches.length);
  for (const cache of caches) {
    assert.ok(cache);
    assert.equal(existsSync(cache), false, "temporary caches are released");
  }
});

test("Kit publication failure blocks all remaining groups and emits no success event", async () => {
  const value = fixture({ fail: kit });
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.deepEqual(value.state().published, []);
  assert.deepEqual(value.events(), []);
  assert.equal(publishedCalls(value).length, 1);
});

test("consumer failure preserves Kit and unrelated success evidence", async () => {
  const value = fixture({ fail: consumer });
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.deepEqual(
    value.events().map((event) => event.packageName),
    [kit, unrelated],
  );
  assert.deepEqual(value.state().published, [kit, unrelated]);
});

test("a delayed Kit download is retried before consumers publish", async () => {
  const value = fixture({ delayed: 1 });
  assert.equal(await value.runDirect(), 0);
  assert.deepEqual(value.state().published, [kit, unrelated, consumer]);
  assert.equal(value.state().downloads, 4);
});

test("permanent registry invisibility fails even after native publish succeeds", async () => {
  const value = fixture({ unavailable: true });
  await assert.rejects(value.runDirect(), /unavailable/u);
  assert.equal(value.state().downloads, 6);
  assert.deepEqual(value.state().published, [kit]);
  assert.deepEqual(
    value.events().map((event) => event.packageName),
    [kit],
  );
});

test("already-published Kit is verified and recovered without republishing", async () => {
  const value = fixture({ existing: [kit] });
  assertSuccess(await value.run());
  assert.equal(publishedCalls(value).length, 2);
  assert.deepEqual(
    value.events().map((event) => event.packageName),
    [kit, unrelated, consumer],
  );
});

test("a retry of the same artifact does not republish existing versions or duplicate tags", async () => {
  const value = fixture();
  assertSuccess(await value.run());
  writeFileSync(value.output, "");
  assertSuccess(await value.run());
  assert.equal(publishedCalls(value).length, 3);
  assert.deepEqual(value.events(), []);
  assert.equal(value.state().tags.length, 3);
});

test("a consumer-only plan checks existing Kit availability without a local reference artifact", async () => {
  const value = fixture({ excludeKit: true, existing: [kit] });
  assertSuccess(await value.run());
  assert.equal(publishedCalls(value).length, 2);
  assert.deepEqual(
    value.events().map((event) => event.packageName),
    [unrelated, consumer],
  );
});

test("different already-published bytes fail before a dependent can publish", async () => {
  const value = fixture({ existing: [kit], mismatch: true });
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /differs/u);
  assert.deepEqual(publishedCalls(value), []);
  assert.deepEqual(value.events(), []);
});

test("a stale-plan publication race is reconciled and tagged by the native CLI", async () => {
  const value = fixture({ race: true });
  assertSuccess(await value.run());
  assert.deepEqual(
    value.events().map((event) => event.packageName),
    [kit, unrelated, consumer],
  );
  assert.equal(publishedCalls(value).length, 3);
});

test("a publication race with different registry bytes blocks all later groups", async () => {
  const value = fixture({ race: true, mismatch: true });
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /differs/u);
  assert.deepEqual(value.events(), []);
  assert.equal(publishedCalls(value).length, 1);
});

test("registry authentication failures stop without readiness retries", async () => {
  const value = fixture({ packError: "E403" });
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.equal(value.state().downloads, 1);
  assert.deepEqual(value.state().published, [kit]);
});

test("metadata errors stop before publication instead of assuming a new version", async () => {
  const value = fixture();
  const code = readFileSync(path.join(value.cwd, "bin/npm"), "utf8");
  writeFileSync(
    path.join(value.cwd, "bin/npm"),
    code.replace("if (args[0] === 'view') {", "if (args[0] === 'view') { error('E401');"),
  );
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /registry state/u);
  assert.equal(publishedCalls(value).length, 0);
});

test("unexpected public tag-only plan entries cannot authorize a tag", async () => {
  const value = fixture();
  value.setPlan([[{ kind: "tag-only", name: kit, version: "0.67.0" }]]);
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /tag-only/u);
  assert.deepEqual(value.events(), []);
});

test("modified packed bytes fail before any npm command", async () => {
  const value = fixture();
  writeFileSync(path.join(value.packDir, tarball(value).path), "modified");
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /integrity/u);
  assert.deepEqual(value.state().calls, []);
});

test("a packed manifest must match the checkout before any publication", async () => {
  const value = fixture();
  const file = path.join(value.cwd, "packages/consumer/package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.dependencies[kit] = "^0.68.0";
  writeFileSync(file, JSON.stringify(manifest));
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Packed manifest/u);
  assert.deepEqual(value.state().calls, []);
});

test("malformed plan paths fail closed", async () => {
  const value = fixture();
  tarball(value).path = "../outside.tgz";
  value.setPlan([value.releases]);
  const result = await value.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /path/u);
  assert.deepEqual(value.state().calls, []);
});

test("empty plans produce a readable empty Action report", async () => {
  const value = fixture();
  value.setPlan([]);
  assertSuccess(await value.run());
  assert.deepEqual(value.state().calls, []);
  assert.deepEqual(value.events(), []);
});

test("the subprocess runner cancels owned processes and enforces deadlines", async () => {
  const module = (await import(
    pathToFileURL(path.join(process.cwd(), "scripts/publish-coordinated-packages.mjs")).href
  )) as {
    runCommand: (command: string, args: string[], options: unknown) => Promise<unknown>;
  };
  const controller = new AbortController();
  const pending = module.runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: process.cwd(),
    signal: controller.signal,
  });
  controller.abort(new Error("fixture cancelled"));
  await assert.rejects(pending, /fixture cancelled/u);
  await assert.rejects(
    module.runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: process.cwd(), timeout: 10 }),
    /timed out/u,
  );
});

test("publish workflow preserves artifact and Action handling without duplicate root gates", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/publish.yml"), "utf8");
  const publish = workflow.slice(workflow.indexOf("  publish:\n"));
  assert.match(publish, /actions\/download-artifact@[a-f0-9]{40}/u);
  assert.match(publish, /artifact-ids: \$\{\{ needs\.pack\.outputs\.pack-dir-artifact-id \}\}/u);
  assert.match(
    publish,
    /script: node scripts\/publish-coordinated-packages\.mjs --from-pack-dir \$\{\{ runner\.temp \}\}\/changeset-pack/u,
  );
  assert.match(publish, /create-github-releases: true/u);
  assert.match(publish, /push-git-tags: true/u);
  assert.match(publish, /NPM_CONFIG_PROVENANCE: "true"/u);
  assert.match(publish, /if: always\(\)/u);
  assert.doesNotMatch(publish, /npm (?:run check|test)/u);
});
