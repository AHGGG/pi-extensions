---
"@narumitw/pi-codex-compact": patch
---

Continue work after successful automatic Context Management compaction without another user message. Reuse Pi-owned retries and queued work, or append one persisted continuation message through the settlement boundary, with at most one forced continuation per user run. Preserve cancellation, exact checkpoint replay, and normal tool access; manual compaction and other protocols remain unchanged.

Replace the maintenance request's fixed `OK` reply with a concise work handoff and request-local tool restrictions. Additional inference and tool actions can consume quota; hosted model compliance and the root cause of issue #1538 remain unverified.
