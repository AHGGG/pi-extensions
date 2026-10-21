---
"@narumitw/pi-usage": minor
---

Add the read-only `usage:query:v1`, `usage:capabilities:v1`, and `usage:changed:v1` event protocols for other Pi extensions. Refresh requests preserve authentication policy, cancellation, failure backoff, and session ownership without changing UI or model context. Cache-only reads conservatively return `cache-miss` because Pi cannot prove effective auth identity without potentially doing network work. Document protocol timestamps in milliseconds and include a bounded consumer example.
