# Codex Compact settings reference

Use `/codex-compact` → **Settings** in TUI mode, or edit `<getAgentDir()>/pi-codex-compact.json` manually and reload Pi. The normal path is `~/.pi/agent/pi-codex-compact.json`. This user-wide file holds global defaults and provider-specific choices; there are no project overrides or extension-specific environment-variable overrides. Effective settings apply built-in defaults, then recognized global fields, then the selected provider’s mode and protocol overrides. Pi and the selected provider own credentials.

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
| `enabled` | `true` | Boolean | Use the selected compaction mode and replay compatible opaque checkpoints. | Keep enabled when a session needs an existing checkpoint; disabling it also disables replay. |
| `compactionMode` | `"provider-checkpoint"` | `"provider-checkpoint"` or `"text-summary"` | Select a provider-generated opaque checkpoint or an experimental text summary through normal Responses inference. Applies to foreground and prepared results. | Select Text summary without disabling `enabled`; existing opaque history still needs compatible replay for conversion. |
| `protocol` | `"auto"` | `"auto"`, `"remote-v2"`, `"responses-compact"`, or `"context-management"` | Used only in Provider checkpoint mode. Auto permits one same-provider Context Management attempt after a third-party Compact endpoint returns 403/404/405/501; verified official OpenAI ChatGPT OAuth resolves to Context Management for every preference. | Keep `auto` for automatic proxy compatibility; choose an explicit protocol to prevent negotiation. |
| `providerOverrides` | `{}` | Object keyed by the exact Pi provider ID, with optional `compactionMode` and `protocol` fields | Override only mode and protocol for that provider; missing fields inherit global values. | Use Save current settings for this provider to preserve a snapshot of the displayed global mode and protocol. |
| `apiProfiles` | `{}` | Object mapping a custom API id to `"codex-responses-v1"` | Explicitly opts a non-built-in API into Codex-compatible request fields and replay. | Leave empty unless the provider documents Codex Responses compatibility. |
| `requestTimeoutMs` | `300000` | Integer from 30,000 to 1,800,000 ms | Bound one extension-owned checkpoint or text-summary request; prepared requests expose this deadline to their caller. | The menu offers 5–30 minutes in five-minute steps. Longer limits also permit longer foreground and recovery waits; separate server and network timeouts still apply. |
| `maxRetries` | `2` | Integer from 0 to 2 | Bound transient provider-opening retries. Text summary failure preserves history. | Keep two; use zero when diagnosing the first failure. |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate replacement text; Text summary also caps its output budget by this value and model limits. For Context Management, bound serialized post-checkpoint output instead. | Keep 64K. Context Management fails closed rather than truncating an oversized suffix. |
| `appendMaintenanceMessage` | `true` | Boolean | Append the maintenance user message to Context Management requests; also include scratchpad context in Text summary and recovery when scratchpad is enabled. Off omits these additions, not required summary instructions or the server compaction field. | Keep on for the existing behavior; off is an experimental comparison, not a demonstrated timeout fix. |
| `maintenanceMessage` | Built-in continuation-handoff instruction | Non-blank string, at most 16 KiB UTF-8 | Customize the Context Management maintenance message; ignored when append is off. The menu offers Edit and Reset to default. | Preserve request-local scope and original task instructions; custom text can affect the checkpoint and later continuation. |
| `notifyOnFallback` | `true` | Boolean | Warn on failed compaction and unsuccessful checkpoint recovery. | Keep enabled so silent fallback does not hide protocol or entitlement problems. |
| `checkpointRecovery` | `"summarize"` | `"summarize"` or `"cancel"` | After remote failure with a valid compatible checkpoint, try a normal inference summary; request failure falls back to Pi native and may lose opaque-only older context. Cancel avoids recovery and native fallback. Integrity failures and cancellation still cancel. | Use `summarize` to prioritize progress, accepting possible context loss and quota for recovery plus native summarization; use `cancel` to preserve the checkpoint without summary quota. |

