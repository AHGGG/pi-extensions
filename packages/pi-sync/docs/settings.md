# Pi Sync settings reference

[Back to README](../README.md)

- [Complete version 3 example](#complete-version-3-example)
- [Required backend shapes](#required-backend-shapes)
- [Status display](#status-display)
- [Secret scanning](#secret-scanning)
- [Included content](#included-content)
- [Unsupported old settings and recovery](#unsupported-old-settings-and-recovery)

## ⚙️ Settings

The canonical private user file is:

```text
~/.pi/agent/pi-sync.json
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable.
Missing settings load as unconfigured without creating an agent directory, file, temporary file, or lock.

An explicit setup creates the file atomically.
On POSIX, pi-sync creates and replaces it with mode `0600`.
Pi-sync processes coordinate settings access through `pi-sync.json.mutation-lock`; lock-unaware editors are outside that serialization boundary and should not save the file while a pi-sync settings operation is running.
Credentials stay in this canonical private file and are never shown in menus, reviews, status, notifications, errors, logs, or completion metadata.

A private `pi-sync.local.json` containing a valid version 3 document is copied byte-for-byte to `pi-sync.json`.
The old file remains as a recovery copy.
If both paths exist, `pi-sync.json` wins and the legacy file remains untouched.

### Editing in the manager

Open `/sync` → **Settings** and choose **Sync content**, **Sync behavior**, **Storage & setups**, or **Advanced**. **All settings (search)** provides cross-category typing-to-search over the same rows. **Included paths** and **Compare included paths** are adjacent in Sync content; the latter compares path policies, not file contents. **Storage location** edits the current setup's coordinates, while **Manage sync setups** and **Manage storage connections** retain the catalog and affected-setup reviews. Returning from catalog management refreshes the rows; switching or removing the owning setup closes its old Settings screen.

Descriptions identify the owner: this setup, all setups on this device, or shared connections. Simple choices report Saving and the durable Saved or failed/rejected result, preserve the selected row and search during refresh, and restore their previous value if saving fails. Escape closes the screen without undoing successful saves. Complex values retain their input/review flows. This navigation change does not alter schema, defaults, automatic-sync behavior, or experimental opt-ins.

The manager separates current state from transfer, inspection, and management actions. **Check remote status** and **View differences** invoke the existing read/check routes only when selected. Last applied shows a compact snapshot ID with application time explicitly unavailable; full IDs remain in History. It never uses snapshot creation time as application time. See the [TUI behavior contract](tui-contract.md) for scopes and transfer branches.

RPC reports the manual settings path and offers the existing setup/connection catalog dialogs, not the TUI preference or masked-credential editors. Print/JSON do not support `/sync`; use the private settings file directly. Main-menu summaries remain cached observations; `/sync status`, `/sync diff`, and `/sync help` remain available through the visible command hints.

### Complete version 3 example

```json
{
  "version": 3,
  "activeSyncSetup": "home",
  "onSwitch": "ask-before-pull",
  "skipSecretScan": false,
  "showStatus": true,
  "storageConnections": {
    "r2": {
      "type": "s3",
      "endpoint": "https://example.r2.cloudflarestorage.com",
      "region": "auto",
      "credentials": {
        "accessKeyId": "<access-key-id>",
        "secretAccessKey": "<secret-access-key>"
      }
    },
    "github": {
      "type": "git",
      "remote": "git@github.com:owner/private-pi-sync.git"
    },
    "nextcloud": {
      "type": "webdav",
      "url": "https://cloud.example.com/remote.php/dav/files/user",
      "credentials": {
        "username": "user",
        "password": "<app-password>"
      }
    }
  },
  "syncSetups": {
    "home": {
      "storage": {
        "connection": "r2",
        "bucket": "personal-pi",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md", "skills", "prompts", "themes"],
        "automatic": true
      }
    },
    "git-backup": {
      "storage": {
        "connection": "github",
        "branch": "pi-sync/home",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md"],
        "automatic": false
      }
    },
    "webdav-backup": {
      "storage": {
        "connection": "nextcloud",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "sessions"],
        "automatic": false
      }
    }
  }
}
```

Cloudflare R2 is persisted as `"type": "s3"`; R2 is a setup preset, not another schema type.
Temporary S3 credentials may additionally include `credentials.sessionToken`.

### Required backend shapes

- **S3/R2 connection:** `type`, `endpoint`, `region`, and `credentials.accessKeyId` / `credentials.secretAccessKey`.
- **S3/R2 setup storage:** `connection`, `bucket`, and complete relative `path`; `branch` is rejected.
- **Git connection:** `type` and a credential-free SSH or HTTPS `remote`.
- **Git setup storage:** `connection`, `branch`, and complete repository `path`; `bucket` is rejected.
- **WebDAV connection:** `type`, HTTPS `url`, and `credentials.username` / `credentials.password`.
- **WebDAV setup storage:** `connection` and complete relative `path`; `bucket` and `branch` are rejected.

Every backend accepts `.` or `./` for its root; both resolve to `./` and share the same local state and backend identity.
New setups default to `./`, independently of the setup name; Git also suggests branch `main`.
For WebDAV, root means directly under the configured collection URL, not the server root.
For R2/S3, it means the selected bucket root, with no literal `./` object-key prefix.
WebDAV and R2/S3 write `latest.json`, `history.json`, and `snapshots/` there; use separate relative folders or prefixes for independent setups sharing storage.
Existing settings, paths, and local state identities remain unchanged. Editing a setup defaults to its current path.
Manually written documents still require an explicit non-empty `storage.path`; use `./` rather than an empty string for root.
Git branches are exclusively managed by pi-sync; an existing branch containing unrelated files is rejected rather than overwritten.
When adding a setup, locally configured destinations are checked before content selection and review, including equivalent connection aliases.
An occupied destination requires an explicit different path; Git requires a different branch because directories do not isolate publications on one branch.
This check does not contact the server or discover setups configured only on other machines.

Every setup requires `sync.include` and explicit `sync.automatic`. Setup asks for automatic sync with Off first; existing values are not rewritten. When enabled, the current setup receives one background startup check in TUI/RPC, including reload/new/resume/fork. Startup no longer performs automatic transfers or opens dialogs; review changes through `/sync`. Print/JSON skip startup checks. Checks compare local hashes and remote metadata against the last sync baseline, so revision changes and missing baselines require review rather than proving a file conflict.

The setting still permits automatic shutdown pushes of selected content when `sessions` is included, in all modes; this is not limited to uploading session files. Reload skips shutdown push. Settings changes apply to subsequent operations; changing this setting does not schedule another startup check until the next session start. Foreground `/sync` cancels a pending check before opening Settings. The check deadline is 30 seconds plus bounded cleanup, with manual retry through `/sync status`; there is no polling. See [Background startup checks](../README.md#background-startup-checks) for recovery and Git cache exceptions.

Recommended includes the nine non-session Pi roots listed below; Minimal includes `settings.json` and `AGENTS.md`. The save review lists every selected path and the full backend destination. R2/S3 requires an explicitly entered existing bucket and never creates one. Saving setup or connection settings does not contact remote storage.

Invalid fields retry without discarding earlier answers. Retryable local I/O failures retain the exact draft for another Save. Stale reviews and invalid settings files require reopening or repairing current settings rather than overwriting them. A separately saved connection remains if the surrounding Add setup flow is cancelled.

**Edit storage location…** changes only bucket, branch, or path. Content and automatic sync belong to the current setup's **Settings** screen; editing another setup's coordinates does not make it current.
`activeSyncSetup` must reference an own-property setup when any setups exist and must be absent when the setup catalog is empty.
A referenced connection cannot be removed.
The current setup must be switched before removal when other setups exist. Removing the last setup is allowed; local removal never deletes remote history.
Two setups cannot resolve to the same normalized backend location.

The global **On setup switch** setting persists as `onSwitch` and applies whenever any setup is made current. It accepts:

- `ask-before-pull` — switch, then ask in TUI whether to start a reviewed pull;
- `pull-after-switch` — require observable UI and start the normal reviewed pull;
- `switch-only` — switch without reading or applying remote content.

### Status display

The global `showStatus` setting accepts a boolean and defaults to `true` when omitted from an existing version 3 document.
Set it through **/sync → Settings → Advanced → Show sync status**; changes are saved and applied immediately for every setup.
When `false`, pi-sync clears and suppresses status text for background checks, manual and automatic transfers, and review attention.
TUI review widgets and TUI/RPC notifications remain available, and lifecycle cleanup still clears any stale status owned by pi-sync.

### Debug startup timings

The top-level user setting `debug` accepts only `true` or `false` and defaults to `false`.
Edit `<getAgentDir()>/pi-sync.json` (normally `~/.pi/agent/pi-sync.json`) or use **/sync → Settings → Advanced → Debug startup timings**.
UI changes save immediately through the existing ordered, atomic settings writer; both manual and UI changes take effect on the next session start, including `/reload`, new, resume, and fork.
There is no project or environment override.

With `debug: true`, TUI/RPC notifications report local initialization after recovery and settings resolution, then background work when it ends.
Stages include transaction recovery, settings reads, inspection import, backend initialization, local snapshot, sync state read, remote head, operations import, and automatic transfer when those stages run.
The inspection-and-guards duration includes its nested stages and lock access; durations overlap and must not be summed.
Totals use a monotonic clock and include waits within each flow, not Pi's complete startup, the initial extension import/factory, or time queued for idle startup transfer.
Recovery failures before valid settings can be read cannot enable a timing report.

Interrupted stages are marked `interrupted`; cancelled or failed background work is marked `stopped`.
Session replacement and shutdown suppress late reports from the old session.
Labels and durations contain no credentials, paths, file contents, remote addresses, or error text.
No log file or model message is created. Print/JSON produce no timing notifications.
The setting does not enable automatic sync or transfer, change safety checks, or measure manual/shutdown operations.
Set `debug` to `false` or remove it, then start a new session to disable reports.

### Secret scanning

The global `skipSecretScan` setting accepts a boolean and defaults to `false`, including when omitted from an existing version 3 document.
Set it through **/sync → Settings → Advanced → Skip secret scan**; changes are saved immediately and apply to subsequent pushes for every sync setup, including automatic pushes.
When `true`, pushes skip the local secret scan; other safety checks and confirmations remain unchanged.
Enable it only after reviewing the destination and selected content because files containing secrets can be uploaded.
`/sync doctor` still scans and reports possible secrets regardless of this setting.

### Diagnostics

**/sync → Diagnostics** and `/sync doctor` use the same existing route. S3/R2 reads the selected setup's latest pointer with a ten-second deadline and bounded error details; it never writes, deletes, lists buckets, or changes settings. HTTP success does not validate snapshot contents or write access. `NoSuchKey` indicates no snapshot at the path; `NoSuchBucket` indicates a missing bucket; other 404 responses cannot distinguish the two. Authentication and transport failures give credentials/permissions or address/network guidance. Git reads remote snapshots and checks its local cache; write access is not tested. WebDAV retains its isolated conditional-write/cleanup probe and repair of a missing active-snapshot history entry.

### Included content

`sync.include` is ordered and duplicate-free.
Supported Pi roots are:

```text
settings.json, keybindings.json, models.json, AGENTS.md, APPEND_SYSTEM.md,
skills, prompts, themes, extensions, sessions
```

Safe agent-relative custom files or directories may also be included.
Absolute paths, `..`, backslashes, controls, denied secret/settings paths, duplicate case variants, and ambiguous nested paths under reserved roots are rejected.

An empty array is valid.
It means no useful transfer is selected: **Sync now** reports the condition and does not claim that the setup is up to date.
Unselected content remains unmanaged locally and is preserved when republishing existing remote snapshots.

The Included Content editor is a standard bounded multi-select backed by one in-memory draft.
Toggles never write settings.
**Add custom path…** accepts a safe agent-relative file or directory even when it does not exist locally yet, allowing a new environment to select content that exists only in the remote snapshot.
Leaving the editor opens an exact Include/Exclude review with **Save changes**, **Discard changes**, and **Continue editing**; only reviewed Save publishes, while Continue preserves the draft and Discard/cancellation preserves the settings bytes.
RPC remains a read-only summary with the manual `sync.include` path.

Every new snapshot stores the normalized included-content selection separately from the files that happened to exist.
This preserves selected-but-missing paths without syncing `pi-sync.json`, storage credentials, automatic-sync preferences, or setup names.
**Settings → Sync content → Compare included paths** opens the same review-first flow as a manager operation when local and remote lists differ.
Adoption revalidates the remote head, immutable snapshot, reviewed storage coordinates, and local include list before one atomic settings update.
The saved state changes only `sync.include`, preserves unknown settings fields, and never pulls files or writes sync state.
Its explicit Continue action starts a fresh **Sync now** route, while **Done** leaves the reviewed settings change saved without implying a file operation.
Keeping this device's list opens the reviewed force-push path and explicitly replaces the remote policy while preserving eligible unmanaged remote files.

Startup checks report an explicit remote-policy difference without applying it. Pull, including forced pull, pauses on that difference rather than silently expanding local scope.
Status reports matches and exact local-only/remote-only paths.
Old snapshots remain readable.
Because they have no authoritative selection, pi-sync offers only a clearly labeled read-only partial discovery from safe remote file roots; selected-but-missing and preserved-unmanaged intent cannot be reconstructed.
Use **Add custom path…** for any needed path.

Adding `sessions` requires a privacy acknowledgement in interactive flows.
Session JSONL can contain prompts, tool output, file paths, images, and secrets.
Pull protects the currently open session file; restart Pi or resume a pulled session to use newly synchronized conversations.

### Automatic startup transfer

`sync.automaticTransfer` is optional and accepts only a boolean; absent means `false`. Set it through **/sync → Settings → Sync behavior → Startup transfer**. It is separate from `sync.automatic`: the legacy setting retains observation and selected-content shutdown behavior.

When explicitly enabled, one startup transfer waits for an idle boundary in TUI/RPC. It requires an accepted baseline and a matching authoritative remote include list, retains all-or-nothing conflict review, checks secrets unless the global scan override is enabled, and never reloads resources. Git, verified conditional WebDAV, and R2/S3 with verified conditional writes support this policy. A saved On preference is not proof of eligibility: baseline, remote policy, idle ownership, conflicts, secrets, and publication capability are checked again at execution. Print/JSON skip automatic startup transfer. A settings save takes effect for subsequent authorization checks; enabling schedules the next session start, while foreground Settings cancels and drains any current work before saving. There is no polling.

Turning it off does not revert transfers or remove backups/journals. For interrupted operations, follow [merge recovery](merge-implementation-audit.md). Unknown fields remain preserved and malformed/invalid files block saves, just as for the existing policy.

### Settings field merge and machine-local fields

`sync.mergeSettings` is experimental, defaults to `false`, and is available in the owning Settings screen. With a verified accepted ancestor, global `settings.json` root fields merge conservatively: absent differs from null, arrays/nested objects are atomic, and provider/model and other coupled fields form one unit. Unknown fields are preserved. Pi accepts plain UTF-8 JSON with an optional BOM, not JSONC; duplicate/prototype-sensitive keys, invalid encodings, migration-dependent syntax, and over-bound inputs require directional review. Field merging and nonempty portable projections also refuse unsafe integers, nonfinite numbers, and numeric literals that change mathematical value when serialized through JavaScript; they never round those values into an accepted edit. `keybindings.json` remains file-level because alias and matcher semantics need a separate strategy.

`sync.localFields` is an explicit sorted string array of whole global `settings.json` root field names, not a heuristic or project override. Example: `"localFields": ["shellPath"]`. Coupled fields must be excluded together. Nonempty rules require `settings.json` in `sync.include`; absent or explicitly empty rules remain valid for other selections. Saving nonempty rules in Settings confirms an upgrade to settings version 4; manual edits must declare version 4 too. Absent rules keep a setup nonportable, including unrelated setups in a version-4 document. An explicit array opts that setup into snapshot version 2; `[]` after rule removal retains this reviewed opt-in and differs from absence. Older clients must refuse portable data rather than replace local-only values.

Portable projections normalize remote JSON deterministically while local overlay preserves unaffected local member/value bytes and excluded values or absence. Accepted hashes and ancestors use that same projection; compatible noncanonical remote JSON does not create a false local change. Recovery verifies both recorded projections in canonical form while retaining the original physical bytes and exact checksums. Pull and rollback bind settings writes/deletions to the reviewed raw-file hash or absence under Pi's mutation queue, including transaction backup preparation; a newer excluded value causes refusal rather than overwrite. A portable whole-file deletion is allowed when no excluded root field is present; a present excluded value (including null) or unsupported local document blocks deletion for review. No override file is loaded and no resources are automatically activated. Portable remote snapshots must actually omit every declared excluded root field; inconsistent or unsupported settings documents fail closed before acceptance, without displaying payload values. Policy-only changes remain visible in status/startup inspection even when bytes are unchanged. Excluded data can remain in old remote versions and local backups; removing a rule can make it publishable or replaceable again.

Changing rules blocks ordinary/background merge until a reviewed directional migration. To change the authoritative remote rules, use `push --force` from the authoritative machine first. `pull --force` may adopt a changed accepted policy only when the configured rules already match the remote; it never rewrites remote policy and refuses a mismatch before review or mutation. Rollback requires its historical snapshot to use the configured rules; it refuses mismatched history instead of deleting newly portable local values. Use authoritative `push --force` to migrate from current local bytes, then choose matching history. A rollback that overwrites a different current-head policy requires the same additional observable TUI/RPC migration confirmation even with `--yes`. Cancellation, changed bytes/settings/head, and invalid files prevent acceptance. Inspect `/sync diff` first. Configure the same portable rule set on every receiving machine; other local values may differ. Rule names, not credential values, appear in review.

Accepted ancestors are private, hash/identity-bound, bounded records below the denied state directory. Capture occurs after accepted directions or journaled merge; cache staging precedes state acceptance, and previous ancestors survive failures until completed journal retirement permits pruning. Missing/corrupt cache never invents a baseline from current data or assumes remote retention. Preserve unknown/corrupted or nonprivate records and pending journals for manual review; pruning applies the same storage/schema/byte validation as reading. Journal identity distinguishes absent and explicit empty policies. Integrity validation uses the journal's recorded rules, so intact old-policy journals remain readable after a settings change; ordinary replay still rejects mismatched current rules, while reviewed force push/pull may archive that evidence. Older absence-conflating journal identities fail closed and remain available for an explicitly reviewed force direction; do not downgrade portable setups. To return to an older client, first use this version to review rule removal and publish a complete nonportable copy to a separate version-3 setup, with Pi closed during the change. Never reinterpret portable snapshots with an old binary.

### Content merge and partial progress

`sync.mergeContent` and `sync.partialSync` are independent experimental booleans, both default `false`. The owning **Advanced → Content merge / partial progress** setting offers Off, Merge only, Merge + partial, and Partial only and confirms an explicit settings-version-5 upgrade. Manual configuration must also declare version 5. Settings version 5 retains the portable-policy behavior of version 4; moving from a legacy setup can require the existing separately confirmed directional policy migration. Disabling options retains the schema and recovery evidence.

Content merge initially supports global `AGENTS.md` and `.md`/`.txt` prompt/skill resources. Strict UTF-8, 1 MiB/file and a four-million-cell complexity bound apply. BOM, CRLF/LF and final-newline bytes are not silently normalized; unsupported/binary/oversized input remains a file conflict. Output never includes conflict markers. JSON/keybindings/executable resources are not treated as generic text; settings has its separate strategy. A clean line merge is not proof of semantic correctness.

Same-session content merge accepts only complete validated Pi v3 histories with exact immutable byte prefixes and comparable local/remote extensions. It rejects malformed/partial records, migrations, identity/header changes, duplicate ids, broken parent references, compaction rewrites and divergent appends. The current loaded session and its aliases remain protected; active sessions in other processes are not discoverable through this mechanism. Nothing resumes a pulled conversation.

Partial progress stores per-path accepted hashes separately from the observed remote head. Withheld local versions remain local; the complete published snapshot retains the observed remote versions, never omission/deletion. Their previous verified ancestors survive staging and restart. Resource and collision groups defer together when independence cannot be proved; partially conflicted JSON and sessions remain atomic. Publication/apply/baseline is journaled, and a changed head replans only proven pre-commit attempts; unknown outcomes preserve evidence. Older codecs refuse version-3 partial snapshots and older settings readers refuse version 5, so do not collapse state for downgrade.

`/sync conflicts` (also the conditional main **Review unresolved conflicts** action) shows private versions only when requested, in TUI or paginated RPC. It rejects confirmation/force bypass flags, reviews an entire group, then separately asks for local or remote authority. It revalidates the reviewed artifact fingerprint, group versions, baseline, configuration, ownership and current observed head before apply; stale/cancelled review performs no transfer. The manager always reports unresolved groups and the observed head separately from Last applied. Repeated unchanged conflicts retain one stable opaque identity rather than creating more evidence or modal reviews.

Artifacts are private immutable records below denied state storage with a 192 MiB/record cap; accepted ancestor records use the same bound, and actual content strategies have smaller limits. Unresolved and unknown/corrupted evidence is never automatically removed. Completed cleanup retains the newest 32 **proven-common, unreferenced** artifacts; pinned files remain even if other groups in the same record completed. Total evidence can exceed those bounds across unresolved/unknown records: inspect it manually with Pi closed rather than deleting pending evidence. This is not remote-history erasure.

Do not run older binaries against version-5 setups or pending journals. To downgrade, drain work, resolve/review every withheld group with this version, retain evidence, and create a separately reviewed complete copy in a distinct version-3 setup. Disabling partial sync with unresolved state blocks ordinary sync until it is re-enabled or an explicit force direction accepts a complete selected version. No watcher/debounce/polling optimization is enabled: content revalidation is preferred over treating revision equality as authority. See the [implementation and recovery audit](content-merge-audit.md).

### Unsupported old settings and recovery

Version 1, version 2, and non-empty unversioned documents are unsupported after the version 3 schema reset.
Pi Sync does **not** migrate, partially interpret, downgrade, or overwrite them.
Automatic sync pauses and reports an actionable version 3 error without displaying secrets.

Recovery:

1. retain the old file byte-for-byte;
2. move it aside manually;
3. create a new version 3 document or run the setup manager;
4. run `/sync doctor`, inspect the exact storage path, and review the first pull or push;
5. restore the retained file and a compatible older package only if rolling back.

Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched.
Failed UI saves keep the previous file and displayed/effective state.
