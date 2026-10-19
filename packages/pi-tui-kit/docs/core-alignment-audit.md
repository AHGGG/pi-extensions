# Selector and host-input audit

Kit retains its cross-mode adapters. Native transcript search does not replace document-local search, exact document formatting, RPC pages, or asynchronous settlement. This audit covers plan findings F8 and F10 and their F2 input-ownership dependency.

## Corrections

| Proven gap | Correction | Regression evidence |
| --- | --- | --- |
| A compact searchable selector could retain only its query and drop the selected row or empty-result explanation. | Retain the selected row first. With no results, retain the empty-result explanation before the query. | `selector-presentation.test.ts`: choice and model-style matrices, empty filtered selectors. |
| Native `SelectList` omits descriptions when an inline column does not fit. Action and choice wrappers did not provide a fallback. | Wrap the selected description below the list when it is not fully displayed inline. Keep disabled reasons separate and inert. | `selector-presentation.test.ts`: action and choice descriptions at widths 20, 40, 41, 79, 80, and 120. |
| Model-style descriptions were truncated to one line. | Wrap the selected description and retain its rows after the selected row and query. | `selector-presentation.test.ts`: wrapped descriptions. |
| Empty-result text did not explain recovery. | Add “edit search” to filtered selector, choice, settings, and browse empty states. | Presentation tests and existing screen/browse tests. |
| Model/thinking selector rules used `borderMuted`, unlike the required editor-area frame. | Use the callback `border` role. | `selector-presentation.test.ts`: callback-theme invalidation with dark, light, and terminal-default palettes. |
| Some declarative screens rendered one cell at zero or invalid width. | Reject those dimensions at the shared screen boundary. | Choice width/height matrix and existing review dimension tests. |
| Remapped host keys could be advertised for component actions that never received them. Browse and live-choice paging hints also advertised default transcript-owned paging keys. | Filter component hints against public native host bindings. Keep host dispatch, editor bindings, and callback ownership unchanged. Apply the same filter to selector, menu, review, live-choice, secret-input, questionnaire, and task-loader hints. | `selector-host-boundary.test.ts`: every native host-action branch, matcher aliases, modifier order, legacy collision, usable fallback, regular/fullscreen adapters, and host-owned Space. |
| The native test fixture replaced its initial readiness promise when a lazy factory first opened a dialog. | Keep the first readiness promise until the first mount. | Native questionnaire tests now reach the actual Editor and finish without a timeout. |

The frame matrices cover widths 0, 1, 20, 40, 79, 80, and 120 and terminal heights 4, 5, 6, 8, 10, and 24 or 30. Normal-height frames keep both horizontal rules. At one content row, the selected item or empty-result explanation takes priority. Extra descriptions and hints cannot all remain visible at that size. Width clipping remains cell-bounded; it does not change raw identities or selection.

## Retained behavior

The audit found no reason to replace these contracts:

| Contract | Existing evidence, included in the focused package run |
| --- | --- |
| Cursor, current value, and saved default are separate states. Model/thinking rows use `→`, `✓`, and `· default`. A choice uses a cursor plus textual `✓ current`; `initialItemId` is not the current value. | `pi-selectors.test.ts`, `screen-components.test.ts`, and the new presentation matrices. |
| Model filtering selects the best match; clearing its query retains its cursor position. Thinking filtering preserves the selected value while it remains present, otherwise it selects the first result. | `pi-selectors.test.ts`; authoritative `createPiSelector()` filter branches. |
| Searchable choices and browse lists restore the prior raw ID after temporary filtering removes it, unless explicit navigation changes the selection. Browse Back from detail preserves query and selection. Settings filtering intentionally resets to the first result. | `searchable-choice.test.ts`, `browse-screen.test.ts`, `search-restoration.test.ts`, and `screen-components.test.ts`. |
| Disabled action, choice, setting, and multi-select rows remain explanatory and cannot activate. Settings use their description for an explanation; no new disabled-reason API was added. | `screen-components.test.ts`, including disabled reasons, long values, mouse activation, and inert actions. |
| Browse status is textual, selected descriptions remain available in detail, and detail views are read-only. Exact documents are not fuzzy-search metadata. | `browse-screen.test.ts`; unchanged browse layout and document source rules. |
| Standalone Space activates local document search or changes settings/multi-select state. Spaces inside pasted chunks remain text. | `document-search.test.ts`, `screen-components.test.ts`, and native document-search tests. |
| Back differs from Close. Search-close closes local search before later Back/Close; Ctrl+C closes the root interaction under ordinary host bindings. | `pi-selectors.test.ts`, `renderer-interaction.test.ts`, `selector-host-boundary.test.ts`, and lifecycle tests. |
| Input cursor editing and native Editor Backspace, newline, paste expansion, and remapped submission remain native. Custom editors retain their own editing semantics. | Native regular/fullscreen Editor and Input tests; `questionnaire-editor.test.ts`. |
| Settings saves serialize, reject safely, restore committed values, and drain before navigation or hard-close settlement. | `screen-components.test.ts`; native regular/fullscreen pending-settings rollback tests. |
| Owner abort, replacement, disposal, late factories, and pending callbacks settle and drain without retaining obsolete ownership. | `custom-interaction-lifecycle.test.ts`, `custom-interaction.test.ts`, `task.test.ts`, and questionnaire lifecycle tests. |
| RPC retains bounded source pages, raw identity, cancellation, and unsupported-mode results without opening terminal components. | `testing-rpc.test.ts`, `document-review.test.ts`, `browse-screen.test.ts`, `runtime.test.ts`, and selector unsupported-mode tests. |
| Exact text/code/diff wrapping and terminal sanitization remain document-owned. | `terminal-document.test.ts`, `terminal-text.test.ts`, `review-screen.test.ts`, and `document-search.test.ts`. |

