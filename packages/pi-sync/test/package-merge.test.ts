import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonValue } from "../src/sync/json-document.js";
import { mergePackageVersions } from "../src/sync/package-merge.js";
import { mergeSettingsJson } from "../src/sync/settings-merge.js";

for (const [lower, higher] of [
  ["1.9.0", "1.10.0"],
  ["1.0.0-beta.2", "1.0.0-beta.10"],
  ["1.0.0-rc.1", "1.0.0"],
  ["1.0.0", "2.0.0"],
]) {
  for (const name of ["example", "@scope/example"]) {
    test(`higher version wins in either direction: ${name} ${lower}/${higher}`, () => {
      const low = `npm:${name}@${lower}`;
      const high = `npm:${name}@${higher}`;
      for (const [local, remote] of [
        [low, high],
        [high, low],
      ] as const) {
        assert.deepEqual(mergePackageVersions([high], [local], [remote]), [high]);
        assert.deepEqual(mergePackageVersions([], [local], [remote]), [high]);
      }
    });
  }
}

test("preserves filters and independent additions, deletions and local paths", () => {
  const old = { source: "npm:example@1.0.0", extensions: ["a.ts"], skills: [] };
  const newer = { ...old, source: "npm:example@2.0.0" };
  assert.deepEqual(
    mergePackageVersions(
      [old, "./keep", "./delete"],
      [old, "./keep", "./local"],
      [newer, "./keep", "./delete", "./remote"],
    ),
    [newer, "./keep", "./local", "./remote"],
  );
});

for (const [local, remote] of [
  [["npm:example@^1.0.0"], ["npm:example@^2.0.0"]],
  [["npm:example@latest"], ["npm:example@next"]],
  [["npm:example"], ["npm:example@2.0.0"]],
  [["npm:example@bad"], ["npm:example@2.0.0"]],
  [["npm:example@1.0.0", "npm:example@2.0.0"], ["npm:example@3.0.0"]],
  [[{ source: "npm:example@1.0.0", skills: [] }], [{ source: "npm:example@2.0.0", skills: ["x"] }]],
  [[42], ["npm:example@2.0.0"]],
] satisfies [JsonValue[], JsonValue[]][]) {
  test(`unsupported or ambiguous entries retain atomic conflict: ${JSON.stringify(local)}`, () => {
    assert.equal(mergePackageVersions([], [...local], [...remote]), undefined);
  });
}

test("delete/upgrade retains conflict, unchanged deletion stays deleted", () => {
  assert.equal(mergePackageVersions(["npm:x@1.0.0"], [], ["npm:x@2.0.0"]), undefined);
  assert.deepEqual(mergePackageVersions(["npm:x@1.0.0"], [], ["npm:x@1.0.0"]), []);
});

test("higher version policy is opt-in and retains unknown settings", () => {
  const bytes = (packages: string[], extra = {}) =>
    Buffer.from(JSON.stringify({ packages, future: { x: 1 }, ...extra }));
  const versions = [bytes(["npm:x@1.0.0"]), bytes(["npm:x@2.0.0"]), bytes(["npm:x@3.0.0"], { theme: "dark" })] as const;
  assert.equal(mergeSettingsJson(...versions).kind, "review");
  const merged = mergeSettingsJson(...versions, undefined, true);
  assert.equal(merged.kind, "merged");
  if (merged.kind === "merged")
    assert.deepEqual(JSON.parse(merged.content.toString()), {
      packages: ["npm:x@3.0.0"],
      future: { x: 1 },
      theme: "dark",
    });
});
