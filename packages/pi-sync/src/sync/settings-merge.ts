import {
  type JsonDocument,
  type JsonNode,
  jsonEqual,
  parseSettingsDocument,
  renderSettingsMembers,
} from "./json-document.js";

export type SettingsMergeResult =
  | { kind: "merged"; content: Buffer }
  | { kind: "review"; reason: "unsupported-format" | "field-conflict"; fields: string[] };

export const COUPLED_FIELDS = [
  ["defaultProvider", "defaultModel"],
  ["queueMode", "steeringMode"],
  ["websockets", "transport"],
  ["skills", "enableSkillCommands"],
  ["enableAnalytics", "trackingId"],
] as const;

/** Only global settings.json; objects/arrays are atomic units until their invariants are proven. */
export function mergeSettingsJson(
  ancestor: Buffer,
  local: Buffer,
  remote: Buffer,
  selections: ReadonlyMap<string, "local" | "remote"> = new Map(),
): SettingsMergeResult {
  let documents: JsonDocument[];
  try {
    documents = [ancestor, local, remote].map(parseSettingsDocument);
  } catch {
    return { kind: "review", reason: "unsupported-format", fields: [] };
  }
  const [base, left, right] = documents as [JsonDocument, JsonDocument, JsonDocument];
  const selected = new Map<string, { document: JsonDocument; node: JsonNode }>();
  const fields = new Set(documents.flatMap((document) => [...document.root.members.keys()]));
  const units: string[][] = COUPLED_FIELDS.map((group) => [...group]);
  const coupled = new Set(units.flat());
  units.push(...[...fields].filter((field) => !coupled.has(field)).map((field) => [field]));
  const conflicts: string[] = [];
  for (const unit of units) {
    const equal = (first: JsonDocument, second: JsonDocument) =>
      unit.every((field) =>
        jsonEqual(first.root.members.get(field)?.node.value, second.root.members.get(field)?.node.value),
      );
    const choice = selections.get(unit[0] ?? "");
    const source = equal(left, right)
      ? left
      : equal(left, base)
        ? right
        : equal(right, base)
          ? left
          : choice === "local"
            ? left
            : choice === "remote"
              ? right
              : undefined;
    if (!source) {
      conflicts.push(...unit.filter((field) => fields.has(field)));
      continue;
    }
    for (const field of unit) {
      const member = source.root.members.get(field);
      if (member) selected.set(field, { document: source, node: member.node });
    }
  }
  if (conflicts.length) return { kind: "review", reason: "field-conflict", fields: conflicts };
  try {
    return { kind: "merged", content: renderSettingsMembers(left, selected) };
  } catch {
    return { kind: "review", reason: "unsupported-format", fields: [] };
  }
}
