---
"@narumitw/pi-goal": patch
---

Deduplicate Goal contracts that are queued during run startup or another busy publication. Preserve ordered active/inactive revisions and restore contracts after compaction without changing automatic continuation prompts or existing request prefixes.
