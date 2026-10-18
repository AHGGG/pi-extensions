---
"@narumitw/pi-goal": patch
---

Publish the Goal contract when a Goal is started, resumed, or edited while the agent is busy, so it is persisted once at the turn boundary instead of being appended at the tail of every request until the current run ends.
