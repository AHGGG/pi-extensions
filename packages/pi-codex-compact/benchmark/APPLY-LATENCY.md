# Historical apply-latency measurements

These measurements predate the controller extraction. The former full-controller harness has been removed because its lifecycle hooks no longer belong to this engine. They are historical evidence, not measurements of the current build. Use the [engine memory benchmark](MEMORY.md) for current preparation/draft probes.

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
