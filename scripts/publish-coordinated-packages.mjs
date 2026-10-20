import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import rcompare from "semver/functions/rcompare.js";
import satisfies from "semver/functions/satisfies.js";
import minVersion from "semver/ranges/min-version.js";
import validRange from "semver/ranges/valid.js";

const kitName = "@narumitw/pi-tui-kit";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// Kill the process group too: npm and Changesets can own further child processes.
export function runCommand(command, args, { cwd, env = process.env, signal, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure;
    const stop = (reason) => {
      failure = reason;
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") failure = error;
      }
    };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new Error("Release subprocess timed out.")), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (data, stream) => {
      if (stdout.length + stderr.length + data.length > 4 * 1024 * 1024)
        stop(new Error("Release subprocess output exceeded its limit."));
      else if (stream === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdout.on("data", (data) => collect(data, "stdout"));
    child.stderr.on("data", (data) => collect(data, "stderr"));
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    if (signal?.aborted) abort();
  });
}

function hash(file) {
  return `sha256-${createHash("sha256").update(readFileSync(file)).digest("base64")}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readPackages(cwd) {
  return new Map(
    readdirSync(path.join(cwd, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(cwd, "packages", entry.name);
        const manifest = readJson(path.join(dir, "package.json"));
        return [manifest.name, { dir, manifest }];
      }),
  );
}

function stagePlan(packDir, staging, packages) {
  const document = readJson(path.join(packDir, "publish-plan.json"));
  if (document.version !== 1 || !Array.isArray(document.plan)) throw new Error("Invalid packed publish plan.");
  const names = new Set();
  for (const chunk of document.plan) {
    if (!Array.isArray(chunk)) throw new Error("Invalid packed publish chunk.");
    for (const release of chunk) {
      const pkg = packages.get(release?.name);
      if (
        !pkg ||
        pkg.manifest.version !== release.version ||
        names.has(release.name) ||
        !["publish", "tag-only"].includes(release.kind)
      ) {
        throw new Error("Packed release does not match the workspace.");
      }
      names.add(release.name);
      if (release.kind === "tag-only") {
        if (!pkg.manifest.private) throw new Error("Unexpected public tag-only entry in packed plan.");
        continue;
      }
      const relative = release.tarball?.path;
      if (
        typeof relative !== "string" ||
        path.isAbsolute(relative) ||
        relative.split(/[\\/]/u).includes("..") ||
        typeof release.access !== "string" ||
        typeof release.tag !== "string"
      ) {
        throw new Error("Invalid packed tarball path or publish options.");
      }
      const source = path.resolve(packDir, relative);
      if (!realpathSync(source).startsWith(`${realpathSync(packDir)}${path.sep}`))
        throw new Error("Packed tarball escapes the artifact directory.");
      if (!lstatSync(source).isFile() || hash(source) !== release.tarball.integrity)
        throw new Error("Packed tarball integrity mismatch.");
      const target = path.resolve(staging, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
  return document.plan;
}

function registryFlags(manifest) {
  // Match Changesets' npm registry selection, including scoped publishConfig.
  const config = manifest.publishConfig ?? {};
  const scope = manifest.name.startsWith("@") ? manifest.name.split("/")[0] : null;
  return [
    scope && config[`${scope}:registry`] && `--${scope}:registry=${config[`${scope}:registry`]}`,
    config.registry && `--registry=${config.registry}`,
  ].filter(Boolean);
}

function npmError(result) {
  try {
    return JSON.parse(result.stdout).error?.code;
  } catch {
    return undefined;
  }
}

async function published(pkg, run, signal) {
  const spec = `${pkg.manifest.name}@${pkg.manifest.version}`;
  const result = await run(npm, ["view", spec, "version", "--json", ...registryFlags(pkg.manifest)], {
    cwd: pkg.dir,
    signal,
    timeout: 15_000,
  });
  if (result.code === 0 && JSON.parse(result.stdout) === pkg.manifest.version) return true;
  if (result.code !== 0 && npmError(result) === "E404") return false;
  throw new Error(`Could not establish registry state for ${spec}.`);
}

async function available(pkg, expectedIntegrity, downloadDir, { run, signal, wait }) {
  const spec = `${pkg.manifest.name}@${pkg.manifest.version}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    signal?.throwIfAborted();
    // A cached tarball is not evidence of current registry visibility.
    const cache = mkdtempSync(path.join(downloadDir, "cache-"));
    let target = spec;
    let result;
    if (pkg.manifest.name !== kitName) {
      if (!expectedIntegrity) throw new Error("A release artifact hash is required for registry tarball retrieval.");
      const metadata = await run(
        npm,
        ["view", spec, "dist.tarball", "--json", "--cache", cache, ...registryFlags(pkg.manifest)],
        { cwd: pkg.dir, signal, timeout: 10_000 },
      );
      if (metadata.code !== 0) result = metadata;
      else {
        target = JSON.parse(metadata.stdout);
        if (typeof target !== "string") throw new Error(`Invalid registry tarball URL for ${spec}.`);
        const url = new URL(target);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
          throw new Error(`Invalid registry tarball URL for ${spec}.`);
      }
    }
    // Published consumer versions are also young. Retrieve only the exact planned
    // tarball URL and verify its hash, without changing dependency age selection.
    result ??= await run(
      npm,
      [
        "pack",
        target,
        "--ignore-scripts",
        "--json",
        "--cache",
        cache,
        "--pack-destination",
        downloadDir,
        ...registryFlags(pkg.manifest),
      ],
      { cwd: pkg.dir, signal, timeout: 10_000 },
    );
    if (result.code === 0) {
      const [packed] = JSON.parse(result.stdout);
      if (
        packed?.id !== spec ||
        typeof packed.filename !== "string" ||
        path.basename(packed.filename) !== packed.filename
      )
        throw new Error(`Unexpected registry artifact for ${spec}.`);
      const tarball = path.join(downloadDir, packed.filename);
      if (!lstatSync(tarball).isFile() || (expectedIntegrity && hash(tarball) !== expectedIntegrity))
        throw new Error(`Registry artifact differs from packed release: ${spec}.`);
      return;
    }
    if (["E401", "E403", "ENEEDAUTH"].includes(npmError(result))) break;
    if (attempt < 5) await wait(2_000, undefined, { signal });
  }
  throw new Error(`Registry artifact is unavailable: ${spec}. Dependents were not published.`);
}

