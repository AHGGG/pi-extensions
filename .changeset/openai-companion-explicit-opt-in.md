---
"@narumitw/pi-usage": minor
---

Make native OpenAI companion usage default to Off. Enable **Use Codex login for OpenAI usage** in `/usage` Settings only when both logins use the same ChatGPT account and workspace. The extension cannot verify that identity match.

The new `openaiUseCodexUsage` boolean defaults to `false`, including after upgrade. Historical `openaiCompanionUsage` values do not opt in. Native OpenAI shows authentication status and a usage-settings link until explicitly enabled; independent Codex usage, Fast mode, and reset redemption are unchanged.

Disabling cancels pending companion queries and auth waits, invalidates native quota caches, and prevents late results from restoring old reports or status. A successful save restores the active session status refresh even if the Settings screen closes or becomes stale during publication. This does not add reverse fallback or change Pi-owned OAuth renewal. Companion endpoints remain experimental and undocumented.
