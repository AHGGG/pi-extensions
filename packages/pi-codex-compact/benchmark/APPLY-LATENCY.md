# Offline async-checkpoint apply-latency benchmark

This benchmark times the **real extension `turn_end` handler**, including its outer ownership and branch checks, rather than timing only `warmCompactionDraft()`. It makes no network or paid model calls. A synthetic ChatGPT OAuth provider prepares one context-management checkpoint; after readiness, a completed tool pair is appended and the next turn boundary adopts that checkpoint without another provider request.

From the repository root with dependencies installed:

```bash
node packages/pi-codex-compact/benchmark/apply-latency.mjs > apply-after.json
node packages/pi-codex-compact/benchmark/apply-latency.mjs \
  --source-dir /path/to/baseline/packages/pi-codex-compact/src > apply-before.json
```

Use the same harness, options and dependency directory for both versions. `--node-modules-dir /path/to/node_modules` selects an existing installation without changing manifests or installed dependencies. Other options are `--historical-mib` (64), `--samples` (3), and `--auth-delay-ms` (20). The source selection defaults to this package's current source. The runner records the worker bundle SHA-256, selected dependency versions, Node version and platform, and removes its temporary worker afterward.

## What is measured

The session contains four previous native compactions and the requested MiB of unique, flat historical ASCII strings in chunks no larger than 256 KiB. The active projected context is intentionally small. Usage is reported as 65% solely to open the warm-ahead threshold gate; it is not a measurement of actual fixture tokens.

Each sample uses two **separate fresh processes**:

- **Timing:** wall time and process CPU time for preparation up to injected transport, completion to readiness, and the complete ready-checkpoint `turn_end` handler. Both request-auth and provider-auth refreshes wait for the configured synthetic delay; their observed spans are recorded separately. No explicit GC runs inside these measured operations. Native in-memory append, confirmation and context replay are timed separately from the extension's draft-return boundary.
- **Retained memory:** explicit double GC at the initial fixture baseline, pending preparation, readiness, each pending authentication lookup, returned draft, and committed/released job. These apply durations include GC probes and **must not be used as latency results**. Compare phase `heapUsed` with the same process's baseline. `maxRSS` includes imports and transient allocations and is not peak JavaScript heap.

Assertions require one preparation/provider request, exactly one draft, fresh request and provider auth lookups at application, no `ctx.compact()` call during active work, no premature commit, and preservation of the completed tool output through Pi's real `SessionManager` append and the extension's replay hook. Global `fetch` fails closed. The fixture records the extension's timing notices when available but does not need those diagnostics to time the outer boundary. Successful diagnostic timings are emitted only when the next public hook confirms the returned checkpoint was persisted; their `extensionTotal` measures extension work before draft return, not native commit time, the delay to that confirming hook, or UI rendering. Rejected application timings can be reported immediately.

## Scope

The benchmark uses real installed Pi projection/persistence APIs and the production extension hook, but a synthetic provider and UI facade—not a live model or the full interactive TUI event loop. It does not measure disk-backed session persistence, real auth refresh latency, terminal rendering, Windows allocation behavior, or concurrent tools/UI load. Process CPU can differ from wall time because of scheduling and V8 work. Subtracting the observed auth waits helps separate injected delay from local work, but is not a guarantee that all remaining wall time is synchronous CPU.

This isolates duplicated validation and archived-payload serialization at application. Historical data still belongs to Pi. Validation still walks branch ancestry and checks active projected contributions plus the latest checkpoint and its replay dependencies; it does not fingerprint irrelevant archived bodies or superseded checkpoint payloads. Large active projections, latest checkpoint payloads, and replay-relevant history can still cost time and memory. Faster synthetic application does not prove that every reported UI pause is fixed. This is a reproducible investigation tool, not a CI latency threshold.

## Controlled comparison

Measured on Linux x64, Node 24.19.0, with `pi-ai`, `pi-agent-core`, `pi-coding-agent` and `pi-tui` all at 1.2.0. The same harness and dependency resolver compared baseline `6ca710ad5d7afb6eef67aad0f38bda6a21271c69` with the apply-validation optimization. Each version used three fresh timing processes and three separate retained-memory processes, the default 64 MiB fixture, and a 20 ms injected delay at each authentication lookup. All 12 workers passed their assertions with exactly one synthetic provider request each.

Median timings (GC-probe workers excluded):

| Phase | Before | After |
| --- | ---: | ---: |
| Preparation to injected transport, wall | 1,346 ms | 1,172 ms |
| Transport release to readiness, wall | 887 ms | 920 ms |
| Complete application `turn_end`, wall | 5,214 ms | 2,133 ms |
| Complete application `turn_end`, process CPU | 5,230 ms | 2,099 ms |
| In-memory native append, confirmation and replay, wall | 1.13 ms | 1.18 ms |

