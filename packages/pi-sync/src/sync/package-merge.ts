import { compare, valid } from "semver";
import { type JsonValue, jsonEqual } from "./json-document.js";

interface Entry {
  value: JsonValue;
  version?: string;
  options: JsonValue;
}

function entries(value: JsonValue | undefined): Map<string, Entry> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = new Map<string, Entry>();
  for (const item of value) {
    if (typeof item !== "string" && (!item || Array.isArray(item) || typeof item !== "object")) return undefined;
    const source = typeof item === "string" ? item : item.source;
    if (typeof source !== "string") return undefined;
    const spec = source.startsWith("npm:") ? source.slice(4).trim() : undefined;
    const match = spec?.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/u);
    const key = match ? `npm:${match[1]}` : source;
    if (result.has(key)) return undefined;
    const options =
      typeof item === "string" ? null : Object.fromEntries(Object.entries(item).filter(([key]) => key !== "source"));
    result.set(key, { value: item, options, version: match?.[2] });
  }
  return result;
}

/** Compare only explicit npm versions; do not resolve ranges, tags, Git refs or registry state. */
export function mergePackageVersions(
  base: JsonValue | undefined,
  local: JsonValue | undefined,
  remote: JsonValue | undefined,
): JsonValue[] | undefined {
  const ancestor = entries(base ?? []);
  const left = entries(local);
  const right = entries(remote);
  if (!ancestor || !left || !right) return undefined;
  const output: JsonValue[] = [];
  for (const key of new Set([...left.keys(), ...right.keys(), ...ancestor.keys()])) {
    const a = ancestor.get(key);
    const l = left.get(key);
    const r = right.get(key);
    let chosen: Entry | undefined;
    if (
      l &&
      r &&
      key.startsWith("npm:") &&
      l.version &&
      r.version &&
      valid(l.version) &&
      valid(r.version) &&
      jsonEqual(l.options, r.options)
    ) {
      chosen = compare(l.version, r.version) >= 0 ? l : r;
    } else if (jsonEqual(l?.value, r?.value)) chosen = l;
    else if (jsonEqual(l?.value, a?.value)) chosen = r;
    else if (jsonEqual(r?.value, a?.value)) chosen = l;
    else return undefined;
    if (chosen) output.push(chosen.value);
  }
  return output;
}
