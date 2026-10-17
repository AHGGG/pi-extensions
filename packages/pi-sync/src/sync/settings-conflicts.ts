import { createHash } from "node:crypto";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { readMergeAncestor } from "../state/merge-baseline-store.js";
import type { SyncState } from "../state/state-types.js";
import type { FileMergePlan } from "./file-merge-planner.js";
import { mergeSettingsJson } from "./settings-merge.js";

export async function resolveSettingsConflicts(
  config: AnySyncConfig,
  state: SyncState,
  local: Snapshot,
  remote: Snapshot,
  plan: FileMergePlan,
): Promise<{ plan: FileMergePlan; fields: string[] }> {
  if (plan.kind !== "planned") return { plan, fields: [] };
  const fields: string[] = [];
  const decisions = [...plan.decisions];
  for (let index = 0; index < decisions.length; index++) {
    const decision = decisions[index];
    if (decision?.path !== "settings.json") continue;
    if (decision.kind === "conflict" ? decision.reason !== "both-changed" : !config.agentMode) continue;
    const left = local.files.find((file) => file.path === decision.path);
    const right = remote.files.find((file) => file.path === decision.path);
    if (!left || !right) continue; // File deletion/addition is not a JSON field merge.
    const ancestor = await readMergeAncestor(config, state, decision.path);
    if (!ancestor) continue;
    const merged = mergeSettingsJson(
      ancestor,
      Buffer.from(left.contentBase64, "base64"),
      Buffer.from(right.contentBase64, "base64"),
      undefined,
      Boolean(config.agentMode),
    );
    if (merged.kind === "review") {
      fields.push(...merged.fields);
      continue;
    }
    decisions[index] = {
      kind: "accepted",
      path: decision.path,
      source: "merged",
      file: {
        path: decision.path,
        contentBase64: merged.content.toString("base64"),
        sha256: createHash("sha256").update(merged.content).digest("hex"),
      },
    };
  }
  return {
    plan: { kind: "planned", decisions, conflicts: decisions.filter((decision) => decision.kind === "conflict") },
    fields,
  };
}
