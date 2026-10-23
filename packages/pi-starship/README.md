# 🚀 pi-starship — Build Pi's Footer with Starship-style TOML

[![npm](https://img.shields.io/npm/v/@narumitw/pi-starship)](https://www.npmjs.com/package/@narumitw/pi-starship) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Build a customizable Pi footer with Starship-style TOML, native Pi modules, conditional formats, palettes, and responsive multiline layout.
The extension parses and renders the footer itself, so it does not need the `starship` executable or a shell prompt.

> **Different package:** The unscoped npm package `pi-starship` delegates to the Starship binary.
> This package is `@narumitw/pi-starship` and renders Pi-specific modules natively.

## ✨ Features

- Starts with a readable built-in footer and offers Starship presets plus a Pi-native Minimal preset.
- Supports root and module formats, conditional groups, `$all`, styles, palettes, and width-aware `$fill` alignment.
- Selects provider, model, and thinking styles from exact runtime values with ordered module rules.
- Provides Pi, model, usage, Git, pull request, package, language, environment, deployment, cloud, and execution modules, with usage totals including persisted cache warming.
- Offers opt-in Jujutsu, native RAM/optional Linux swap, and Linux sysfs battery modules, all disabled by default.
- Wraps native multiline layouts to terminal width instead of truncating them.
- Keeps rendering pure while refreshing filesystem, process, and network-derived data through bounded caches.
- Uses `/starship` for named TOML profiles, live previews, presets, customization, and recovery history.
- Shares settings through unlisted GitHub Gists and reviews imported settings before replacement.
- Bundles the authoritative configuration skill and references for editing `pi-starship.toml` or answering setup questions.
- Loads a generated split runtime to reduce Pi package startup work.

## 📦 Install

```bash
pi install npm:@narumitw/pi-starship
```

Try the published package without installing it permanently:

```bash
pi -e npm:@narumitw/pi-starship
```

Build the generated runtime and try the local package from this repository:

```bash
npm --workspace @narumitw/pi-starship run build
pi -e ./packages/pi-starship
```

The package declares `dist/index.ts`, so build an unbuilt local checkout before Pi loads the package directory.
Install only from sources you trust because Pi extensions and skills run with Pi's permissions.
Do not enable this with `@narumitw/pi-statusline`: both own Pi's footer, and Pi does not arbitrate that conflict.

## 🚀 Quick start

Start Pi with the extension to use the built-in footer without creating a settings file.
Run `/starship` to inspect the footer, choose a preset, or customize the configuration.

The bundled configuration skill is manual-only and is not available for automatic model invocation.
Run `/skill:configure-pi-starship` before asking Pi to explain or edit `pi-starship.toml`:

```text
/skill:configure-pi-starship explain the aws module
/skill:configure-pi-starship enable the directory and git_branch modules
```

The skill was renamed from `configuring-pi-starship`; use `/skill:configure-pi-starship` instead of the old invocation.
The skill loads the relevant reference and validates file edits.
It does not cover general TOML, shell Starship configuration, extension source development, or unrelated footer work.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/starship` | Customize the footer, preview presets, inspect modules, or restore built-in configuration; RPC shows help. |
| `/starship settings` | Edit, preview, and confirm TOML; RPC shows the file path. |
| `/starship status` | Show the configuration source, path, and diagnostics. |
| `/starship help` | Show command and configuration help. |

All routes support TUI and RPC with the exceptions above and reject unknown or trailing arguments.
Print and JSON modes produce no command output; the footer runs only in TUI mode.
Profiles, history, preset selection, module inspection, and Gist sharing and import are menu-only, not extra subcommands.
Restoring built-in configuration requires an existing settings document to replace; see [Settings](#-settings).
Effective TOML and settings-document reviews support literal document search in TUI mode: Space opens search, configured search-close exits search, and Back retains its existing meaning. Search does not modify settings.

## ⚙️ Settings

The package bundles the `configure-pi-starship` skill as the authoritative configuration guide for users and agents.
Invoke `/skill:configure-pi-starship` before asking Pi how to configure the footer or edit `pi-starship.toml`.
The skill answers from its references and consults the bundled source only when the public documentation does not cover a question.

Read the references directly when preferred:

- [Configuration and format](./skills/configure-pi-starship/references/configuration.md) — settings schema, validation and fallback behavior, presets, examples, format grammar, styles, palettes, and display thresholds.
- [Complete module catalog](./skills/configure-pi-starship/references/module-catalog.md) — exact variables, default formats, symbols, enabled state, style fields, display defaults, option types, ranges, and enum values.
- [Module behavior](./skills/configure-pi-starship/references/modules.md) — reachability, exact detection defaults, command gates, output semantics, aliases, truncation, and module-specific behavior.
- [Runtime and security](./skills/configure-pi-starship/references/runtime-and-security.md) — network and command execution, local metadata, cloud and deployment context, fill layout, refresh behavior, and limitations.

The only configuration source remains `<getAgentDir()>/pi-starship.toml`.
A minimal custom document can select and style only the modules it needs:

```toml
format = "$model$directory$git_branch"

[model]
style = "bold blue"
```

Use `fg:pi:accent` to follow Pi's active theme; see [Pi theme colors](./skills/configure-pi-starship/references/configuration.md#pi-theme-colors).
Provider, model, and thinking modules also accept ordered exact-match `style_rules`.
For per-extension status colors, add `[extension_status.styles]` entries using raw Pi status keys (or `namespace:*`); unmatched statuses keep the module style.
See [Configuration and format](./skills/configure-pi-starship/references/configuration.md) for examples and matching rules.
Use `/starship` for interactive configuration, preview, diagnostics, presets, and recovery.
Manual file edits load at the next `session_start`, including `/reload`.

Existing defaults and the built-in footer remain unchanged.
Module references cover bounded regex substitutions/context rules, component version formats, Git templates/controls, clock zones/ranges, Python argv alternatives, environment detectors, requirement styling, and private-package visibility.
The six Jujutsu/system modules require explicit `disabled = false` plus a root reference or `$all`; see [module behavior](./skills/configure-pi-starship/references/modules.md#jujutsu-modules).

## 🗃️ Profiles and history

Open `/starship` → **Profiles** to save the current TOML under a name, edit it, duplicate it, rename it, or delete it.
Moving the selection previews that document in the footer without saving, running commands, or starting network requests.
Previews use existing runtime data; modules with no available data can be empty.
Applying a profile requires confirmation and replaces the complete active document.
Editing can save only the profile or save and apply it; a saved profile remains available if the later application fails.

Profiles are independent copies, not live links: editing or deleting a saved profile does not change the current footer.
Comments and unknown fields are preserved.
The active file remains `<getAgentDir()>/pi-starship.toml`; named documents are stored under `<getAgentDir()>/pi-starship/profiles/<name>.toml`.
For the default Pi directory, this is `~/.pi/agent/pi-starship/profiles/`.

Open **Configuration** → **History** to review recovery copies, preview and restore a document, save it as a profile, or delete a new history entry after confirmation.
Managed replacements preserve the previous document before writing the new one; a backup failure blocks replacement.
New recovery copies use `<getAgentDir()>/pi-starship/history/`; existing timestamped skill backups remain in place and are available read-only.
History is not automatically pruned and is not a complete record of arbitrary external file edits.
Ordinary session startup remains read-only.

Escape returns one level and Ctrl+C closes the flow; temporary previews are removed without undoing an already confirmed save.
Profile and history files can contain sensitive settings or local paths; new documents use private file permissions on POSIX.
Storage serializes in-process work and rejects detected changes during review, but does not lock out external editors.
See [Configuration and format](./skills/configure-pi-starship/references/configuration.md) for naming, conflicts, and recovery limits.

## 🔗 Share and import settings

In TUI mode, open `/starship` → **Configuration** and select **Share settings as Gist…** or **Import settings from Gist…**.
Install GitHub CLI (`gh`) and run `gh auth login` for github.com with Gist access first; pi-starship uses that authentication and stores no GitHub credentials.

Sharing reviews the exact loaded TOML, including comments and unknown fields, then asks permission to upload a new unlisted Gist with a `pi-starship.toml` file.
With no settings file, it shares the built-in example without creating a local file.
**Unlisted is not private: anyone with the link can read it. Remove secrets and local paths before sharing.**
The result is a shareable Gist URL; existing Gists are never updated.

Import accepts a Gist ID or an `https://gist.github.com/<owner>/<id>` link and reads only `pi-starship.toml`.
It validates the TOML, shows the full document for review, then previews the footer and asks permission to replace the entire local settings document.
Review untrusted settings carefully: they can enable command execution and network requests.
A successful import applies immediately, preserves the imported bytes, and retains a recovery copy of the previous document; application failure attempts to restore the previous document and footer.
Concurrent in-process settings changes or disk changes during review block the import; this is not a cross-process lock.

Only github.com Gists are supported, with a 64 KiB document limit, a 512 KiB API response limit, and a 30-second request timeout.
Incomplete or truncated files are rejected without following raw-file URLs.
Escape or Ctrl+C cancels a request, and session replacement or shutdown stops owned work.
Cancelling or losing an upload response cannot undo a Gist already created on GitHub: check your Gists before retrying.

## 🔒 Security and privacy

Some opt-in modules read local development, deployment, cloud, host, user, or system metadata, run bounded local commands, or query GitHub through `gh`.
Review [Runtime and security](./skills/configure-pi-starship/references/runtime-and-security.md) before enabling them or accepting imported settings, especially configured Python executables/arguments and environment detector names.
Jujutsu reads the recorded change without snapshotting dirty files or integrating operations.
Battery is Linux sysfs only; memory uses native RAM totals with Linux swap only when requested.
Physical battery-state transitions remain unverified; no cross-platform battery support is claimed.

## 🚧 Limitations

pi-starship is Starship-inspired rather than fully compatible with shell Starship.
The complete supported and intentionally omitted behavior is documented in [Runtime and security](./skills/configure-pi-starship/references/runtime-and-security.md).

## ➕ Adding a module

Create `src/modules/<name>.ts` with its format variables, defaults, and runtime value resolver, then register it in display order in `src/modules/catalog.ts`.
Configuration names, validation variables, defaults, and `$all` ordering are derived from that catalog.
Add the module to the built-in root format only when it should be visible by default, then document and test its user-facing values.
Keep `extension_status` last in the catalog so arbitrary third-party statuses follow native module output.

## 🗂️ Package layout

```text
packages/pi-starship/
├── src/                               # Modules, formats, presets, and runtime collectors
│   ├── index.ts                       # Thin Pi entrypoint
│   └── pi-starship.ts                 # Footer lifecycle and cached refresh
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── skills/configure-pi-starship/      # Authoritative configuration skill and references
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi Coding Agent, Starship statusline, Starship TOML, terminal footer, native statusline, configuration editing, agent skill, GitHub pull request, prompt cache, cache hit rate, Pi extension

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
Starship attribution and its ISC license are included in [`NOTICES.md`](./NOTICES.md).
