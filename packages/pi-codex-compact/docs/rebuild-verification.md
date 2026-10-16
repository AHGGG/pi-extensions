# Compaction rebuild verification

## Scope

The rebuild starts from upstream `c8fae75a81f08aecdb6000767b92dcb53634e298`. The original fork tip is `d3108382feee0874c8389f0bd785dd8a46698e89`. Work is staged on `fix/codex-compact-rebuild-20261016`; main must not be replaced or force-pushed.

The OAuth/timeout and warm-ahead changes reuse the existing package-scoped implementations on the newer upstream base. The targeted correction adds a stable ordinary-work replay boundary while preserving the existing bounded continuation scheduler. It does not delete maintenance output, decrypt checkpoints, create a second scheduler, or change the recovery policy.

The handoff prompt is present in the inspected source. The explanation that a resumed model request mistakes the handoff for the task is a working hypothesis, not a reproduced hosted-model finding.

## Verification performed during preparation

Seven isolated payload checks passed using Node's test runner and TypeScript stripping. The runner substituted the unchanged marker/protocol function excerpts for the full protocol module and did not load Pi or Vitest. These checks cover intact history, newer-message order, stable prefixes, maintenance separation, tool-call pairing, legacy OK output, and fail-closed marker validation. They are not repository test results.

The repository includes `checkpoint-replay.test.ts` with those cases. Existing session replay and custom-API lifecycle expectations now assert the new boundary rather than assuming the checkpoint is immediately adjacent to newer messages. Existing real-Pi runtime, OAuth continuation, ownership, recovery, and warm-ahead suites remain required; none was declared passing from source inspection.

Full installation, builds, typechecks, lint, the Pi/Vitest suite, package-load smoke, and hosted-model smoke were not run in the preparation environment. Direct GitHub/DNS access and dependency download were unavailable. A draft pull request was created to expose repository CI, but no CI run had been returned at the time these notes were written. Do not merge until the required gates are recorded.

## Completion gates

Read root `AGENTS.md`, `docs/extension-conventions.md`, and `docs/extension-settings.md`, then inspect the actual scripts with `npm run`. Use the repository's required Node version and dependency installation policy. Run `npm run check` and `npm test` separately; ensure the compaction package suite is included, not skipped by affected-test selection. Rebuild Pi TUI Kit before consumer tests and do not run its build concurrently with root checks.

Verify actual Pi lifecycle paths for automatic threshold and overflow compaction, a tool turn, queued user or custom work, repeated compaction, manual compaction, cancellation, session replacement, and saved-checkpoint reload/resume/fork. Check both the presence of the ordinary-work boundary and exact request counts. Confirm that maintenance/recovery requests do not receive the work boundary and that new user instructions remain later in the payload. Do not weaken unrelated tests merely to get a passing gate.

Where an authenticated provider test environment is explicitly available, use a controlled task confined to a temporary directory. Confirm that after compaction the model performs the next task step rather than merely producing another handoff. Check completed, cancelled, and blocked tasks separately. Stop after one clear entitlement failure. Do not expose credentials, use an unrelated provider, or claim a mock proves hosted-model behavior.

Refresh both remotes before integration. Reconcile newer commits without resetting either history. After validation, merge the rebuild normally into the fork, verify the final merged code, run the gates again, and push without force. Do not publish packages, create release tags, or run release workflows.

## Settings and diagnosis

The compaction extension reads `<getAgentDir()>/pi-codex-compact.json`, normally `~/.pi/agent/pi-codex-compact.json`. The timeout default remains five minutes, with fifteen minutes supported. Pi's separate `httpIdleTimeoutMs` does not set this extension field. To choose fifteen minutes and logs, merge these fields into the existing extension settings rather than overwriting other preferences:

```json
{
  "requestTimeoutMs": 900000,
  "logCompaction": true
}
```

Warm-ahead remains off by default, with a configurable preparation threshold of 65%. Saved logging choices use the existing persistence mechanism. New continuation notices report request preparation or scheduling decisions, not proof of completed coding work. No user-machine settings were changed during this rebuild.
