# Inspect and Notify startup verification

Prebuilt Jiti runtimes reduce package-directory startup without moving initialization into `session_start` or adding lazy backend imports. Root Git installations retain source entrypoints. Inspector browser assets now live in `browser-dist`, independently of the generated runtime in `dist`.

## Measurement protocol

The [samples and summaries](./2026-10-21_inspect-notify-startup.json) record the baseline commit, environment, excluded warm-ups, per-process samples, medians and median absolute deviations (MAD). Measurements used Pi 1.3.0, Node v26.10.0, macOS arm64. Warm mode primes Jiti's filesystem cache; cold mode disables that cache, not the operating-system cache. Startup uses offline RPC with no user extensions or model requests.

Each initial series has seven measured processes after a warm-up. Both packages were measured separately and together, through source files and package directories, with a no-extension RPC baseline for each series. Combined entries load Inspect before Notify; their shared imports make combined costs smaller than the sum of isolated costs.

An additional 15-process cold confirmation followed the initial matrix. A separate production installation of both packed packages used `--omit=dev --legacy-peer-deps` and resolved Notify's published Kit floor, 0.65.6, rather than the workspace Kit 0.66.0. For a like-for-like installed baseline, the unchanged frontend assets were copied into the original package layout from the baseline Git archive before packing its original source entries. Both old and new installed pairs used the same Kit resolution.

### Startup results

Values are milliseconds, shown as median (MAD).

| Entry set | Cache | Import before | Import after | First RPC before | First RPC after |
| --- | --- | ---: | ---: | ---: | ---: |
| Package Inspect | Warm | 70 (0) | 9 (0) | 229.26 (0.65) | 168.37 (0.34) |
| Package Notify | Warm | 85 (4) | 11 (0) | 245.91 (3.34) | 170.56 (0.50) |
| Package combined | Warm | 142 (3) | 12 (0) | 314.49 (9.64) | 172.91 (0.45) |
| Package Inspect | Cold | 237 (2) | 130 (1) | 403.25 (5.05) | 292.59 (3.32) |
| Package Notify | Cold | 243 (4) | 131 (2) | 411.37 (7.81) | 296.70 (6.81) |
| Package combined, initial | Cold | 384 (6) | 194 (5) | 556.44 (10.04) | 357.77 (1.08) |
| Package combined, confirmation | Cold | 384 (6) | 192 (5) | 556.44 (10.04) | 355.06 (3.88) |
| Installed combined | Warm | 143 (1) | 12 (0) | 304.55 (2.24) | 173.38 (2.30) |
| Installed combined | Cold | 390 (2) | 188 (3) | 561.46 (3.30) | 349.67 (2.90) |
| Source Inspect | Warm | 71 (2) | 74 (3) | 233.29 (1.82) | 237.56 (3.05) |
| Source Notify | Warm | 81 (1) | 83 (1) | 241.90 (1.07) | 248.70 (2.76) |
| Source combined | Warm | 139 (1) | 148 (3) | 301.16 (3.89) | 321.00 (7.11) |
| Source Inspect | Cold | 237 (8) | 233 (3) | 404.64 (12.07) | 394.65 (2.83) |
| Source Notify | Cold | 245 (3) | 240 (2) | 408.45 (2.68) | 403.07 (2.10) |
| Source combined | Cold | 384 (4) | 386 (6) | 555.54 (8.24) | 552.24 (4.22) |

The cold target is a 50% combined import reduction, with a reduction for each package. The initial package matrix reached 49.5%, near the measurement variation; the larger confirmation reached 50.0%. The independently installed pair reached 51.8%. Package warm imports fell 91.5%. First RPC responses also improved, so the work was not merely shifted out of the import timer. No new lazy backend boundary was needed.

Source loading remains essentially unchanged. All warm import and RPC changes stay within the agreed tolerance: the larger of 10% or twice the baseline MAD. No-extension RPC medians stayed near 160 ms; full baseline samples are in the JSON. These are local observations, not a timing guarantee for another host or Pi version.

### First-use results

The POSIX-only model-free Jiti harness supplies read-only host actions and synthetic TUI callbacks. It loads no real notification destinations and never launches a desktop browser. The timer starts after extension loading and `session_start`. Notify ends at the first custom menu opening; Inspect ends after consent, server startup and successful reads of real HTML/JS/CSS. Human confirmation time and desktop browser rendering are not measured.

Seven measured processes follow one excluded warm-up. Values are median milliseconds.

