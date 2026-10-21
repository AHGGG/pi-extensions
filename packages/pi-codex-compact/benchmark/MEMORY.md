# Offline warm-compaction memory benchmark

This benchmark measures the extension's historical-payload amplification, not the cause of a real Pi out-of-memory crash. It makes **no network or paid model calls**: an injected synthetic provider drives the real `startWarmCompaction()` and `warmCompactionDraft()` implementations, and any use of global `fetch` fails.

From the repository root, with dependencies installed:

```bash
node packages/pi-codex-compact/benchmark/memory.mjs > memory-after.json
```

To compare a previous source tree using the **same harness and installed dependencies**:

```bash
node packages/pi-codex-compact/benchmark/memory.mjs \
  --source-dir /path/to/baseline/packages/pi-codex-compact/src > memory-before.json
```

Options are `--historical-mib` (default 64), `--cycles` (4), `--samples` (3), and `--source-dir` (the current package source). The runner bundles the chosen extension source into a temporary worker, records its SHA-256, and runs each sample in a fresh `node --expose-gc` process. Temporary files are removed afterward. The benchmark is repository-only and is not a CI memory threshold.

## Method

The fixture contains four previous native compactions and 64 MiB of unique, flat ASCII message strings in chunks no larger than 256 KiB. This avoids V8's external-string allocation threshold for large `Buffer.toString()` results. The current projected context contains only the latest native summary, its retained anchor, and a short tail. Reported usage is fixed at 65% to exercise the warm-ahead threshold; it is not the fixture's actual token count.

Each process runs four jobs against the same session: ready/adopt, cancel, ready/adopt, cancel. Ready jobs are sampled while the injected fetch is pending, after completion, while adoption waits for an authentication refresh, and after a validated draft returns. Cancellation jobs are aborted while preparing and settled before release. Each job reference and transport gate is then released; two event-loop turns and two explicit garbage collections precede the retained-memory sample. Drafts are validated but not appended, so the session does not grow between cycles. Assertions require every preparation to reach the injected transport, every successful job to produce a valid draft, every canceled job not to become ready, and exactly one synthetic request per cycle.

The JSON records `process.memoryUsage()` at each phase, process-lifetime `maxRSS` in KiB, runtime/platform, fixture size, and preparation timing. Compare phase `heapUsed` with that process's initial baseline. `maxRSS` includes imports, fixture construction, and transient allocations; it is not peak JavaScript heap and can vary with allocator and host behavior. GC samples intentionally describe retention rather than every transient heap allocation.

## Scope and limits

This isolates unnecessary copies of old, already-compacted text while preserving Pi's resident full history. It does not simulate every real session, image payload, provider implementation, concurrent UI/tool load, or Windows allocator behavior. The fixture's active context is intentionally small; projection-sized request copies and unusually large individual entries can still consume substantial memory. Lower memory in this harness does **not** prove that a particular 4 GiB OOM is fixed or identify its root heap owner.

## Controlled measurement

Measured on Linux x64, Node 24.19.0 and local Pi 1.2.0 peers, comparing the failure-pause baseline `0618dd69` with the historical-copy reduction. These are three fresh processes per version with the default fixture and four cycles per process. The first-cycle medians below are **additional retained JavaScript heap above the same process's fixture baseline**, after explicit GC:

| Phase | Before | After |
| --- | ---: | ---: |
| Preparing, injected fetch pending | 128.25 MiB | 0.17 MiB |
| Ready checkpoint | 128.63 MiB | 0.54 MiB |
| Auto-adoption, authentication pending | 320.80 MiB | 0.58 MiB |
| Draft returned, job still held | 128.71 MiB | 0.61 MiB |
| Job released | 0.56 MiB | 0.59 MiB |

The fixture baseline itself was about 96.42 MiB of heap in both versions. Process-lifetime maximum RSS medians were 812.84 MiB before (range 812.79–826.23) and 284.28 MiB after (283.22–284.45). After the fourth cycle, the optimized version's retained heap was within 0.76 MiB of its starting baseline; these few cycles are not a general leak proof. All 24 jobs across both versions passed the ready/adoption or cancellation assertions with one mock request each.

The worker bundle SHA-256 values for these runs were `630bd7464fe1a3014a490e166557c1783f2ab0a3da561020b130352a8b0b0e3c` (before) and `c1dcd3dc499c058c6a257d9a6eab1e33887b8a498d3ccffa8e13397f540d540c` (after). The bundle hash includes source paths and harness bytes, so it is evidence for these runs rather than a portable release identifier. The Pi 1.2.0 pass used the same worker bundles with temporary dependency resolution pointed at existing local peers; it did not change repository dependencies. This is not a measurement on Windows or Node 24.21.0.

The same three-process comparison also passed with the repository's installed Pi 1.1.0 peers: extra heap medians were 128.25→0.21 MiB preparing, 128.63→0.55 MiB ready, and 320.80→0.58 MiB during adoption; maximum RSS medians were 827.86→291.00 MiB.

An additional optimized-only Pi 1.1.0 run with `--historical-mib 32 --cycles 16 --samples 1` passed eight ready/adoption and eight cancellation cycles, with exactly 16 mock requests. Released heap rose from a 69.31 MiB baseline to 70.51 MiB after cycle 16 (1.19 MiB additional), rather than retaining another historical-payload copy per job. This remains a bounded synthetic check, not a claim of zero long-run allocation growth.
