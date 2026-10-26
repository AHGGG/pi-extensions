import { readFileSync } from "node:fs";
import { VERSION } from "@earendil-works/pi-coding-agent";

const version = (value: unknown) =>
  typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : "unknown";

/** Public build metadata only; failure to read a package must not affect compaction. */
export function diagnosticRuntime(): string {
  let core = "unknown";
  try {
    core = version(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } catch {}
  return `schema=2 core=${core} pi=${version(VERSION)} node=${version(process.versions.node)}`;
}
