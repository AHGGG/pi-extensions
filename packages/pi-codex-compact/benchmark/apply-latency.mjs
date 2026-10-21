#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const options = {
  sourceDir: path.resolve(here, "../src"),
  nodeModulesDir: path.join(root, "node_modules"),
  historicalMiB: 64,
  samples: 3,
  authDelayMs: 20,
};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (flag === "--source-dir" && value) options.sourceDir = path.resolve(value);
  else if (flag === "--node-modules-dir" && value) options.nodeModulesDir = path.resolve(value);
  else if (flag === "--historical-mib" && value) options.historicalMiB = Number(value);
  else if (flag === "--samples" && value) options.samples = Number(value);
  else if (flag === "--auth-delay-ms" && value) options.authDelayMs = Number(value);
  else throw new Error(`Unknown or incomplete option: ${flag}`);
}
for (const name of ["historicalMiB", "samples", "authDelayMs"])
  if (!Number.isSafeInteger(options[name]) || options[name] < (name === "authDelayMs" ? 0 : 1))
    throw new Error(`Invalid ${name}`);
const require = createRequire(path.join(options.nodeModulesDir, "../package.json"));
const { build } = require("esbuild");
const dependencyVersions = Object.fromEntries(
  ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"].map((name) => [
    name,
    JSON.parse(readFileSync(path.join(options.nodeModulesDir, "@earendil-works", name, "package.json"))).version,
  ]),
);
const directory = mkdtempSync(path.join(os.tmpdir(), "pi-compact-apply-latency-"));
const runWorker = (outfile, workerOptions, agentDir) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", outfile, JSON.stringify(workerOptions)], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let stderr = "";
    let deadline;
    let failure;
    const fail = (message) => {
      failure ??= new Error(message);
      child.kill();
    };
    // Imports/fixture setup are not a measured operation. Start the safety
    // deadline only after the child's explicit initialized/readiness handshake.
    child.on("message", (message) => {
      if (message?.type !== "ready" || deadline) return;
      deadline = setTimeout(() => fail("Benchmark did not settle within 120 seconds after readiness"), 120_000);
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) fail("Unexpectedly large benchmark output");
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 4 * 1024 * 1024) fail("Unexpectedly large benchmark error output");
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      if (failure || code !== 0) reject(failure ?? new Error(stderr || stdout || `Worker exit: ${code ?? signal}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
try {
  symlinkSync(realpathSync(options.nodeModulesDir), path.join(directory, "node_modules"), "junction");
  const outfile = path.join(directory, "worker.mjs");
  await build({
    entryPoints: [path.join(here, "apply-latency-worker.mjs")],
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
    const sample = {};
    // GC retention probes are separate processes: they must not inflate apply timings.
    for (const mode of ["timing", "memory"]) {
      sample[mode] = await runWorker(outfile, { ...options, mode }, path.join(directory, `agent-${index}-${mode}`));
    }
    samples.push(sample);
  }
  console.log(JSON.stringify({ options, dependencyVersions, bundleSha256, samples }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
