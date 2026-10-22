---
"@narumitw/pi-codex-compact": patch
---

Reassert provider-native tool declarations after opaque checkpoint replay to address missing tools after compaction and resume. Preserve checkpoint-era schemas and subsequent tool changes without rewriting the request prefix on ordinary turns. Existing compatible checkpoints need no migration. Request-layout regressions are covered by deterministic tests; hosted tool availability still requires validation.
