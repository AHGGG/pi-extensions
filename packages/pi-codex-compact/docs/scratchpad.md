# Session scratchpad (v1)

An optional, agent-managed notes file. No automatic memory extraction, global
knowledge base, or extra model request. Ordinary task context does not automatically
load notes; Context Management maintenance can include a bounded snapshot as described below.

## Enable and disable

- `/scratchpad on`, `/scratchpad off`: set the saved preference.
- `/scratchpad` or `/scratchpad toggle`: toggle it.
- `/scratchpad status`: report the setting, tool availability, and resolved notes-file path.
- `/codex-compact` → Settings → Scratchpad: the same saved setting.

`scratchpadEnabled` defaults to `false` in `pi-codex-compact.json`. The preference
is global to this extension's settings, not a per-session override. Notes are
session-specific. Off retains files and makes the owned tool hidden, including
from codemode. Explicit Pi tool allowlists/exclusions still take precedence.
A tool-name conflict with another extension is reported; we never replace that
tool. Turn off/remove the conflicting extension before using this one.

## View your notes

Use `/scratchpad show` in TUI mode to open a read-only, scrollable snapshot of the
current session's notes: full text, stable IDs, and UTC creation/update timestamps.
It works while Scratchpad is Off and does not enable the tool, call the model,
change files, or add notes to conversation history. The bare `/scratchpad` command
still toggles the tool; `/scratchpad status` still shows the notes-file path.

Use Pi's configured up/down and page keys to scroll, Home/End to jump, and Escape
(or your configured cancel key) to close. Ctrl+C also closes. Notes are plain text;
terminal controls are stripped for display. Reopen the viewer to see later edits.
The complete validated file is shown, not just the first tool-result page; the
existing 1 MiB storage limit applies. Missing/empty notes show an empty-state message;
unreadable or invalid files show an error without overwriting them. Session replacement,
reload, shutdown, and UI disposal close the old viewer.

RPC shows a local notes-file hint rather than opening an interactive viewer. Print
and JSON modes reject this TUI-only action with an error; no notes enter model history.

## Tool

One tool named `scratchpad`. Session identity and storage paths are selected by
the extension, not accepted as tool input.

| Action | Input | Result |
| --- | --- | --- |
| `read` | Optional `ids`, or optional `cursor`/`limit`; optional `view` | Items, total count, returned count, next cursor |
| `add` | `texts: string[]` | Assigned IDs and count |
| `update` | `items: { id: number, text: string }[]` | Updated IDs and count |
| `delete` | `ids: number[]` | Deleted IDs and count |

Single and batch operations use the same arrays (1–100 entries). IDs are positive
integers, remain stable, and are not reused by tool operations. Unknown or duplicate
target IDs fail the whole batch. Updates replace text; unchanged text retains its
previous `updatedAt` timestamp.

Read views:

- `full` (default): complete text, ID, `createdAt`, and `updatedAt`.
- `summary`: ID, explicitly named `preview` (first 200 Unicode characters), timestamps.
- `ids`: objects containing only `id`.

Omitting `ids` lists by ascending ID. `limit` defaults to 20 and is at most 100.
Do not combine selected `ids` with `cursor` or `limit`. A `nextCursor` of `null`
means the listing is complete. Continue with the same view and returned cursor.
If the file changes between pages, `STALE_CURSOR` requires restarting the listing.
Selected-ID reads return all requested items or an explicit error, never a
silently incomplete selection.

Examples:

```json
{"action":"add","texts":["Use pnpm for this repository.","Tests passed; device verification is pending."]}
{"action":"read","view":"summary","limit":20}
{"action":"read","ids":[1,2],"view":"full"}
{"action":"update","items":[{"id":2,"text":"Tests and device verification passed."}]}
{"action":"delete","ids":[2]}
```

Results are JSON in model-visible text and `structuredContent` for codemode.
Mutations return short confirmations and affected IDs, not the whole file. Errors
are marked as tool errors with `success: false`, a safe `code`, and corrective
`message`. An empty scratchpad is a successful read.

