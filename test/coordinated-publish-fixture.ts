import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const script = path.join(root, "scripts/publish-coordinated-packages.mjs");
const kit = "@narumitw/pi-tui-kit";
export const consumer = "@fixture/consumer";
export const unrelated = "@fixture/unrelated";

interface Release {
  kind: string;
  name: string;
  version: string;
  access?: string;
  tag?: string;
  tarball?: { path: string; integrity: string };
}
export interface FixtureOptions {
  fail?: string;
  existing?: string[];
  delayed?: number;
  unavailable?: boolean;
  mismatch?: boolean;
  excludeKit?: boolean;
  race?: boolean;
  packError?: string;
}

export function publishFixture(options: FixtureOptions = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-coordinated-test-"));
  const packDir = path.join(cwd, "packed");
  const bin = path.join(cwd, "bin");
  const output = path.join(cwd, "report.ndjson");
  const stateFile = path.join(cwd, "state.json");
  mkdirSync(path.join(packDir, "packages"), { recursive: true });
  mkdirSync(bin);
  symlinkSync(path.join(root, "node_modules"), path.join(cwd, "node_modules"), "dir");
  writeJson(path.join(cwd, "package.json"), { name: "fixture", private: true, workspaces: ["packages/*"] });
  writeFileSync(path.join(cwd, ".npmrc"), readFileSync(path.join(root, ".npmrc")));
  writeJson(path.join(cwd, "package-lock.json"), {
    lockfileVersion: 3,
    packages: { "": { name: "fixture", workspaces: ["packages/*"] } },
  });
  writeJson(
    path.join(cwd, ".changeset/config.json"),
    JSON.parse(readFileSync(path.join(root, ".changeset/config.json"), "utf8")),
  );
  const archives: Record<string, string> = {};
  const releases: Release[] = [kit, consumer, unrelated].map((name) => {
    const version = name === kit ? "0.67.0" : "1.0.1";
    const manifest = { name, version, ...(name === consumer ? { dependencies: { [kit]: "^0.67.0" } } : {}) };
    writeJson(path.join(cwd, "packages", path.basename(name), "package.json"), manifest);
    writeJson(path.join(cwd, "archive/package/package.json"), manifest);
    const relative = `packages/${name.replace(/[@/]/gu, "-")}.tgz`;
    const archive = path.join(packDir, relative);
    execFileSync("tar", ["-czf", archive, "-C", path.join(cwd, "archive"), "package"]);
    archives[`${name}@${version}`] = archive;
    return {
      kind: "publish",
      name,
      version,
      access: "public",
      tag: "latest",
      tarball: {
        path: relative,
        integrity: `sha256-${createHash("sha256").update(readFileSync(archive)).digest("base64")}`,
      },
    };
  });
  // Deliberately put Kit last: the wrapper must isolate it even on a bad input order.
  writeJson(path.join(packDir, "publish-plan.json"), {
    version: 1,
    plan: [[releases[2]], [releases[1]], ...(options.excludeKit ? [] : [[releases[0]]])],
  });
  writeJson(stateFile, { ...options, archives, published: options.existing ?? [], calls: [], downloads: 0, tags: [] });
  writeFileSync(
    path.join(bin, "npm"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const file = process.env.FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const error = (code, summary = '') => { console.log(JSON.stringify({error:{code,summary}})); save(); process.exit(1); };
state.calls.push(args);
if (args[0] === 'view') {
  if (!state.published.includes(args[1].slice(0, args[1].lastIndexOf('@')))) error('E404');
  console.log(JSON.stringify(args[2] === 'dist.tarball' ? 'https://fixture.invalid/' + encodeURIComponent(args[1]) : args[1].slice(args[1].lastIndexOf('@') + 1)));
} else if (args[0] === 'pack') {
  state.downloads++;
  if (args[1].startsWith('https://fixture.invalid/')) args[1] = decodeURIComponent(args[1].slice('https://fixture.invalid/'.length));
  else if (!args[1].startsWith('@narumitw/pi-tui-kit@')) error('ETARGET');
  if (state.packError) error(state.packError);
  if (!state.published.includes(args[1].slice(0, args[1].lastIndexOf('@'))) || state.unavailable || state.downloads <= (state.delayed || 0)) error('E404');
  const dest = args[args.indexOf('--pack-destination') + 1];
  const filename = args[1].replace(/[@/]/g, '-') + '.tgz';
  if (state.mismatch) fs.writeFileSync(path.join(dest, filename), 'different');
  else fs.copyFileSync(state.archives[args[1]], path.join(dest, filename));
  console.log(JSON.stringify([{id:args[1],filename}]));
} else if (args[0] === 'publish') {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (state.race && pkg.name === '@narumitw/pi-tui-kit') { state.published.push(pkg.name); error('EPUBLISHCONFLICT', 'cannot publish over the previously published'); }
  if (state.published.includes(pkg.name)) error('EPUBLISHCONFLICT', 'cannot publish over the previously published');
  if (state.fail === pkg.name) error('E403', 'fixture failure');
  state.published.push(pkg.name);
  console.log('{}');
} else { error('UNEXPECTED', args.join(' ')); }
save();
`,
    { mode: 0o755 },
  );
  // Exercise native report generation without creating any real git refs.
  writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE, 'utf8'));
if (args[0] === 'tag' && args.includes('-m')) { state.tags.push(args[1]); fs.writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state)); }
else if (args[0] === 'tag') console.log(state.tags.join('\\n'));
`,
    { mode: 0o755 },
  );
  return {
    cwd,
    packDir,
    output,
    stateFile,
    releases,
    env: {
      ...process.env,
      CI: "true",
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FIXTURE_STATE: stateFile,
      CHANGESETS_OUTPUT: output,
    },
    state: () =>
      JSON.parse(readFileSync(stateFile, "utf8")) as {
        published: string[];
        calls: string[][];
        downloads: number;
        tags: string[];
      },
    events: () =>
      existsSync(output)
        ? readFileSync(output, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { packageName: string })
        : [],
    setPlan: (plan: Release[][]) => writeJson(path.join(packDir, "publish-plan.json"), { version: 1, plan }),
    async run() {
      const module = (await import(pathToFileURL(script).href)) as {
        runCommand: (
          command: string,
          args: string[],
          options: unknown,
        ) => Promise<{ code: number; stdout: string; stderr: string }>;
      };
      return module.runCommand(process.execPath, [script, "--from-pack-dir", packDir], {
        cwd,
        env: this.env,
        timeout: 4_000,
      });
    },
    async runDirect() {
      const module = (await import(pathToFileURL(script).href)) as {
        runCommand: (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => Promise<unknown>;
        publishCoordinatedPackages: (options: unknown) => Promise<number>;
      };
      return module.publishCoordinatedPackages({
        cwd,
        packDir,
        output,
        signal: AbortSignal.timeout(4_000),
        wait: async () => {},
        run: (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) =>
          module.runCommand(command, args, { ...options, env: { ...options.env, ...this.env } }),
      });
    },
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

export function assertSuccess(result: { code: number; stdout: string; stderr: string }) {
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
