---
"@narumitw/pi-progress": minor
---

Add a menu-first `/progress` command with Settings, Status, Help, and Clear widget. Keep `/progress clear` and `/progress settings` as direct routes; the latter edits the five display preferences in the same TUI screen. Successful saves apply immediately, preserve unknown JSON fields, and use ordered atomic publication. Invalid files and failed saves leave the previous settings unchanged. RPC reports the settings file path for manual editing. Frame the settings screen with shared full-width horizontal rules and height-aware active-row retention.
