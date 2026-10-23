# Compaction engine rebuild verification

## Scope

The October 23, 2026 rebuild reconciles upstream `ecf221ec37952c882d23f2807be01d449bc7154f` with the published fork `45a170c8113cf9596f360b169a13504179d10649`. A normal merge preserves both histories; no force push or package publication is part of this change.

Retained fork behavior includes OAuth-aware routing, the 900,000 ms timeout option, ordinary-work checkpoint/tool replay, bounded continuation refinements, working-set validation and reduced historical copying, a generic prepared-compaction interface, and the fork release guard. Upstream same-provider model portability and issuing-provider plaintext transfer are preserved. Transfer cancellation, stale ownership, and reentrant publication callbacks receive focused regression coverage.

The engine contains no scheduling settings, threshold policy, ready notifications, pause/resume controller, or named consumer dependency. The obsolete `/codex-compact resume` migration route is removed. Consumers own their commands and setup instructions. The [prepared-compaction interface](prepared-compaction-protocol.md) remains optional, extension-neutral, and versioned.

## Verification

The implementation was checked on Linux x64 / Node 24.19.0. Repository checks use the lockfile's Pi 1.3.0 peers; independent integration and package-loading checks use official Pi 1.4.0.

- `npm run check`: passed, including builds, Biome, package boundaries, and workspace typechecks.
- Core compaction tests: 694 passed across 34 files, no unhandled errors. Four old replay assertions were updated to require the already-intended exact work boundary after unchanged ciphertext, rather than weakening production behavior.
- Independent compatible-consumer tests on Pi 1.4.0: 185 passed, including native settled/input application boundaries; 36 consumer unit tests and its check passed.
- Production-only tarball checks: four Jiti lifecycle/reload/lazy-menu cases passed and four actual Pi RPC startup/get-state/get-commands cases passed, covering the engine alone, consumer alone, and both load orders.
- Generic engine memory harness: three fresh processes, 64 MiB archived history, four cycles each, twelve synthetic requests total; all preparation, draft, cancellation, and cleanup assertions passed. Released heap was approximately 0.78 MiB above the fixture baseline after four cycles. This is a bounded synthetic result, not a leak-proof or Windows measurement.

The full monorepo `npm test` passed its build and test TypeScript compilation, then was stopped at the 300-second limit (exit 124) with failures in unchanged upstream suites; the aggregate gate is **incomplete and not green**. Observed failures include local-socket tests in Fleet/Herdr (sandbox listen restrictions), dependency-installation policy tests (this container uses npm 11 rather than upstream's npm 12 development policy), and a Langfuse isolated-runtime test. Two Caffeinate tests failed with no `SHELL` environment variable; rerunning that package with `SHELL=/bin/bash` passed all 39 tests without source changes. These results do not justify changing unrelated upstream code or reporting a full pass.

The upstream `.node-version` is 26.11.1, but the root, compaction, and Kit manifests impose no Node engine restriction. The independent Node 24 / Pi 1.4 runtime smokes are separate evidence from upstream development-tool policy tests.

## Limits and owner testing

No live provider requests were made. Mocked payload tests prove serialization and safety contracts, not hosted acceptance, tool use, or model compliance. Windows, real-account OAuth refresh, long-running WebSocket disconnects, and the owner's resumed-session tool visibility remain unverified. Same-login OAuth token refresh can still invalidate a prepared result; this rebuild does not change that binding policy.

Update the installed Git package while preserving existing resource filters, then restart Pi. Exercise a harmless read-only tool request after manual compaction, automatic compaction, and saved-session resume. Confirm actual tool execution, not merely an assistant's claim that tools exist. Consumers should be tested separately for their own scheduling controls.

The timeout default remains five minutes; `requestTimeoutMs: 900000` is supported in `pi-codex-compact.json`. Pi's separate `httpIdleTimeoutMs` does not set this extension field. Unknown settings are preserved rather than automatically deleted.
