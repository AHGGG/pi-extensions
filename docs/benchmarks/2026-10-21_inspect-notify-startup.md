# Inspect and Notify startup comparison

Prebuilt Jiti runtimes reduce joint package startup without moving initialization into `session_start` or adding lazy backend imports. Root Git installations retain source entrypoints.

This report owns only joint-load measurements and shared verification. Package-owned reports contain isolated startup, first-use results, reproduction commands and package-specific safety evidence:

- [Inspect report](../../packages/pi-inspect/benchmarks/2026-10-21-startup.md) and [samples](../../packages/pi-inspect/benchmarks/2026-10-21-startup.json).
- [Notify report](../../packages/pi-notify/benchmarks/2026-10-21-startup.md) and [samples](../../packages/pi-notify/benchmarks/2026-10-21-startup.json).

## Joint-load protocol

The [joint samples](./2026-10-21_inspect-notify-startup.json) contain thirteen startup series, including the baseline commit, environment, excluded warm-ups, per-process samples, medians and median absolute deviations (MAD). The three JSON files together preserve all original 29 startup and 24 first-use series without copying any measurement record between owners.

Measurements used Pi 1.3.0, Node v26.10.0 and macOS arm64. Warm mode primes Jiti's filesystem cache; cold mode disables it, not the operating-system cache. Each initial series has seven measured processes after a warm-up, plus a separate no-extension RPC baseline. Cold confirmation used fifteen measured processes. No model requests or user extensions were loaded.

Inspect loads before Notify. Shared imports and load order affect the totals, so joint-load records and their per-entry arrays remain together here; they are not standalone package measurements.

Installed samples used production-only tarball installations with `--omit=dev --legacy-peer-deps`. The baseline source entries and manifests came from the baseline Git archive, with unchanged browser assets copied into the original output layout before packing. Both old and new installed pairs resolved published Kit 0.65.6; workspace measurements used Kit 0.66.0.

## Results

Values are milliseconds as median (MAD).

| Entry set | Cache | Import before | Import after | First RPC before | First RPC after |
| --- | --- | ---: | ---: | ---: | ---: |
| Package combined | Warm | 142 (3) | 12 (0) | 314.49 (9.64) | 172.91 (0.45) |
| Package combined, initial | Cold | 384 (6) | 194 (5) | 556.44 (10.04) | 357.77 (1.08) |
| Package combined, confirmation | Cold | 384 (6) | 192 (5) | 556.44 (10.04) | 355.06 (3.88) |
| Installed combined | Warm | 143 (1) | 12 (0) | 304.55 (2.24) | 173.38 (2.30) |
| Installed combined | Cold | 390 (2) | 188 (3) | 561.46 (3.30) | 349.67 (2.90) |
| Source combined | Warm | 139 (1) | 148 (3) | 301.16 (3.89) | 321.00 (7.11) |
| Source combined | Cold | 384 (4) | 386 (6) | 555.54 (8.24) | 552.24 (4.22) |

The target was a 50% combined cold import reduction, with a reduction for each package. The initial package matrix reached 49.5%, near measurement variation; confirmation reached 50.0%, and the installed pair reached 51.8%. Package warm imports fell 91.5%. First RPC responses improved too, so work was not merely shifted out of the import timer. No additional lazy backend boundary was needed.

Source loading remains essentially unchanged. Warm import, RPC and package first-use changes stayed within the larger of 10% or twice the baseline MAD. No-extension RPC medians remained near 160 ms. These observations are not timing guarantees for another host or Pi version.

To reproduce joint startup from the repository root after `npm install` and `npm run build`:

```sh
npm run benchmark:extension-startup -- --entry packages/pi-inspect --entry packages/pi-notify --baseline --runs 7 --cache-mode warm
npm run benchmark:extension-startup -- --entry packages/pi-inspect --entry packages/pi-notify --baseline --runs 7 --cache-mode cold
```

For source startup, append `/src/index.ts` to both entries. For installed startup, pass the installed package directories. Timing thresholds are not deterministic unit-test assertions.

## Shared verification and limits

Review followed [extension conventions](../extension-conventions.md), [runtime builder policy](../runtime-builder.md) and [README conventions](../readme-conventions.md). Audits covered external imports, exact emitted paths, lifecycle cleanup, consent/capture timing, command compatibility, read-only model hooks, build recovery and package contents. Settings, provider policies and the shared runtime builder remain unchanged.

`npm run typecheck`, `npm run check` and plain `npm test` passed: 716 files, 12,391 tests, 19 existing skips and no unhandled errors. Package smokes and pack inspection are recorded in the linked reports. [Linux CI](https://github.com/narumiruna/pi-extensions/actions/runs/39545924269) also passed checks and tests for the package-owned benchmark tooling.

Two earlier full runs failed unchanged `pi-sync` journal-recovery/takeover timing assertions; focused and subsequent full runs passed without Sync changes or larger timeouts. Direct interactive terminal/desktop smoke, Windows behavior and live provider delivery remain unverified. No packages, version tags or release workflows were published or dispatched.
