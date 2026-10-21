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

This isolates duplicated validation and full-history serialization at application. Historical data still belongs to Pi, validation must still inspect persisted values, and unusually large active projections or individual entries can cost time and memory. Faster synthetic application does not prove that every reported UI pause is fixed. This is a reproducible investigation tool, not a CI latency threshold.

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
