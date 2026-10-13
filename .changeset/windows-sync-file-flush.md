---
"@narumitw/pi-sync": patch
---

Fix Windows EPERM errors when syncing snapshot backups and staged recovery files by opening regular files with write access for flushing.