export async function publishCoordinatedPackages({
  cwd = process.cwd(),
  packDir,
  output = process.env.CHANGESETS_OUTPUT,
  run = runCommand,
  signal,
  wait = delay,
}) {
  if (!packDir || !output) throw new Error("A pack directory and CHANGESETS_OUTPUT are required.");
  mkdirSync(path.dirname(output), { recursive: true });
  // The Action must be able to read a report even if validation fails before publication.
  appendFileSync(output, "");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-coordinated-release-"));
  try {
    const packages = readPackages(cwd);
    const staging = path.join(temporary, "pack");
    mkdirSync(staging);
    const downloadDir = path.join(temporary, "registry");
    mkdirSync(downloadDir);
    const plan = stagePlan(path.resolve(cwd, packDir), staging, packages);
    // Check the artifact's own identity and dependency policy, not only the checkout.
    for (const release of plan.flat()) {
      if (release.kind !== "publish") continue;
      const result = await run("tar", ["-xOf", path.join(staging, release.tarball.path), "package/package.json"], {
        cwd,
        signal,
        timeout: 15_000,
      });
      if (result.code !== 0) throw new Error("Cannot inspect packed manifest.");
      const manifest = JSON.parse(result.stdout);
      const expected = packages.get(release.name).manifest;
      if (
        manifest.name !== expected.name ||
        manifest.version !== expected.version ||
        ["dependencies", "optionalDependencies", "peerDependencies"].some(
          (key) =>
            JSON.stringify(Object.entries(manifest[key] ?? {}).sort()) !==
            JSON.stringify(Object.entries(expected[key] ?? {}).sort()),
        )
      ) {
        throw new Error("Packed manifest does not match the workspace release.");
      }
    }
    const kit = packages.get(kitName);
    if (
      kit &&
      Object.keys({
        ...kit.manifest.dependencies,
        ...kit.manifest.optionalDependencies,
        ...kit.manifest.peerDependencies,
      }).some((name) => packages.has(name))
    )
      throw new Error("Kit must not depend on another workspace in a Kit-first release.");
    const kitRelease = plan.flat().find((release) => release.name === kitName);
    const groups = [];
    if (kitRelease) groups.push([kitRelease]);
    groups.push(
      ...plan.map((chunk) => chunk.filter((release) => release.name !== kitName)).filter((chunk) => chunk.length),
    );
    const readyKitVersions = new Set();
    for (const group of groups) {
      signal?.throwIfAborted();
      for (const release of group) {
        if (release.kind !== "publish" || release.name === kitName) continue;
        const manifest = packages.get(release.name).manifest;
        const ranges = [
          manifest.dependencies?.[kitName],
          manifest.optionalDependencies?.[kitName],
          manifest.peerDependencies?.[kitName],
        ].filter((value) => value !== undefined);
        if (!ranges.length) continue;
        if (!kit || ranges.some((range) => typeof range !== "string" || !validRange(range)))
          throw new Error("Cannot establish the required Kit version.");
        const version = ranges.every((range) => satisfies(kit.manifest.version, range))
          ? kit.manifest.version
          : ranges
              .map((range) => minVersion(range)?.version)
              .filter(Boolean)
              .sort(rcompare)
              .find((candidate) => ranges.every((range) => satisfies(candidate, range)));
        if (!version) throw new Error("Conflicting Kit runtime dependency ranges.");
        if (!readyKitVersions.has(version)) {
          await available(
            { ...kit, manifest: { ...kit.manifest, version } },
            version === kitRelease?.version ? kitRelease.tarball?.integrity : undefined,
            downloadDir,
            { run, signal, wait },
          );
          readyKitVersions.add(version);
        }
      }
      const ready = [];
      for (const release of group) {
        if (release.kind === "publish" && (await published(packages.get(release.name), run, signal))) {
          // Recover a partial run without overwriting a registry version or tagging different contents.
          await available(packages.get(release.name), release.tarball.integrity, downloadDir, { run, signal, wait });
          ready.push({ kind: "tag-only", name: release.name, version: release.version });
        } else ready.push(release);
      }
      writeFileSync(path.join(staging, "publish-plan.json"), JSON.stringify({ version: 1, plan: [ready] }));
      const result = await run(
        process.execPath,
        [path.join(cwd, "node_modules/@changesets/cli/bin.js"), "publish", "--from-pack-dir", staging],
        { cwd, env: { ...process.env, CHANGESETS_OUTPUT: output }, signal },
      );
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.code !== 0) return result.code;
      // Native npm publish can lose an already-published race and return no tag event.
      // Reconcile against registry bytes, then let native tag-only handling repair missing tags.
      const reconciled = [];
      for (const release of ready) {
        if (release.kind !== "publish") continue;
        await available(packages.get(release.name), release.tarball.integrity, downloadDir, { run, signal, wait });
        if (release.name === kitName) readyKitVersions.add(release.version);
        reconciled.push({ kind: "tag-only", name: release.name, version: release.version });
      }
      if (reconciled.length) {
        writeFileSync(path.join(staging, "publish-plan.json"), JSON.stringify({ version: 1, plan: [reconciled] }));
        const tags = await run(
          process.execPath,
          [path.join(cwd, "node_modules/@changesets/cli/bin.js"), "publish", "--from-pack-dir", staging],
          { cwd, env: { ...process.env, CHANGESETS_OUTPUT: output }, signal },
        );
        process.stdout.write(tags.stdout);
        process.stderr.write(tags.stderr);
        if (tags.code !== 0) return tags.code;
      }
    }
    return 0;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Release cancelled."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--from-pack-dir")
      throw new Error("Usage: node scripts/publish-coordinated-packages.mjs --from-pack-dir <directory>");
    process.exitCode = await publishCoordinatedPackages({ packDir: args[1], signal: controller.signal });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