| Entry | Cache | Inspect before → after | Notify before → after |
| --- | --- | ---: | ---: |
| Package | Warm | 22.31 → 19.69 | 23.69 → 15.53 |
| Package | Cold | 25.15 → 23.69 | 62.45 → 47.11 |
| Source | Warm | 22.33 → 23.37 | 24.24 → 24.45 |
| Source | Cold | 24.24 → 24.74 | 61.53 → 60.39 |
| Installed | Warm | 22.44 → 19.28 | 41.56 → 30.44 |
| Installed | Cold | 23.87 → 23.74 | 283.86 → 290.83 |

Every first-use change remains within the same tolerance. The installed Notify cold menu includes the external published Kit runtime's loading cost, which is not bundled or deferred further by this change. It is not comparable to the faster workspace Kit measurement.

To reproduce from the repository root after `npm install` and `npm run build`:

```sh
npm run benchmark:extension-startup -- --entry packages/pi-inspect --entry packages/pi-notify --baseline --runs 7 --cache-mode warm
npm run benchmark:extension-startup -- --entry packages/pi-inspect --entry packages/pi-notify --baseline --runs 7 --cache-mode cold
npm run benchmark:inspect-notify-first-use -- inspect package
npm run benchmark:inspect-notify-first-use -- notify package
JITI_FS_CACHE=false npm run benchmark:inspect-notify-first-use -- inspect source
JITI_FS_CACHE=false npm run benchmark:inspect-notify-first-use -- notify source
```

Repeat first-use commands in separate processes and discard the first sample. For isolated startup, pass one entry. For source startup, append `/src/index.ts` to each entry. For installed startup, pass the installed package directories. Timing thresholds are not deterministic unit-test assertions.

## Correctness and safety evidence

The applicable guides are `docs/extension-conventions.md`, `docs/runtime-builder.md`, and `docs/readme-conventions.md`. Review covered package boundaries, dependency externalization, exact runtime imports, retained lazy menus, source/generated asset bases, consent and capture timing, read-only model hooks, cancellation, disposal, session replacement, repeated shutdown, malformed output, symlink ownership, staging cleanup, and failed publication recovery. Settings schemas, persistence, provider policies and model-visible contracts are unchanged; the shared runtime builder is unchanged.

Inspector's browser-builder tests import an isolated checkout copy. They cannot replace canonical assets while another worker copies or serves them. Browser and runtime publication remain separate transactions; either build failing stops build/prepack. Simultaneous writers and crash durability are not supported.

Completed checks:

- `npm run typecheck`, `npm run check`, and plain `npm test`: 714 files passed, 12,381 tests passed, 19 existing skips, no unhandled errors.
- Focused Notify suite: 1,809 tests; Inspector suite: 467 tests before the three added isolation/build-order regression cases, which also pass in the full root gate.
- Inspector Playwright browser suite: 134 passed, including real Pi live session, credential rotation and shutdown.
- Both explicit workspace builds, both `npm run package:pack` commands, and actual tarball inspection passed. Inspector has 68 files; Notify has 32. Required runtime entries/maps, browser assets and licenses are present; tests and build helpers are excluded.
- Both tarballs installed into a production-only temporary npm root. Jiti startup and first menu/viewer use passed with published Kit 0.65.6.
- Inspector's production Git-install smoke passed from an asset-free checkout with development dependencies omitted. It built and served real browser assets and loaded the retained source entry without runtime output.
- Inspector's package/source smoke and the equivalent Notify smoke passed text/JSON rejection, RPC notification, trusted discovery, `/reload`, session replacement and shutdown.
- The fenced-code-aware README heading audit and diff whitespace review passed.
- [GitHub CI](https://github.com/narumiruna/pi-extensions/actions/runs/39543297781) passed its checks and test gates for implementation commit `57cf5295`.

Two full root attempts failed unchanged `pi-sync` timing assertions: journal recovery, and once the unchanged-refuse takeover case. A focused rerun and subsequent complete plain `npm test` runs passed, including the final 12,381-test run, without changing Sync or increasing a timeout. A direct Notify suite with macOS's noncanonical temp path also exposed an existing `/var` versus `/private/var` fixture mismatch; the canonical-temp focused run and root runner passed.

Direct interactive terminal/desktop-browser smoke is not run in this non-interactive execution environment. Generated Jiti TUI callbacks, real HTTP assets, the browser suite, and RPC reload cover the changed paths deterministically; live terminal rendering remains unverified. Linux CI checks and tests passed. Windows behavior and live notification-provider delivery were not newly verified. No packages, version tags or release workflows were published or dispatched.