The measured extension boundary was 59.1% shorter (2.45× as fast). The three before application wall times ranged from 5,096–5,427 ms; after ranged from 2,097–2,197 ms. Both versions spent about 41 ms in the two injected auth waits. The optimized diagnostics reported eight validation phases with a median 1,954 ms total validation time, so validation remains substantial; this is not a claim that all application work or UI pauses disappear.

Median **additional retained heap above the same worker's fixture baseline**, after explicit GC:

| Phase | Before | After |
| --- | ---: | ---: |
| Preparing, injected transport pending | 64.22 MiB | 0.19 MiB |
| Ready checkpoint | 64.58 MiB | 0.55 MiB |
| Application request-auth pending | 128.67 MiB | 0.60 MiB |
| Application provider-auth pending | 128.68 MiB | 0.61 MiB |
| Draft returned | 64.67 MiB | 0.64 MiB |
| Committed, job released | 0.63 MiB | 0.64 MiB |

The initial fixture itself retained about 99.37 MiB in both versions. Process-lifetime maximum RSS medians in the memory workers were 500.76 MiB before and 286.67 MiB after. The previous direct-draft [memory harness](MEMORY.md) bypassed the outer `turn_end` full-history string and therefore could not measure this additional retention; its figures are not interchangeable with these full-boundary figures.

Worker bundle SHA-256: before `ecf0aef36678993786474042689ce1feb5c9a47890e7cddc99178b85f481acf3`; after `c8061770a2f3cafcf5a4721f0ae7bf074d1d92d46bc2cfb3ded55be8f3d9e620`. These hashes include bundled source paths and harness bytes, so they identify these runs rather than portable release artifacts. No dependency manifests or installed modules were changed. Windows and Node 24.21.0 were not measured.

## Working-set validation comparison

The same unchanged harness compared main `8bc7f32f46caae934161ffe2d49cc3104fd5a106` with this working-set validation change on Linux x64, Node 24.19.0, and Pi 1.2.0. Each size/version used three fresh timing workers and three separate retained-memory workers, with a 20 ms injected delay at each authentication lookup. All 36 workers passed the assertions with one synthetic provider request each. No network or paid provider calls were made.

Only the archived payload size and corresponding entry count varied. Before the identical tool pair was appended, every fixture projected the same three messages: the latest native summary, its retained anchor, and a small tail (215 JSON bytes with all timestamps normalized to zero). The 16, 64, and 256 MiB fixtures contained 73, 265, and 1,033 raw entries respectively.

Median complete `turn_end` application measurements, excluding GC-probe workers:

| Archived payload | Before wall | After wall | Before validation | After validation | After process CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| 16 MiB | 579.0 ms | 47.4 ms | 498.0 ms | 2.4 ms | 10.1 ms |
| 64 MiB | 2,285.9 ms | 51.0 ms | 2,100.6 ms | 5.4 ms | 19.9 ms |
| 256 MiB | 8,836.2 ms | 69.1 ms | 8,260.7 ms | 18.6 ms | 58.2 ms |

Both versions still executed eight validation phases and spent about 41 ms in injected authentication waits. At 256 MiB, the three before wall times were 8,705–9,679 ms and the three after wall times were 68.1–71.0 ms. Median preparation-to-transport time at that size fell from 5,151.0 to 18.4 ms; completion-to-readiness fell from 3,869.2 to 19.0 ms. Native in-memory append, confirmation, and replay remained separately measured: 2.64 ms before and 2.48 ms after.

The optimization removes repeated serialization proportional to irrelevant archived payload bytes, not all history-dependent work: ancestry traversal still scales with entry count, and active/replay-relevant content still needs validation. It deliberately accepts archived-body edits only when ancestry, effective input, and checkpoint replay are unchanged; it is not an equivalent full-raw-history immutability contract. This fixture has native historical summaries, not large active opaque checkpoint payloads.

Retained heap remains small above the existing fixture: at 256 MiB, median request-auth-pending additional heap was 0.65 MiB before and 0.71 MiB after; draft-returned additional heap was 0.70 MiB before and 0.73 MiB after. Both fixtures retained about 291.66 MiB before extension work. Process-lifetime maximum RSS was 530.73 MiB before and 467.96 MiB after, which is not a peak-JavaScript-heap measurement.

Worker bundle SHA-256: before `cc45a4c949148ab3e88d4f8116d6551ab2383e4de73aea2931c8ce4e62549101`; after `858ab94e231e6611302ef27232976628de53a73ebee050b26a6bf432690e6935`. Each hash was identical across its three archive sizes. The dependency installation and harness were unchanged. These synthetic Linux results do not establish a latency ceiling or demonstrate that the reported Windows/Node 24.21.0 pause is fixed; that environment and real-session active sizes remain unmeasured.
