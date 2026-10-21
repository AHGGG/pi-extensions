# Coordinated Kit and consumer releases

A Kit API and the consumers that adopt it can ship in one Version PR and one release workflow run. Packages keep independent versions. npm publication is not atomic: Kit can remain published if a later consumer fails.

## Versioning

Add a Changeset for Kit and each consumer that adopts the API. The consumer must have a dependency floor that supplies every API it uses. Changesets updates ordinary SemVer ranges and automatically patches consumers whose ranges exclude a new internal version. A compatible Kit patch does not automatically release unselected consumers. Keep `fixed` and `linked` empty.

Run the existing `version-packages` command only in the normal versioning workflow or a disposable fixture. It changes versions, changelogs, and the lockfile. The lockfile command resolves an unpublished Kit through its local workspace, not the registry. The separate Docker smoke manifest and lockfile are not part of root workspace version propagation.

## Publication

The existing pack job builds immutable tarballs and records their SHA256 hashes in the publish-plan artifact. The publish job downloads that artifact and passes its path to `scripts/publish-coordinated-packages.mjs` through the pinned Changesets publish Action's custom-script input. The Action still owns GitHub tags, releases, and publication outputs.

The helper validates plan entries, artifact paths and hashes, and packed manifest identities and runtime dependencies against the checkout before publishing. It uses the real Changesets CLI in artifact mode, isolates Kit first, then retains the remaining dependency chunks. Kit must not itself depend on another workspace. This restriction prevents Kit-first ordering from violating a prerequisite.

Each public entry is checked against the registry before publication. An existing version is reused only after its tarball matches the packed SHA256. For non-Kit release artifacts, verification downloads the exact registry-reported HTTP(S) tarball URL and requires the planned identity and hash; this avoids age-based version selection for immutable release bytes without adding an age exception for consumer packages or their dependencies. Embedded URL credentials are rejected. The helper then invokes native tag-only handling to recover a missing tag without republishing the version. After a successful native publish call, it downloads and verifies the published bytes and repeats tag-only handling to cover an already-published race that native Changesets otherwise skips without a report event.

Before publishing a consumer, the helper resolves its ordinary runtime Kit ranges to the local Kit version when compatible, or to an accepted minimum version for an older range. Unsupported or conflicting ranges fail closed. Kit downloads use a new empty npm cache for each attempt, so a cached tarball cannot establish registry readiness. The check makes at most six download attempts with two-second retry intervals and ten-second deadlines for each metadata or download subprocess. Authentication errors stop immediately; subprocess failures, timeouts, and cancellation also stop rather than proceeding.

When Kit is in the artifact, downloaded bytes must match its recorded hash. In a consumer-only batch or a fresh workflow retry whose plan omits already-published Kit, the check establishes exact-version availability only; it has no Kit reference tarball to compare. Such a batch does not republish or retag Kit.

The exact Kit release-age exception in `.npmrc` permits fresh registry resolution without weakening the three-day rule for third-party dependencies or strict install-script review. That exception does not change external users' policies.

## Failure and recovery

A publication, registry-state, integrity, or readiness failure stops all later chunks, including unrelated packages. Native Changesets can finish concurrent peers in a reached chunk before reporting failure. Successful publications already reported by the CLI remain in the shared `CHANGESETS_OUTPUT` file; the Action processes those events before it reports the non-zero script result.

Retry through the approved release workflow after inspecting the registry state and failed step. Replaying the same packed artifact compares already-published bytes before tag recovery and does not publish those versions again. A new workflow plan normally omits versions already visible in registry metadata. Never overwrite or reuse a published version for changed contents; prepare a corrective version instead.

Native Action recovery has limits. Existing local or remote tags do not emit new publication events, so replay does not repair a missing GitHub release for an existing tag. GitHub tag-push failures can produce warnings, and GitHub release-creation errors can prevent Action outputs and the summary from being set even when npm publication succeeded. Inspect registry versions, tags, GitHub releases, and logs before recovery; an empty summary is not proof that nothing was published. Repair external tags or releases only with explicit approval.

The helper releases temporary artifacts and caches on success or failure, cancels retry delays on shutdown, and terminates owned subprocess groups on cancellation or timeout. No publish, tag, or workflow-dispatch command is part of local validation.

## Verification and implementation evidence

The workflow pins the Actions revisions; `package.json` and the lockfile define the Changesets CLI version. The implementation audit inspected the pinned Action's `src/publish/index.ts`, `src/run.ts`, and `publish/action.yml`, and the installed CLI's `publish.mjs`, `getPublishPlan.mjs`, `gitTags.mjs`, `usingCtx.mjs`, and dependency-graph implementation.

The audited branches are fresh registry planning versus artifact replay; ordinary dependency edges versus workspace-only filtering; non-interactive chunk success, ordinary failure, authentication failure, and already-published races; native tag creation versus existing tags; and the Action's default command versus custom script, valid report processing after non-zero exit, and release/output errors. Native artifact publication does not verify recorded hashes or wait for registry availability, which is why the helper owns those checks.

Focused offline tests use the real Changesets version, publish-plan, and artifact publish entrypoints. Publication fixtures replace npm and git with fail-closed executables, publish only to fixture state, and record native report events without creating Git refs. They cover ordering, partial failures, delayed and unavailable artifacts, mismatched bytes, retry and stale-plan races, malformed artifacts, cancellation, and workflow wiring. Mock-registry install tests cover the exact Kit age exception and unchanged third-party/script protections.

Run the focused tests, then both repository gates:

```bash
npm exec -- vitest run test/changesets-release.test.ts test/changesets-versioning.test.ts test/coordinated-publish.test.ts test/dependency-installation.test.ts test/install-policy-wiring.test.ts
npm run check
npm test
```

Production npm authentication, GitHub OIDC publication, registry propagation, and GitHub tag/release creation remain unverified until a separately approved live release. Do not dispatch a release workflow to validate a tooling pull request.
