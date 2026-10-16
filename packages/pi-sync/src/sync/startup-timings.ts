import { performance } from "node:perf_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type StartupStage =
  | "transaction recovery"
  | "settings read"
  | "config resolution"
  | "inspection import"
  | "inspection and guards"
  | "backend initialization"
  | "local snapshot"
  | "sync state read"
  | "remote head"
  | "operations import"
  | "automatic transfer";

/** Fixed labels and durations only: never retain errors, paths, settings, or payloads. */
export function createStartupTimings() {
  const started = performance.now();
  const stages: string[] = [];
  return {
    async measure<T>(stage: StartupStage, run: () => T | Promise<T>): Promise<T> {
      const start = performance.now();
      let completed = false;
      try {
        const result = await run();
        completed = true;
        return result;
      } finally {
        stages.push(`${stage}: ${(performance.now() - start).toFixed(1)} ms${completed ? "" : " (interrupted)"}`);
      }
    },
    publish(
      ctx: ExtensionContext,
      enabled: boolean,
      sessionSignal: AbortSignal,
      scope: "local initialization" | "background startup",
      outcome: "completed" | "stopped" = "completed",
    ) {
      if (!enabled || !ctx.hasUI || sessionSignal.aborted) return;
      try {
        ctx.ui.notify(
          [
            `pi-sync debug: ${scope} (${outcome})`,
            ...stages,
            `total: ${(performance.now() - started).toFixed(1)} ms`,
          ].join("\n"),
          "info",
        );
      } catch {
        // Diagnostics must not change sync behavior if the UI is unavailable during teardown.
      }
    },
  };
}

export type StartupTimings = ReturnType<typeof createStartupTimings>;
