import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { isPathInside } from "../src/paths.js";
import { applySnapshotTransaction } from "../src/snapshot/snapshot-transaction.js";
import { fileImage, indexTransactionPlan } from "../src/snapshot/snapshot-transaction-plan.js";
import type { SnapshotApplyPlan } from "../src/snapshot/snapshot-types.js";
import { withTempHome } from "./helpers.js";

const root = path.join(path.parse(process.cwd()).root, "agent");
const p = (...parts: string[]) => path.join(root, ...parts);
const write = (target: string, content = target) => ({ target, content: Buffer.from(content) });
const strictlyInside = (parent: string, target: string) =>
  path.relative(path.resolve(parent), path.resolve(target)) !== "" && isPathInside(parent, target);
const cases: Record<string, SnapshotApplyPlan> = {
  empty: { deletes: [], writes: [] },
  siblings: { deletes: [p("gone")], writes: [write(p("foo/a.md")), write(p("foo-other/b.md"))] },
  nested: {
    deletes: [p("foo"), p("foo/nested"), p("bar")],
    writes: [write(p("foo/nested/b.md")), write(p("bar/x.md")), write(p("foo/a.md"))],
  },
  "directory-to-file": { deletes: [p("foo"), p("foo/old.md")], writes: [write(p("foo"))] },
  duplicates: {
    deletes: [p("foo"), p("foo")],
    writes: [write(p("foo/a.md"), "first"), write(p("foo/a.md"), "second")],
  },
  "lexical-alias": {
    deletes: [`${root}${path.sep}alias${path.sep}..${path.sep}foo`],
    writes: [write(p("foo")), write(p("foo/a.md"))],
  },
  "case-and-unicode": { deletes: [p("Folder"), p("é")], writes: [write(p("folder/a.md")), write(p("e\u0301/b.md"))] },
  "dot-prefixed-descendant": { deletes: [p("foo")], writes: [write(p("foo/..notes/a.md"))] },
};

for (const [name, plan] of Object.entries(cases))
  test(`indexed transaction evidence preserves prior semantics: ${name}`, () => {
    const targets = [...new Set([...plan.deletes, ...plan.writes.map((w) => w.target)])].sort();
    const indexed = indexTransactionPlan(plan, targets);
    for (const target of targets) {
      const direct = plan.writes.find((w) => w.target === target);
      assert.equal(indexed.writeImages.get(target) ?? "missing", direct ? fileImage(direct.content) : "missing");
      assert.deepEqual(
        indexed.postFiles.get(target),
        plan.writes
          .filter((w) => strictlyInside(target, w.target))
          .map((w) => ({ relative: path.relative(target, w.target), image: fileImage(w.content) })),
      );
    }
    const deletes = plan.deletes.filter((t) => !plan.deletes.some((parent) => strictlyInside(parent, t)));
    assert.deepEqual(indexed.deletes, deletes);
    assert.deepEqual(
      indexed.deletedWrites,
      new Set(
        plan.writes
          .filter((w) => deletes.some((parent) => parent === w.target || isPathInside(parent, w.target)))
          .map((w) => w.target),
      ),
    );
  });

for (const duplicateDeletes of [false, true])
  test(`maximum-width indexing has bounded ancestor work: ${duplicateDeletes ? "duplicate" : "distinct"} deletes`, () => {
    const count = 16_384;
    const targets = Array.from({ length: count }, (_, i) => p(`file-${i}.md`));
    const plan = {
      deletes: duplicateDeletes ? Array.from({ length: count }, () => p("file-0.md")) : targets,
      writes: targets.map((target) => write(target, "small content")),
    };
    const relative = vi.spyOn(path, "relative");
    const dirname = vi.spyOn(path, "dirname");
    try {
      const indexed = indexTransactionPlan(plan, targets);
      assert.equal(indexed.writeImages.size, count);
      assert.equal(indexed.deletes.length, count);
      assert.equal(indexed.deletedWrites.size, duplicateDeletes ? 1 : count);
      assert.ok([...indexed.postFiles.values()].every((files) => files.length === 0));
      assert.ok(relative.mock.calls.length <= count * 2);
      assert.ok(dirname.mock.calls.length <= count * 16);
    } finally {
      relative.mockRestore();
      dirname.mockRestore();
    }
  });

test("wide descendant evidence is emitted once per actual ancestor relation", () => {
  const targets = [root, ...Array.from({ length: 16_383 }, (_, i) => p(`file-${i}.md`))];
  const indexed = indexTransactionPlan(
    { deletes: [root], writes: targets.slice(1).map((t) => write(t, "content")) },
    targets,
  );
  assert.equal(indexed.postFiles.get(root)?.length, 16_383);
  assert.equal(indexed.deletedWrites.size, 16_383);
  assert.deepEqual(indexed.deletes, [root]);
});

test("actual transaction preparation uses indexed writes and preserves journal evidence", async () =>
  withTempHome(async (agentDir) => {
    const directory = path.join(agentDir, "prompts");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "old.md"), "old bytes");
    const writes = Array.from({ length: 8 }, (_, i) => write(path.join(directory, `new-${i}.md`), `new-${i}`));
    const plan = { deletes: [directory], writes };
    const controller = new AbortController();
    const find = vi.spyOn(writes, "find");
    const filter = vi.spyOn(writes, "filter");
    const rename = fs.rename.bind(fs);
    let journalPath: string | undefined;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to).endsWith("journal.json")) {
        journalPath = String(to);
        controller.abort();
      }
    });
    try {
      await assert.rejects(applySnapshotTransaction(plan, { signal: controller.signal }), /cancelled/);
      assert.equal(find.mock.calls.length, 0);
      assert.equal(filter.mock.calls.length, 0);
      assert.ok(journalPath);
      const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
      const parent = journal.entries.find((entry: { target: string }) => entry.target === directory);
      assert.deepEqual(
        parent.postFiles,
        writes.map((w) => ({ relative: path.relative(directory, w.target), image: fileImage(w.content) })),
      );
      for (const w of writes) {
        const entry = journal.entries.find((entry: { target: string }) => entry.target === w.target);
        assert.equal(entry.afterImage, fileImage(w.content));
        assert.deepEqual(entry.postFiles, []);
        await assert.rejects(fs.access(w.target), { code: "ENOENT" });
      }
      assert.equal(await fs.readFile(path.join(directory, "old.md"), "utf8"), "old bytes");
    } finally {
      find.mockRestore();
      filter.mockRestore();
      renameSpy.mockRestore();
    }
  }));

test("over-bound transactions refuse before reserving file queues or creating evidence", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const plan = {
      deletes: [],
      writes: Array.from({ length: 16_385 }, (_, i) => write(path.join(agentDir, `f-${i}.md`))),
    };
    const mkdir = vi.spyOn(fs, "mkdir");
    const realpath = vi.spyOn(fs, "realpath");
    try {
      await assert.rejects(applySnapshotTransaction(plan), /target bound/);
      assert.equal(mkdir.mock.calls.length, 0);
      assert.equal(realpath.mock.calls.length, 0);
      await assert.rejects(fs.access(path.join(agentDir, "pi-sync/transactions")), { code: "ENOENT" });
    } finally {
      mkdir.mockRestore();
      realpath.mockRestore();
    }
  }));
