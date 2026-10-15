# LSP session-relative workspace roots

## Goal

Fix issue #1577 so `lsp_diagnostics` and `lsp_fix` default to the active session cwd and resolve relative roots against that cwd.

## Context

The published package reproduced the failure under Pi 1.2.0 through the SDK: after the reported session-switch command, both tools selected the launch directory. Duplicate filenames silently selected the launch copy. An absolute root selected the session copy. The repository helper independently reproduced process-relative defaults.

## Scope and rules

- Root resolution, routes, and runners must use an explicit workspace base and retain path validation; verify with deterministic helper, tool, route, and runner tests.
- Lifecycle ownership, cancellation, and stale-context guards must remain unchanged under `docs/extension-conventions.md`; verify with lifecycle tests and diff review.
- Configuration trust and settings precedence must remain unchanged; verify existing settings tests and review that tool roots do not select configuration.
- README edits must follow `docs/readme-conventions.md`; verify headings, interfaces, and retained warnings.
- Published behavior requires a patch Changeset; verify release intent and run both repository gates.

## Plan

- [x] Add regression tests for omitted, blank, relative, and absolute roots, duplicate filenames, session replacement, server cwd, and fix write isolation; show failures on the baseline.
- [x] Pass session cwd explicitly through root resolution, routes, and runners without changing absolute-root behavior or path validation.
- [x] Clarify session-relative roots in the package README and add a patch Changeset.
- [x] Run focused tests, `npm run check`, and `npm test`; build and smoke the generated package through Pi's loader (127 focused tests; 8,581 full-suite tests passed, eight skipped; CLI package smoke exited zero).
- [ ] Audit the final diff and acceptance criteria, commit intended paths, and open a pull request for #1577.

## Risks

Relative roots intentionally change meaning after cross-directory session switches. Absolute roots, project trust, cancellation, and launch-directory files must remain unchanged.

## Rollback / Recovery

Revert the focused fix commit if regressions occur. Do not publish or change issue metadata as part of this work.

## Completion Checklist

- [x] Regression tests fail on the baseline and pass with the fix (six tool regressions failed; two absolute-root controls passed; focused suite now passes 127 tests).
- [x] Required checks and package smoke pass; interactive model-mediated steps were replaced with direct SDK execution and non-interactive CLI loading.
- [x] No unrelated changes or lifecycle/settings policy changes remain; root validation, absolute roots, tool definitions, cancellation, trust, and lifecycle ownership reviewed unchanged.
- [ ] Pull request contains verification evidence and remaining limitations.
