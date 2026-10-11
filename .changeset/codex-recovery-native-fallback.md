---
"@narumitw/pi-codex-compact": minor
---

Keep checkpoint-aware recovery first, then use Pi-native compaction if the recovery request fails, times out, or returns invalid output. Native fallback may lose older context stored only in the opaque checkpoint and can consume additional quota. Explicit Cancel, cancellation, stale ownership, and checkpoint projection or backend integrity failures still preserve history by cancelling compaction.
