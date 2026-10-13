# Usage statusline display plan

## Goal

Implement approved issue #1554: configurable quota statusline templates with unchanged defaults and provider semantics.

## Plan

- [x] Add regression tests and observe failures before implementation (33 tests failed).
- [x] Add a validated package-owned renderer and settings integration; preserve Fast prefixes and countdown policy.
- [x] Document manual settings, syntax, validation, and reload behavior; add a minor usage Changeset (Changesets status confirms usage minor).
- [ ] Complete repository verification: usage tests pass (37 files, 626 tests), `npm run check` passes, the 35-package heading audit passes, pack dry run includes the new source and documentation, and offline Pi loading passes; the full `npm test` gate remains blocked by unchanged tests.
- [x] Audit the diff against extension-conventions, extension-settings, and readme-conventions; settings queues, write protection, lifecycle ownership, excluded providers, and countdown policy remain unchanged.

## Risks

Fast decoration must occur before template expansion; preserve whitespace, quota selection, and provider-specific expired-reset behavior.
Live-provider requests and interactive visual behavior are outside the approved offline verification scope.

## Completion Checklist

- [ ] Acceptance tests pass; the required full-suite gate still needs unrelated failures resolved or an approved deviation.
  The full run recorded 8,447 passed, 8 skipped, and 5 failed tests.
  A serial retry with canonical temporary-directory settings passed the affected Starship, Subagents, and Git backend contract groups; `test/dependency-installation.test.ts` still rejects an incompatible optional package with `ESTRICTALLOWSCRIPTS`, and `packages/pi-sync/test/git-routes.test.ts` still exceeds 5,000 ms.
  No test timeout or unrelated source was changed.
- [x] Generated Jiti loading and offline package-directory smoke pass (focused tests and isolated RPC smoke).
- [x] Documentation and Changeset match implementation (35-package heading audit and link check).
- [x] Handoff evidence recorded: new tests failed before implementation; focused tests and checks pass; full-suite failures remain outside scope; dependency installation reported 3 high and 2 critical vulnerabilities without changing manifests or the lockfile; live-provider and interactive visual paths remain unverified.
  Semantic audit used `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md` with no implementation deviations.
