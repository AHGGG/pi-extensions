---
"@narumitw/pi-codex-compact": patch
---

Reduce checkpoint-preparation and adoption memory amplification by borrowing historical entries under persisted-value fingerprint guards and copying only active provider messages. Preserve ancestry, mutation, context-edit, cancellation, and authentication checks; Pi still owns the full resident session history.
