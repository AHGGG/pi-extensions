#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const options = { sourceDir: path.resolve(here, "../src"), historicalMiB: 64, cycles: 4, samples: 3 };
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (flag === "--source-dir" && value) options.sourceDir = path.resolve(value);
  else if (flag === "--historical-mib" && value) options.historicalMiB = Number(value);
  else if (flag === "--cycles" && value) options.cycles = Number(value);
  else if (flag === "--samples" && value) options.samples = Number(value);
  else throw new Error(`Unknown or incomplete option: ${flag}`);
}
for (const name of ["historicalMiB", "cycles", "samples"])
  if (!Number.isSafeInteger(options[name]) || options[name] < 1) throw new Error(`Invalid ${name}`);
const directory = mkdtempSync(path.join(os.tmpdir(), "pi-compact-memory-"));
try {
  symlinkSync(realpathSync(path.join(root, "node_modules")), path.join(directory, "node_modules"), "junction");
  const outfile = path.join(directory, "worker.mjs");
  await build({
    entryPoints: [path.join(here, "memory-worker.mjs")],
    outfile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "selected-runtime",
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/src\// }, (args) => ({
            path: path.join(options.sourceDir, path.basename(args.path).replace(/\.js$/, ".ts")),
          }));
        },
      },
    ],
  });
  const bundleSha256 = createHash("sha256").update(readFileSync(outfile)).digest("hex");
  const samples = [];
  for (let index = 0; index < options.samples; index++) {
    const child = spawnSync(process.execPath, ["--expose-gc", outfile, JSON.stringify(options)], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, `agent-${index}`) },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (child.error || child.status !== 0) throw new Error(child.error?.message ?? child.stderr ?? child.stdout);
    samples.push(JSON.parse(child.stdout));
  }
  console.log(JSON.stringify({ options, bundleSha256, samples }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
