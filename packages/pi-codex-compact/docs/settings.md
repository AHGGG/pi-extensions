# Codex Compact settings reference

Use `/codex-compact` → **Settings** in TUI mode, or edit `<getAgentDir()>/pi-codex-compact.json` manually and reload Pi. The normal path is `~/.pi/agent/pi-codex-compact.json`. This file is global-only: there are no project overrides or extension-specific environment-variable overrides. Effective settings are defaults with recognized user-file fields applied. Pi and the selected provider own credentials.

An absent file uses defaults without creating a file. Save only the fields you need to change. For example, this opts a compatible custom API into Responses compaction:

```json
{
  "apiProfiles": {
    "custom-responses": "codex-responses-v1"
  }
}
```

## Fields and persistence

| Setting | Default | Accepted values | Behavior | Recommendation |
| --- | ---: | --- | --- | --- |
| `enabled` | `true` | Boolean | Attempt remote compaction and replay compatible opaque checkpoints. | Keep enabled when a session needs an existing checkpoint; disabling it also disables replay. |
| `asyncEnabled` | `false` | Boolean | Enable experimental background checkpoint preparation after safe completed turns for reuse by plain manual or Pi automatic compaction. | Leave off unless unused-request quota and uncertain latency gains are acceptable; pending preparation still uses foreground manual compaction. |
| `asyncAutoApply` | `false` | Boolean | Apply a ready checkpoint after the current model/tool batch or before the next idle input; requires `enabled` and `asyncEnabled`. | Enable to avoid manually applying ready checkpoints. Never interrupts active work or starts another inference request. |
| `asyncThresholdPercent` | `65` | Integer from 1 to 99 | Minimum context-window usage percentage for background preparation. | This is a preparation threshold, not a replacement for Pi's automatic compaction threshold. |
| `protocol` | `"auto"` | `"auto"`, `"remote-v2"`, `"responses-compact"`, or `"context-management"` | Select a preferred protocol; verified official OpenAI ChatGPT OAuth resolves to Context Management for every preference. | Keep `auto`; select Context Management explicitly for other compatible backends. |
| `apiProfiles` | `{}` | Object mapping a custom API id to `"codex-responses-v1"` | Explicitly opts a non-built-in API into Codex-compatible request fields and replay. | Leave empty unless the provider documents Codex Responses compatibility. |
| `requestTimeoutMs` | `300000` | Integer from 30,000 to 900,000 ms | Bound one extension-owned remote request; background preparation and its adoption wait share this deadline. | The 15-minute option permits longer compaction requests; separate server and network timeouts still apply. |
| `maxRetries` | `2` | Integer from 0 to 2 | Retry transient provider transport failures before Pi fallback. | Keep two; use zero when diagnosing the first failure. |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate retained user-message text; for Context Management, bound serialized post-checkpoint output instead. | Keep 64K. Context Management fails closed rather than truncating an oversized suffix. |
| `logCompaction` | `false` | Boolean | Show async preparation and actual compaction lifecycle notices in TUI and RPC. | Enable to see starts, readiness, waits, reuse, foreground fallback, cancellation, and committed completion; no conversation or credential contents are logged. |
| `notifyOnFallback` | `true` | Boolean | Warn on remote failure and unsuccessful checkpoint recovery. | Keep enabled so silent fallback does not hide protocol or entitlement problems. |
| `checkpointRecovery` | `"summarize"` | `"summarize"` or `"cancel"` | After remote failure with a valid compatible checkpoint, try a normal inference summary; request failure falls back to Pi native and may lose opaque-only older context. Cancel avoids recovery and native fallback. Integrity failures and cancellation still cancel. | Use `summarize` to prioritize progress, accepting possible context loss and quota for recovery plus native summarization; use `cancel` to preserve the checkpoint without summary quota. |

Missing fields use defaults.
Settings reload on every `session_start`, including `/reload`, resume, and fork.
Menu writes apply immediately, preserve unknown JSON fields, serialize within the current Pi process, and use a final conflict check plus same-directory atomic rename. Successful settings changes except `logCompaction` and `asyncAutoApply` discard pending or ready warm-ahead work; failed saves keep the previous effective settings.
On Unix, temporary files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files remain unchanged.
Defaults stay active, and the menu remains read-only until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the user can reopen Settings and retry.

API profile keys must be non-empty custom API IDs of at most 256 characters, with no whitespace or control characters. Built-in API IDs and `__proto__`, `constructor`, or `prototype` are not accepted. The only profile value is `"codex-responses-v1"`.

For enablement warnings, adoption behavior, and cache limitations, see [Experimental warm-ahead](../README.md#experimental-warm-ahead). The menu offers common threshold percentages; manual settings accept every integer in the documented range.

## Relationship to Codex configuration

This extension does **not** read `~/.codex/config.toml`.

| Codex setting | Extension behavior |
| --- | --- |
| `features.remote_compaction_v2` | Conceptually corresponds to `protocol: "remote-v2"`; it is not imported. |
| `model_auto_compact_token_limit` | Not duplicated. Pi's own compaction threshold remains authoritative. |
| `model_auto_compact_token_limit_scope` | Not supported; Pi extensions do not own Codex's compact-window lineage. |
| `compact_prompt` / `experimental_compact_prompt_file` | Not imported; opaque checkpoints are generated by the server. |
| `features.token_budget` | Not supported; token-budget context reset is a different experimental strategy. |

See the [README](../README.md#-settings) for first-use instructions and [implementation reference](./implementation.md) for protocol and replay details.
