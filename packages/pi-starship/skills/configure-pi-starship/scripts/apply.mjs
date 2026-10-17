#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import { backupExpectedDocument } from "./backup.mjs";
import { formatDisplayValue, formatError } from "./script-support.mjs";

const [draftPath, destinationPath, expectedPath, ...extraArguments] = process.argv.slice(2);

if (!draftPath || !destinationPath || !expectedPath || extraArguments.length > 0) {
  console.error(
    "Usage: node scripts/apply.mjs <draft-path> <absolute-pi-starship.toml-path> <expected-path|--expect-missing>",
  );
  process.exitCode = 2;
} else if (!isAbsolute(destinationPath) || basename(destinationPath) !== "pi-starship.toml") {
  console.error("The destination must be an absolute path named pi-starship.toml.");
  process.exitCode = 2;
} else {
  let temporaryPath;
  let backupPath;
  try {
    const draft = await readFile(draftPath, "utf8");
    const expectMissing = expectedPath === "--expect-missing";
    const expected = expectMissing ? undefined : await readFile(expectedPath);
    await mkdir(dirname(destinationPath), { recursive: true });
    temporaryPath = join(dirname(destinationPath), `.pi-starship.toml.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, draft, { encoding: "utf8", flag: "wx" });
    parse(await readFile(temporaryPath, "utf8"));
    await assertDestinationUnchanged(destinationPath, expectMissing, expected);
    backupPath = expected === undefined ? undefined : await backupExpectedDocument(destinationPath, expected);
    await rename(temporaryPath, destinationPath);
    temporaryPath = undefined;
    if (backupPath) console.log(`Backed up the previous TOML to ${formatDisplayValue(backupPath)}`);
    console.log(`Applied valid TOML atomically to ${formatDisplayValue(destinationPath)}`);
  } catch (error) {
    const failure = `Draft was not applied to ${formatDisplayValue(destinationPath)}: ${formatError(error)}`;
    console.error(backupPath ? `${failure}\nRetained backup: ${formatDisplayValue(backupPath)}` : failure);
    process.exitCode = 1;
  } finally {
    if (temporaryPath) {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // Cleanup is best-effort and must not obscure the original failure.
      }
    }
  }
}

async function assertDestinationUnchanged(destinationPath, expectMissing, expected) {
  let current;
  try {
    current = await readFile(destinationPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      if (expectMissing) return;
      throw new Error("The active pi-starship.toml was removed after inspection.");
    }
    throw error;
  }
  if (!expectMissing && expected !== undefined && current.equals(expected)) return;
  throw new Error("The active pi-starship.toml changed after inspection; the newer file was preserved.");
}
