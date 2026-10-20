# @narumitw/pi-inspect

## 0.3.1

### Patch Changes

- 1f1c293: Update React to 19.3.1, Langfuse to 6.0, and the TypeSafe SDK to 0.7 in their respective packages. Preserve trace-only input and output updates, metadata encoding, and root observation detection with Langfuse 6. Accept unreported TypeSafe token usage without rejecting valid answers.

## 0.3.0

### Minor Changes

- c3c65e8: Add a read-only Cache tab with active-branch usage history, weighted hit rates, conversational comparisons, and estimated costs. Keep unknown accounting explicit and include persisted warming and summary usage without changing model input.
- 1be48cb: Add Environment with Tools, MCP Servers and Skills tabs beside Context and Session. Move Session filters inline and keep Event details controls inside Session. Show bounded public resource metadata with explicit unavailable states for MCP health, server ownership and skill content.

## 0.2.2

### Patch Changes

- c0d362f: Update the Radix collapsible runtime dependency to the latest patch release.

## 0.2.1

### Patch Changes

- 617069f: Show searchable structured tool documentation in Details → Tools, including expandable parameter schemas, constraints, documented returns, and original captured JSON access. Recognize Pi's Codemode return syntax, preserve declared types, and show conservative requiredness for composed schemas.

## 0.2.0

### Minor Changes

- a2157ba: Add an independently installable, consent-gated session inspector with a read-only browser viewer, historical context projections and bounded live tool-call observation.
- c9c59c8: Separate model Context from Session history, add branch-scoped conversation groups and explicit branch previews, and show content-first Details with independently navigable captured executions. Preserve historical evidence and move current runtime inventories out of event details.
