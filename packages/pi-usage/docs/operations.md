# Usage queries, Fast mode, and reset redemption

[Back to README](../README.md#-commands)

## Choose a provider target

A target is the provider-owned account, organization, project, team, or workspace used for one usage query.
Providers without target discovery query immediately; a single returned target is selected automatically without saving settings.
When several targets exist, `/usage` remembers an explicit selection by provider and reuses it only while it remains in a fresh listing.
A missing remembered target reports **Selection required** instead of querying another target silently.
Use **Select <target>…** for the current provider or **Change <target>…** for a ready current or individually viewed provider.

Viewing another provider may open one target prompt after that provider is queried lazily.
Cancelling changes nothing.
Authentication and target membership are revalidated before saving an explicit selection, then resolved again before billing is queried.
**View all configured providers…** never opens nested target prompts; view an unresolved provider individually to select its target.
Background refresh also remains non-interactive and reports `selection required` until `/usage` completes the choice.
Fireworks accounts are the first implementation of this provider-neutral flow.

For credentials, endpoints, and provider-specific meanings, see the [provider reference](./providers.md).
For selection storage and migration, see [Settings](../README.md#-settings).

## Codex Fast mode

Run `/fast` without arguments to toggle Fast for the active supported Codex model, or use **Turn Fast mode on/off** in `/usage`.
Fast is about 1.5× faster and uses more of your plan allowance.
The `codexFastMode` preference defaults to Off.

Fast applies to official `openai-codex-responses` requests at `https://chatgpt.com` when the current account's Codex model directory advertises a `priority` service tier or the legacy `fast` speed tier.
Discovery validates the active OAuth account and caches its model capabilities for five minutes, with background refresh on session and model changes.
`/fast` and `/usage` can refresh capability information before enabling Fast or displaying its controls, while provider request hooks use the account-validated cache and leave directory refresh in the background.

The `fast` label indicates requested priority routing, not a measured speedup; actual availability and speed depend on the service.
It sends `service_tier: "priority"` while enabled and supported, and explicit `service_tier: "default"` otherwise.
The statusline adds `fast` only while the preference is effective, for example `codex fast 59% ↻ 2h30m` with the default reset countdown.
A missing model, incomplete capability information, or first directory failure displays **Unknown** and uses standard routing, with `codex (Fast unknown)` shown when the preference remains enabled.
Temporary network failures reuse successful discovery for the same account, while authentication rejection or malformed directory data invalidates that account's capability information.
The preference can still be turned off while capability information is unknown.
Other providers, APIs, and custom or proxy origins retain their own request payloads.

A toggle affects provider requests whose payload hook starts after the save; a request already sent is unchanged.
Repair or remove an invalid file, then run `/reload` before trying the toggle again.

## Redeem a Codex usage reset

For the current OpenAI Codex OAuth account, **Redeem usage limit reset…** checks fresh earned-reset details, lets you choose a reset, and previews its exact effect before confirmation.
Custom or proxy origins are rejected before mutation.
**No, go back** is the safe default, and cancellation before confirmation sends no mutation.

After confirmation, the reset cannot be cancelled from its progress view; session replacement or shutdown still aborts owned work.
A transport failure offers **Try again** with the same redemption request ID so the backend can handle an uncertain retry idempotently.
Successful, already-completed, not-needed, and no-credit outcomes are reported separately, then usage and the statusline refresh for the still-current account.
