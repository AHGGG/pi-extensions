import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeJson } from "../state/json-file.js";
import { withLock } from "../state/lock.js";
import { stateDir } from "../state/state-directory.js";
import { AGENT_OUTPUT_BYTES } from "./agent-policy.js";

interface Claim {
  version: 1;
  id: string;
  pid: number;
}
function paths() {
  const root = path.join(stateDir(), "agent-resolver");
  return { root, claim: path.join(root, "claim.json") };
}
async function directory() {
  const { root } = paths();
  await fs.mkdir(root, { mode: 0o700 });
}
async function checkDirectory() {
  const stat = await fs.lstat(paths().root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && stat.mode & 0o077))
    throw new Error("Unsafe agent resolver directory; evidence retained.");
}
async function readPrivate(file: string): Promise<unknown> {
  try {
    await checkDirectory();
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > AGENT_OUTPUT_BYTES * 2 ||
      (process.platform !== "win32" && stat.mode & 0o077)
    )
      throw new Error("Unsafe agent resolver record; evidence retained.");
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unreadable agent resolver record; evidence retained.");
  }
}
async function readClaim(): Promise<Claim | undefined> {
  const value = await readPrivate(paths().claim);
  if (value === undefined) return;
  const claim = value as Claim;
  if (
    claim?.version !== 1 ||
    typeof claim.id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(claim.id) ||
    Object.keys(claim).sort().join(",") !== "id,pid,version" ||
    !Number.isSafeInteger(claim.pid) ||
    claim.pid < 1 ||
    claim.pid > 2_147_483_647
  )
    throw new Error("Invalid agent resolver claim; evidence retained.");
  return claim;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Caller retains the state-directory migration guard; all record operations take the sync lock. */
export async function withAgentClaim<T>(fn: (assertOwner: () => Promise<void>) => Promise<T>): Promise<T> {
  const claim: Claim = { version: 1, id: randomUUID(), pid: process.pid };
  let armed = false;
  const assertOwner = async () => {
    const current = await readClaim();
    if (current?.id !== claim.id || current.pid !== process.pid)
      throw new Error("Agent resolver ownership changed; candidate not applied.");
  };
  try {
    await withLock("agent-claim", async () => {
      try {
        await directory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await checkDirectory();
      const existing = await readClaim();
      if (existing && alive(existing.pid)) throw new Error("Agent mode deferred: another local resolver is running.");
      // A durability failure can occur after rename: cleanup must own partial initialization too.
      armed = true;
      await writeJson(paths().claim, claim);
    });
    return await fn(assertOwner);
  } finally {
    if (armed) await releaseClaim(claim);
  }
}
async function releaseClaim(claim: Claim) {
  // Another foreground operation can start after our commit releases its lock.
  // Retry only contention before our cleanup callback enters; do not retry IO failures.
  for (let attempt = 0; ; attempt++) {
    let entered = false;
    try {
      await withLock("agent-release", async () => {
        entered = true;
        if ((await readClaim())?.id === claim.id) await fs.rm(paths().claim);
      });
      break;
    } catch (error) {
      if (entered || attempt >= 49) throw error;
      await delay(20);
    }
  }
}
function candidatePath(key: string) {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Invalid agent candidate key.");
  return path.join(paths().root, `${key}.json`);
}
export async function readAgentCandidate(key: string): Promise<unknown> {
  return readPrivate(candidatePath(key));
}
export async function saveAgentCandidate(key: string, candidate: unknown) {
  await checkDirectory();
  const target = candidatePath(key);
  const existing = await readPrivate(target);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(candidate))
      throw new Error("Agent candidate changed before save; existing evidence retained.");
    return;
  }
  await writeJson(target, candidate, { maxBytes: AGENT_OUTPUT_BYTES * 2 });
}
