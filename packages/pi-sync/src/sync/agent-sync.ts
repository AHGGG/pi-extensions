import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandOptions } from "../commands/command-types.js";
import { withLock } from "../state/lock.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { AGENT_MAX_ATTEMPTS } from "./agent-policy.js";
import { type AgentAcceptance, AgentResolutionRequired } from "./agent-request.js";

/** All callers retain their existing state-directory access guard. Off stays lazy. */
export async function withAgentSyncLock<T>(
  ctx: ExtensionContext,
  options: CommandOptions,
  run: (options: CommandOptions) => Promise<T>,
): Promise<T> {
  let request: AgentResolutionRequired;
  try {
    return await withLock("sync", () => run(options));
  } catch (error) {
    if (!(error instanceof AgentResolutionRequired)) throw error;
    request = error;
  }
  const { withAgentClaim, readAgentCandidate, saveAgentCandidate } = await import("./agent-store.js");
  const { parseAgentCandidate } = await import("./agent-candidate.js");
  const { runAgentResolver } = await import("./agent-runner.js");
  return withAgentClaim(async (assertOwner) => {
    const clearStatus = () => setSyncStatus(ctx, undefined);
    const onAbort = () => {
      try {
        clearStatus();
      } catch {
        /* UI can already be disposed. */
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      options.signal?.throwIfAborted();
      for (let attempt = 0; attempt < AGENT_MAX_ATTEMPTS; attempt++) {
        const validate = () =>
          withLock("agent-validate", async () => {
            options.signal?.throwIfAborted();
            await assertOwner();
            await request.validate();
            options.signal?.throwIfAborted();
          });
        await validate();
        setSyncStatus(ctx, "sync resolving");
        const cached = await withLock("agent-cache-read", async () => {
          await assertOwner();
          return readAgentCandidate(request.key);
        });
        const raw =
          cached === undefined
            ? await runAgentResolver(ctx, request.evidence, validate, options.signal)
            : JSON.stringify(cached);
        const candidate = parseAgentCandidate(raw, request.evidence);
        await validate();
        await withLock("agent-cache-save", async () => {
          await assertOwner();
          await saveAgentCandidate(request.key, candidate);
        });
        const acceptance: AgentAcceptance = { key: request.key, candidate };
        try {
          return await withLock("sync", async () => {
            await assertOwner();
            options.signal?.throwIfAborted();
            return run({ ...options, agentAcceptance: acceptance });
          });
        } catch (error) {
          if (!(error instanceof AgentResolutionRequired)) throw error;
          request = error;
        }
      }
      throw new Error("Agent mode paused: content changed repeatedly; retry later.");
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (!options.signal?.aborted) clearStatus();
    }
  });
}