## Storage and lifecycle

Under `getAgentDir()` (normally `~/.pi/agent`):

```text
scratchpads/<session-id>.json
```

```json
{
  "schemaVersion": 1,
  "sessionId": "example-session",
  "nextId": 2,
  "items": [
    {
      "id": 1,
      "text": "Use pnpm for this repository.",
      "createdAt": "2026-10-25T09:00:00.000Z",
      "updatedAt": "2026-10-25T09:00:00.000Z"
    }
  ]
}
```

The extension generates UTC ISO timestamps on tool writes. `createdAt` stays
fixed, `updatedAt` changes only when text changes. IDs must be unique and less
than `nextId`. Deleting all items retains `nextId`. Resume keeps the same file;
new/forked sessions start empty files when first written. A `/tree` navigation
keeps current session-wide notes, not a historical version. These local files do
not automatically travel with exported/shared session transcripts.

Direct editing is supported **between tool operations**, while Pi is idle.
Preserve valid JSON, session ID, unique IDs, timestamps, and `nextId`; update
`updatedAt` yourself when editing text externally. The tool cannot guarantee
non-reused IDs if metadata is manually reset or the entire file is removed.
Invalid files are reported and preserved, never silently repaired or replaced.
Symbolic-link scratchpad directories/files are rejected.

## Bounds and consistency

- Item text: 8 KiB UTF-8; whole serialized file: 1 MiB.
- Read response: 64 KiB; a complete maximum-size item fits in one page.
- Full text is never truncated. Oversized writes fail; use shorter notes and
  references to larger project artifacts instead.
- Validate the entire batch before saving. Serialize operations inside one
  process; write a temporary file and atomically replace the destination.
- Check cancellation and session ownership before saving. A switched session
  must not receive an old operation's writes.
- Concurrent external writers or two Pi processes editing the same session are
  unsupported in v1. Atomic replacement does not solve multi-writer lost updates.
- `FILE_CHANGED` detects observed external edits during a call; read again before
  retrying. A stale result or uncertain save outcome also requires a read first.

Common errors include `INVALID_INPUT`, `ITEM_NOT_FOUND`, `INVALID_FILE`,
`LIMIT_EXCEEDED`, `STALE_CURSOR`, `FILE_CHANGED`, `READ_FAILED`, `WRITE_FAILED`,
`DISABLED`, `SESSION_CHANGED`, and `CANCELLED`. No credentials, raw filesystem
errors, or note contents are added to diagnostic logs.

## Agent guidance

The tool's stable guideline asks the agent to record decisions, constraints,
verified progress, blockers, and references; read before relying on remembered
contents; update stale items; and avoid secrets/full logs. Notes are task data,
not permission to override user instructions.

## Compaction snapshot

Only when both `scratchpadEnabled` and `appendMaintenanceMessage` are On, a
Context Management compaction request reads the complete validated notes once.
It inserts a JSON data block immediately before the existing maintenance text in
the final maintenance-only user message. A separate instruction asks for important
context missing from those notes, later changes, contradictions, essential constraints,
and the immediate next action, without duplicating unchanged saved details. Custom
maintenance text is preserved verbatim. Tools remain disabled for maintenance.

The complete serialized snapshot is limited to 16 KiB. Empty notes add nothing;
unreadable or oversized notes fall back to normal maintenance without a partial
snapshot or deduplication instruction. A fixed warning explains omission when
fallback notifications are enabled. Disabling either setting leaves the existing
maintenance behavior unchanged. Other protocols and recovery-summary prompts are
not modified.

No notes are automatically loaded after compaction, written into session entries,
or copied into a separate snapshot store. Background requests keep the captured
version for that request only; later note edits do not restart the job and are never
overwritten. Read the live scratchpad during continuation when necessary. The
server may retain input information in its opaque checkpoint; the instruction does
not guarantee the contents or size of that checkpoint.

Requests containing a snapshot suppress arbitrary provider error prose in extension
notifications, including partial echoed notes. Fixed failure categories and safe
transport/timing diagnostics remain available; note contents are not logged.
