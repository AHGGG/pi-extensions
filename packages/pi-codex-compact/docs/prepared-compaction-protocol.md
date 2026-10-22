# Prepared-compaction protocol v1

This optional provider-neutral protocol uses Pi's public event bus. It does not load another extension, import private code, or schedule work. The authoritative structural contract is [`src/prepared-compaction-protocol.ts`](../src/prepared-compaction-protocol.ts); compatible implementations may ship an identical copy without a runtime dependency.

## Discovery and ownership

An engine emits `pi.compaction-engine.v1:available` with its `CompactionEngineV1` object. A consumer can emit `pi.compaction-engine.v1:request` with `{accept(engine)}` to discover an already-loaded engine. Both directions support either extension load order. The engine reinstalls discovery on session start and removes its listener and source only after the last active session manager shuts down. Shutting down one manager does not disconnect another manager sharing the same extension factory. Consumers must detach their source, cancel their work, and remove listeners on shutdown, and rediscover on the next start.

`attachSource(source)` accepts one source and returns idempotent cleanup. A competing attachment throws rather than silently replacing another controller. No source means ordinary foreground compaction continues unchanged.

## Preparation and application

- `available(ctx)` reports whether this engine can accept a preparation now; it does not start work.
- `capture(ctx)` captures a compatible active prefix, request configuration, and bounded provider timeout. Its `isCurrent()` validates provider-relevant settings, session identity, model, thinking level, system prompt, tools, ancestry, and working-set digests. A fixed `reason` describes invalidation without values or credentials.
- `start(guard)` is one-shot and returns an opaque `PreparedCheckpoint`. The consumer owns operation cancellation, run cancellation, timers, thresholds, status, and readiness. Pass the deadline separately as `deadlineSignal`: deadlines count as request failures, whereas owner cancellation does not. `ownsStatus` controls whether engine status may be written. The borrowed raw snapshot is released from the preparation handle immediately when starting; ready handles retain only the result, private binding, and digest guards.
- `PreparedCheckpoint.usable` reports preparation success. Failed handles can be passed back for bounded foreground recovery without exposing authentication or failed-attempt details.
- `adopt(event, ctx, guard)` revalidates authorization, rebases retained suffixes exactly once, and checks token budget. It never starts inference. Outcomes are explicitly ready, stale, failed, or cancel.
- `draft(ctx, guard)` additionally previews Pi's finalized projection. Returning a draft is **not** a commit. The consumer confirms `checkpointId(ctx)` matches before reporting success or releasing a pending commit claim.
- `captureBoundary(ctx)` returns an exact boundary guard. Consumers must recheck it after notifications or any callback that can reenter the host, before returning a draft.

The core's sole `session_before_compact` handler calls `source.beforeCompact` while holding its foreground operation claim. `absent` means no prepared source result; `fallback` permits the ordinary foreground path and can carry a failed opaque handle for retry accounting; `cancel` forbids fallback; `ready` supplies a validated result. An automatic application must return `cancel`, not `absent` or `fallback`, when its exact candidate becomes invalid. An optional ready-result `isCurrent` is rechecked after core status cleanup so reentrant consumer changes cannot publish a stale result.

Request deadline/run signals are not retained as ready-checkpoint validity: consumers may preserve a completed compatible result after stopping a run. Every adoption uses a fresh application signal and ownership guard. Optional structural timing sinks receive numeric phases only; scheduling and diagnostic presentation remain consumer-owned.

## Compatibility

This protocol does not change serialized checkpoints. Existing v1–v4 checkpoints and ordinary tool-replay restoration remain engine-owned. Installing only this package does not proactively prepare checkpoints. The separate `pi-background-compaction` package is one consumer, not a hard-coded protocol participant.
