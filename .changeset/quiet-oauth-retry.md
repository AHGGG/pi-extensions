---
"@narumitw/pi-accounts": patch
---

Retry provider OAuth lookups after a failed load instead of caching the rejection until restart. Keep current-call failures, concurrent lookup sharing, and successful lookup caching unchanged.