Missing fields use defaults. Existing saved timeouts, including shorter legacy values, stay unchanged until explicitly edited. Pi's separate `httpIdleTimeoutMs` setting does not change this extension deadline.
Settings reload on every `session_start`, including `/reload`, resume, and fork.
Pi’s native multiline editor expands pasted text and trims outer whitespace; direct JSON edits preserve the configured string exactly. Menu writes apply immediately, preserve unknown JSON fields, serialize within the current Pi process, and use a final conflict check plus same-directory atomic rename. Successful provider-relevant changes (including compaction mode and both maintenance settings) invalidate captured preparations; failed saves keep the previous effective settings.
On Unix, temporary files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files remain unchanged.
Defaults stay active, and the menu remains read-only until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the user can reopen Settings and retry.

API profile keys must be non-empty custom API IDs of at most 256 characters, with no whitespace or control characters. Built-in API IDs and `__proto__`, `constructor`, or `prototype` are not accepted. The only profile value is `"codex-responses-v1"`.


## Provider-specific choices

The Settings menu always edits global defaults and shows the captured provider ID. **Save current settings for this provider** saves both displayed values, **Compaction mode** and **Protocol**, as a durable provider snapshot when selected with Enter or Space. Later global edits do not replace those saved values. Existing overrides remain unchanged until explicitly replaced or reset; the menu shows them separately from the global controls. **Use global defaults for this provider** removes the two overrides and resumes inheritance. All other settings remain global. A provider switch closes the old menu rather than applying its choices to a different provider.

```json
{
  "compactionMode": "provider-checkpoint",
  "protocol": "auto",
  "providerOverrides": {
    "my-proxy": {
      "compactionMode": "text-summary"
    }
  }
}
```

Keys are actual `model.provider` IDs, not model names, API types, or authentication methods. Use distinct provider IDs if two configurations need different choices. Nothing is automatically added for official or custom providers, and credentials do not change.

The map accepts at most 128 providers. IDs must be nonempty, at most 256 characters, without leading/trailing whitespace or control characters. `__proto__`, `constructor`, and `prototype` are rejected. Known fields must contain the values in the table above; unknown fields are ignored and preserved during menu saves and resets. The existing 64 KiB file limit still applies.

Foreground and background preparation use the same effective settings. Changing another provider’s overrides does not invalidate active work. Changing effective settings for the current provider does invalidate it; provider/model switches retain the existing cancellation checks. Resetting an override resumes inheritance. Existing checkpoints retain their issuing provider and protocol safety checks.

## Text summaries and background preparation

Choose **Compaction mode → Text summary** in the menu to change the global default, or set `"compactionMode": "text-summary"`. Save the displayed settings for the current provider when it should retain its own snapshot. This mode directly requests a bounded continuation summary using a supported Responses adapter. It does not try provider checkpoint protocols first. The `protocol` preference is retained for switching back, but does not choose the summary request route. Keep `enabled: true`: turning it off also disables replay of existing opaque checkpoints.

A compatible companion controls background preparation, threshold, and **Apply when ready**. Those settings are not changed here. With auto-apply On, a ready summary can replace its captured prefix at the next safe boundary while preserving later messages and tool results. A mode change invalidates preparations from the previous mode. Summary failure or cancellation preserves the current conversation.

Preparing a summary does not change the main conversation. Applying it changes the request prefix, so cache reuse may decrease on the next request; later requests can reuse the new prefix. Text summaries use inference quota, are lossy, and do not guarantee a cache hit or complete recall.

## Relationship to Codex configuration

This extension does **not** read `~/.codex/config.toml`.

| Codex setting | Extension behavior |
| --- | --- |
| `features.remote_compaction_v2` | Conceptually corresponds to `protocol: "remote-v2"`; it is not imported. |
| `model_auto_compact_token_limit` | Not duplicated. Pi's own compaction threshold remains authoritative. |
| `model_auto_compact_token_limit_scope` | Not supported; Pi extensions do not own Codex's compact-window lineage. |
| `compact_prompt` / `experimental_compact_prompt_file` | Not imported; opaque checkpoints are generated by the server. |
| `features.token_budget` | Not supported; token-budget context reset is a different experimental strategy. |

See the [README](../README.md#settings) for first-use instructions and [implementation reference](./implementation.md) for protocol and replay details.

Preparation scheduling preferences are consumer-owned. The engine emits safe bounded operation diagnostics in UI modes, independently of fallback warning preferences. Legacy fields are preserved as unknown fields, not applied by this engine.
