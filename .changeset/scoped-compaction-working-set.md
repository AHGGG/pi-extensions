---
"@narumitw/pi-codex-compact": patch
---

Validate compaction ownership against ordered ancestry, active projected input, and the latest checkpoint instead of repeatedly serializing irrelevant archived bodies and superseded opaque payloads. Preserve fresh authentication and lifecycle guards, exact application-boundary suffix protection, and authoritative replay checks for older cutoffs and context edits. Archived-only mutations are now accepted when they cannot change effective input or replay. Also revalidate foreground handoff after notification and status-cleanup callbacks.
