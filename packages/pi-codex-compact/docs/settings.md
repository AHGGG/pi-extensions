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
| `protocol` | `"auto"` | `"auto"`, `"remote-v2"`, `"responses-compact"`, or `"context-management"` | Auto permits one same-provider Context Management attempt after a third-party Compact endpoint returns 403/404/405/501; verified official OpenAI ChatGPT OAuth resolves to Context Management for every preference. | Keep `auto` for automatic proxy compatibility; choose an explicit protocol to prevent negotiation. |
| `apiProfiles` | `{}` | Object mapping a custom API id to `"codex-responses-v1"` | Explicitly opts a non-built-in API into Codex-compatible request fields and replay. | Leave empty unless the provider documents Codex Responses compatibility. |
| `requestTimeoutMs` | `300000` | Integer from 30,000 to 1,800,000 ms | Bound one extension-owned remote request; prepared requests expose this deadline to their caller. | The menu offers 5–30 minutes in five-minute steps. Longer limits also permit longer foreground and recovery waits; separate server and network timeouts still apply. |
| `maxRetries` | `2` | Integer from 0 to 2 | Retry transient provider transport failures before Pi fallback. | Keep two; use zero when diagnosing the first failure. |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate retained user-message text; for Context Management, bound serialized post-checkpoint output instead. | Keep 64K. Context Management fails closed rather than truncating an oversized suffix. |
| `appendMaintenanceMessage` | `true` | Boolean | Append the maintenance user message only to Context Management requests. Off omits the message entirely, not the server compaction field. | Keep on for the existing behavior; off is an experimental comparison, not a demonstrated timeout fix. |
| `maintenanceMessage` | Built-in continuation-handoff instruction | Non-blank string, at most 16 KiB UTF-8 | Customize the Context Management maintenance message; ignored when append is off. The menu offers Edit and Reset to default. | Preserve request-local scope and original task instructions; custom text can affect the checkpoint and later continuation. |
| `notifyOnFallback` | `true` | Boolean | Warn on remote failure and unsuccessful checkpoint recovery. | Keep enabled so silent fallback does not hide protocol or entitlement problems. |
| `checkpointRecovery` | `"summarize"` | `"summarize"` or `"cancel"` | After remote failure with a valid compatible checkpoint, try a normal inference summary; request failure falls back to Pi native and may lose opaque-only older context. Cancel avoids recovery and native fallback. Integrity failures and cancellation still cancel. | Use `summarize` to prioritize progress, accepting possible context loss and quota for recovery plus native summarization; use `cancel` to preserve the checkpoint without summary quota. |

Missing fields use defaults. Existing saved timeouts, including shorter legacy values, stay unchanged until explicitly edited. Pi's separate `httpIdleTimeoutMs` setting does not change this extension deadline.
Settings reload on every `session_start`, including `/reload`, resume, and fork.
Pi’s native multiline editor expands pasted text and trims outer whitespace; direct JSON edits preserve the configured string exactly. Menu writes apply immediately, preserve unknown JSON fields, serialize within the current Pi process, and use a final conflict check plus same-directory atomic rename. Successful provider-relevant changes (including both maintenance settings) invalidate captured preparations; failed saves keep the previous effective settings.
On Unix, temporary files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files remain unchanged.
Defaults stay active, and the menu remains read-only until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the user can reopen Settings and retry.

API profile keys must be non-empty custom API IDs of at most 256 characters, with no whitespace or control characters. Built-in API IDs and `__proto__`, `constructor`, or `prototype` are not accepted. The only profile value is `"codex-responses-v1"`.


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

Preparation scheduling preferences are consumer-owned. The engine emits safe bounded operation diagnostics in UI modes, independently of fallback warning preferences. Legacy fields are preserved as unknown fields, not applied by this engine.