## Native host boundary

The native tests use `test/fixtures/renderer-host.ts`, real `TuiAltScreen` and `TuiMainScreen`, a primary transcript `ScrollView`, and a replacement editor dock. Scripted bytes enter through the terminal's registered input callback, not directly through a component handler. Only the extension custom-dialog adapter and terminal device are simulated.

The audit inspected the installed native `handleViewportInput()` and `handleTerminalInput()` implementations. The decision classes are:

1. Focus reports and mouse sequences are handled by the renderer. Existing renderer tests cover wheel input, component mouse routing, drag capture, links, and regular-mode mouse behavior.
2. Native transcript search always has an earlier listener. Search-next, search-previous, and search-close are intercepted when the native search overlay has focus; the replacement component then does not own input.
3. A focused non-search overlay receives viewport input instead of the transcript. Kit does not transfer overlay ownership. Existing overlay tests retain that behavior.
4. Without that overlay focus, the transcript owns page, half-page, line, previous/next prompt, and top/bottom actions. Tests remap each of these actions and prove that the replacement handler receives no triggering bytes.
5. The public debug callback reserves its native debug key when present. Other extension-installed input listeners are not exposed by a public ownership API; Kit cannot infer them.
6. Remaining input reaches the focused component. Pi filters key-release events unless that component opts in.

Hint filtering uses public `getKeybindings()`, `tui.mode`, terminal-protocol capability, and Kit's matcher-overlap logic. Alias, modifier-order, legacy collision, and disambiguated-protocol tests remain in place. It does not deep-import renderer internals or change the host's configured actions. It conservatively omits transcript-owned keys for replacement screens, even when another overlay could temporarily receive those keys.

`native-key-overlap.test.ts` adds native regressions for malformed host bindings, literal `+`, Kitty physical/logical shifted symbols, modifyOtherKeys, and printable base-layout alternatives. Invalid modifier syntax is rejected without repairing it into another key. Protocol probes use Pi's public matcher in both directions; they do not invent functional-key layout alternatives. Native authoritative Latin/symbol identities and the first usable fallback remain tested.

Default PageUp/PageDown continue to scroll the fullscreen transcript. Regular mode leaves them available to Kit documents. Non-conflicting host remaps make document paging reachable in fullscreen. Standalone Space retains independent local document search unless a standard component action or an earlier host action owns it. A native search overlay is not a search of the Kit document.

Kit emits no application-owned OSC program-status codes and does not claim native blocked-status reporting for custom screens. It adds no public API, setting, persistence schema, coding-agent runtime import, or extension-specific branch.

## Verification record

The focused run used installed `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` runtime manifests reporting 1.3.0. This is a verification snapshot, not a compatibility floor.

Completed commands from the repository root:

```sh
npm --workspace @narumitw/pi-tui-kit run build
npm --workspace @narumitw/pi-tui-kit run typecheck
node node_modules/vitest/vitest.mjs run packages/pi-tui-kit/test
npm run package:pack -- tui-kit
```

The final focused package run passed **49 files and 907 tests**, including 73 added regressions. It includes package-export and representative Jiti fixture smokes. The Vitest configuration loads emitted JavaScript; final test emission passed. The Kit package typecheck also passed separately.

The package Biome check passed for 107 files, `git diff --check` passed, and the fenced-code-aware README heading audit passed for 36 packages. The pack dry run passed. Its 100-file inventory contains built JavaScript and declarations, README, license, manifest, and the three package-owned documents; it excludes source and tests.

The final semantic review applies `AGENTS.md`, the Kit guidelines, `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and Pi's TUI, extension, theme, and RPC UI contracts. No settings persistence path or asynchronous production task changed. The audit checks rendering bounds, callback theme roles, focus propagation, cancellation, stale ownership, callback draining, public imports, and API admission separately from build success.

Final serialized root verification passed: `npm run format`, `npm run check`, and `npm test` (**673 files and 11,318 tests passed; one file and two tests skipped by existing platform/environment gates**). Initial integration fixture and Proxy-signal failures were corrected before the passing run. The registered BTW command now has a real fullscreen-proxy regression, not only separate mocked boundary tests. Physical terminal negotiation, IME placement, clipboard/browser integration, and subjective visual acceptance remain unverified; simulated native frames do not establish cross-terminal acceptance.
