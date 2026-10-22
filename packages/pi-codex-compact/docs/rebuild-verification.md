# Compaction rebuild verification

Historical verification record from before background extraction. Current background controls and logging belong to the separate pi-background-compaction extension; the old settings examples below are not current core configuration.

## Scope

The rebuild starts from upstream `c8fae75a81f08aecdb6000767b92dcb53634e298`. The original fork tip is `d3108382feee0874c8389f0bd785dd8a46698e89`. Four rebuilt commits end at `0ba6ca5e25b6e8fbc32148a1dd04851be6adb096`; reconciliation commit `c4c69250738093e10cf467539eec7d5a7ad65c8d` preserves the original fork history. Integration uses a normal merge, not a reset or force push.

The OAuth/timeout and warm-ahead changes reuse the existing package-scoped implementations on the newer upstream base. The targeted correction adds a stable ordinary-work replay boundary while preserving the existing bounded continuation scheduler. It does not delete maintenance output, decrypt checkpoints, create a second scheduler, or change the recovery policy.

The handoff prompt is present in the inspected source. The explanation that a resumed model request mistakes the handoff for the task remains a working hypothesis, not a reproduced hosted-model finding.

## Final checks and owner testing decision

On October 16, 2026, the owner requested that integration continue so they could test the final extension. Full repository checks and hosted-model behavior remain unverified; integration for owner testing must not be described as a fully validated release.

Seven replay tests passed against the complete production `protocol.ts` and `checkpoint-replay.ts` modules. Their source bytes and the original test file were checked against Git blob hashes before execution. TypeScript 5.8.3 transpiled the files; only the test runner import was adapted from Vitest to `node:test`. No production function or assertion was substituted. The same two production modules also passed an isolated strict TypeScript check. These results are narrower than `npm run check`, the complete Vitest suite, or a Pi runtime smoke.

Verified source blobs:

- `src/protocol.ts`: `460cd9e13a7bc1e4d6240a3162a50debd0da0cae`
- `src/checkpoint-replay.ts`: `debfba1d576ccb8e1131cd7a0a3b355994057774`
- `test/checkpoint-replay.test.ts`: `66abe125a0b7498a0948f7e6a8ad35a137250d05`

The tests cover intact checkpoint history, newer-message order, stable prefixes, maintenance separation, tool-call pairing, legacy OK output, and fail-closed marker validation. Earlier preparation used protocol excerpts; the final rerun above used the full modules. Existing saved-session and custom-API test expectations were reviewed for the added boundary, but their Pi-dependent suites were not executed here.

Dependency installation, full builds, repository typechecks and lint, Pi/Vitest suites, package-load smoke, and hosted-model smoke could not run in this environment. Fresh attempts could not resolve `github.com` or `registry.npmjs.org`; repository Actions inspection returned no runs. An empty CI list is not a passing result.

The inherited main-push workflow could enter package versioning or publishing. A repository guard now permits the release-selection job only in `narumiruna/pi-extensions`; downstream version, pack, and publish jobs depend on it. The fork retains the CI job without enabling upstream package releases. No package publication, release tag, credential change, or user-machine settings change is part of this work.

## Remaining verification

Read root `AGENTS.md`, `docs/extension-conventions.md`, and `docs/extension-settings.md`, then inspect the actual scripts with `npm run`. Use the repository's required Node version and dependency installation policy. Run `npm run check` and `npm test` separately; ensure the compaction package suite is included, not skipped by affected-test selection. Rebuild Pi TUI Kit before consumer tests and do not run its build concurrently with root checks.

Verify actual Pi lifecycle paths for automatic threshold and overflow compaction, a tool turn, queued user or custom work, repeated compaction, manual compaction, cancellation, session replacement, and saved-checkpoint reload/resume/fork. Check both the ordinary-work boundary and exact request counts. Confirm that maintenance/recovery requests do not receive the work boundary and that new user instructions remain later in the payload. Do not weaken unrelated tests merely to get a passing gate.

Use a controlled task confined to a temporary directory for a hosted-model test. Confirm that after automatic compaction the model performs the next task step rather than merely producing another handoff. Check completed, cancelled, and blocked tasks separately. Stop after one clear entitlement failure. Do not expose credentials, use an unrelated provider, or claim that a mock proves hosted-model behavior.

Refresh both remotes before further integration and reconcile newer commits without resetting either history. Record any additional checks against the exact tested revision. Preserve the release guard and do not publish packages or create release tags without explicit approval.

## Settings and diagnosis

Update the installed Git package, preserving the existing resource filter, then restart Pi:

```sh
pi update git:github.com/AHGGG/pi-extensions@main
```

The extension reads `<getAgentDir()>/pi-codex-compact.json`, normally `~/.pi/agent/pi-codex-compact.json`. The timeout default remains five minutes, with fifteen minutes supported. Pi's separate `httpIdleTimeoutMs` does not set this extension field. To choose fifteen minutes and logs, merge these fields into the existing extension settings rather than replacing other preferences:

```json
{
  "requestTimeoutMs": 900000,
  "logCompaction": true
}
```

Warm-ahead remains off by default, with a configurable preparation threshold of 65%. Test ordinary automatic compaction first, then enable warm-ahead for a separate test. Manual `/compact` does not exercise the automatic-continuation path. Saved logging choices use the existing persistence mechanism. Continuation notices report request preparation or scheduling decisions, not proof of completed coding work.
