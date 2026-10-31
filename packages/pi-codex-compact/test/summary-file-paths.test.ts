import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { formatSummaryFilePaths, summaryPathRoot } from "../src/summary-file-paths.js";

function files(output: string, tag: string): string[] {
  const block = output.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1];
  if (!block) return [];
  const decode = (value: string) => (value.startsWith('"') ? JSON.parse(value) : value);
  const result: string[] = [];
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const value = decode(lines[i]);
    if (lines[i + 1]?.startsWith("  ")) {
      const names = lines[++i].trim().match(/"(?:[^"\\]|\\.)*"|[^,]+/g) ?? [];
      result.push(...names.map((name) => value + decode(name.trim())));
    } else result.push(value);
  }
  return result.sort();
}

test("grouped paths normalize only known-root aliases, prefer modified, and retain all temporary names", () => {
  const read = ["E:/repo/app/a.ts", "app/a.ts", "./app/a.ts", "app/b.ts", "F:/Temp/log1.txt", "F:/Temp/log2.txt"];
  const modified = ["E:\\repo\\app\\b.ts", "app/c.ts"];
  const before = JSON.stringify({ read, modified });
  const output = formatSummaryFilePaths(read, modified, "E:/repo");
  assert.deepEqual(files(output, "read-files"), ["F:/Temp/log1.txt", "F:/Temp/log2.txt", "app/a.ts"]);
  assert.deepEqual(files(output, "modified-files"), ["app/b.ts", "app/c.ts"]);
  assert.match(output, /F:\/Temp\/\n {2}log1.txt, log2.txt/);
  assert.match(output, /app\/\n {2}b.ts, c.ts/);
  assert.equal(JSON.stringify({ read, modified }), before);
  assert.equal(formatSummaryFilePaths([...read].reverse(), [...modified].reverse(), "E:/repo"), output);
});

test("unknown roots and POSIX backslashes preserve identities; root boundaries and case are exact", () => {
  const paths = [
    "/repo/a.ts",
    "a.ts",
    "A.ts",
    "../a.ts",
    "link/../a.ts",
    "./",
    ".//a",
    "/a",
    "./C:a",
    "/repo/@a",
    "@a",
    "./@a",
    "/repo/~/a",
    "~/a",
    "./~/a",
    "a\\b.ts",
    "/repo-other/a.ts",
    "/repo//a.ts",
  ];
  assert.deepEqual(files(formatSummaryFilePaths(paths, []), "read-files"), [...paths].sort());
  assert.deepEqual(
    files(formatSummaryFilePaths(paths, [], "/repo"), "read-files"),
    [...new Set(paths.map((p) => (p === "/repo/a.ts" ? "a.ts" : p)))].sort(),
  );
  assert.deepEqual(
    files(formatSummaryFilePaths(["C:/Repo/a", "C:/repo/a", "C:a", "\\a"], [], "C:/repo"), "read-files"),
    ["C:/Repo/a", "C:a", "\\a", "a"].sort(),
  );
  assert.deepEqual(files(formatSummaryFilePaths(paths, [], "/repo/../other"), "read-files"), [...paths].sort());
});

test("quoted directory headings and filenames round-trip punctuation and control characters", () => {
  const paths = [
    "dir/a,b.ts",
    "dir/ a.ts ",
    "dir/a\nb.ts",
    "dir/a\u007fb.ts",
    "dir/a\u2028b.ts",
    'dir/a"b.ts',
    "dir/<read-files>",
    " dir\n/x",
    " dir\n/y",
    "dir/",
    "plain",
  ];
  const output = formatSummaryFilePaths(paths, []);
  assert.deepEqual(files(output, "read-files"), [...paths].sort());
  assert.equal(output.match(/<read-files>/g)?.length, 1);
  assert.doesNotMatch(output, /[\u007f\u2028]/);
  assert.equal(formatSummaryFilePaths([], []), "");
});

test("root shortening requires the same unforked header, manager, and active cwd", () => {
  const context = (header: { cwd: string; parentSession?: string } | null, cwd = "/repo", managerCwd = cwd) =>
    ({ cwd, sessionManager: { getHeader: () => header, getCwd: () => managerCwd } }) as ExtensionContext;
  assert.equal(summaryPathRoot(context({ cwd: "/repo" })), "/repo");
  assert.equal(summaryPathRoot(context(null)), undefined);
  assert.equal(summaryPathRoot(context({ cwd: "/old" })), undefined);
  assert.equal(summaryPathRoot(context({ cwd: "/repo" }, "/repo", "/other")), undefined);
  assert.equal(summaryPathRoot(context({ cwd: "/repo", parentSession: "/old/session.jsonl" })), undefined);
});
