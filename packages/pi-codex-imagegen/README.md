# 🎨 pi-codex-imagegen

[![npm](https://img.shields.io/npm/v/@narumitw/pi-codex-imagegen)](https://www.npmjs.com/package/@narumitw/pi-codex-imagegen)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Generate images from Pi through the Codex image endpoint, without starting Codex CLI, an agent, or its plugins.

> **Experimental:** This uses an internal ChatGPT endpoint, not the public OpenAI Images API. Real account access and transparent output have not been verified. The endpoint can change or reject third-party clients. Do not publish the initial package until the [live checks](./docs/verification.md) pass and publication is explicitly approved.

## ✨ Features

- Generate an image manually from a menu or through an opt-in model tool.
- Save original image bytes without overwriting an existing file.
- Cancel owned requests and prevent results from reaching a replaced session.
- Keep authentication with Pi rather than create another credential store.

## 📦 Install

This new package is currently source-only; registry installation is unavailable before its first approved publication. Extensions run with Pi's permissions. Review the source before loading it.

From the repository root:

```bash
npm install
npm run build
pi -e ./packages/pi-codex-imagegen
```

To keep the local checkout installed instead of loading it for one invocation:

```bash
pi install ./packages/pi-codex-imagegen
```

The source entrypoint needs no package build. The repository build prepares the Kit library used by the menu.

## 🚀 Quick start

Use Pi's `/login` to sign in to the `openai-codex` provider, then open `/imagegen`, choose **Generate Image**, and enter a prompt. The default output is `~/.pi/agent/pi-codex-imagegen/`; the saved path is shown with the result.

The `openai` provider's login and a login held only by Codex CLI are not substitutes. This extension does not import `~/.codex/auth.json`. Your main Pi model can use another provider. Generation sends the prompt to ChatGPT and can consume account quota.

## 💬 Commands

`/imagegen` opens the generation manager, user settings, authentication status, and help. It accepts no arguments and requires TUI mode. RPC receives an unsupported-mode notice; print and JSON receive a command error. No generation is started by these rejection paths.

The prompt dialog preserves Pi's native multiline editing and paste behavior. External-editor launch is unavailable in this cancellable dialog because Pi's external-editor handoff cannot be aborted when the dialog is disposed.

## 🛠️ Tools

`codex_imagegen` generates one image from a prompt. It accepts an optional output basename and transparency override. It returns a path, image content, and structured file details. Image content is handled by Pi's normal tool-result image policy.

The tool is **disabled by default**, including codemode, tool search, and nested calls. Enable it explicitly in `/imagegen` → Settings. The manual menu does not require tool enablement. The enabled tool also works in headless modes.

A supplied filename must be a basename, not a path. Its optional suffix must be `.png`, `.jpg`, `.jpeg`, or `.webp` and match the returned media. Without a suffix, the detected suffix is appended. An omitted filename gets a unique name.

## ⚙️ Settings

User settings live in `<getAgentDir()>/pi-codex-imagegen.json`, normally `~/.pi/agent/pi-codex-imagegen.json`. Edit them through the menu or manually. Menu changes save immediately; Escape does not undo saved changes. Manual edits take effect on the next session start or `/reload`. There are no project overrides or extension-specific environment variables.

| Setting | Default | Accepted value |
| --- | --- | --- |
| `toolEnabled` | `false` | Boolean; permits model access. |
| `outputDir` | `<getAgentDir()>/pi-codex-imagegen/` | Nonempty path without control, format, or surrogate characters. Absolute paths and `~/` are supported; relative paths use the request's working directory. |
| `transparentBackground` | `false` | Boolean; requests transparency by default, with a per-call override. Actual alpha support is provider-dependent. |

For example, to enable the tool while retaining the default output directory:

```json
{
  "toolEnabled": true
}
```

A custom Pi agent directory also changes the default output directory. Defaults and Status do not create files or directories. An explicit generation can create its output directory even if generation later fails.

Missing settings mean defaults. Invalid files produce a warning or lifecycle error and block settings writes until repaired. Saves preserve unknown fields, use temporary-file-plus-rename publication, and keep the prior effective values after a failed save or application. Settings reads and writes are ordered within one Pi process, not locked across separate Pi processes.

Changes require an idle session. Enabling or disabling the tool deliberately changes the model-visible tool set and can affect prompt caching. Ordinary turns do not change tools, prompts, or earlier messages. Manual results append at the conversation tail without starting a model turn.

## 🔒 Security and privacy

Only the entered prompt and fixed generation options are sent to `https://chatgpt.com/backend-api/codex/images/generations`. No conversation history, input files, Codex instructions, or plugin settings are sent by this extension. Compatible Pi OAuth supplies the token and account header. Neither credentials nor account identifiers appear in extension settings, status, or errors.

The destination is fixed, redirects are rejected, arbitrary provider headers are not forwarded, and no model or API fallback is used. The client identifies itself as `pi-codex-imagegen`. Provider denials are errors, not a reason to bypass policy.

Output paths must contain real directories, not symlink components. Files use exclusive creation and private permissions. This prevents ordinary overwrites and filename collisions, but is not an OS sandbox against another process with the same filesystem permissions changing directories during an operation.

The client uses runtime `fetch` without changing global network settings. Proxy handling depends on the host's HTTP dispatcher; SDK hosts must provide their own network setup. Pi-specific provider or WebSocket proxy routing is not a separate guarantee for this endpoint.

## 🚧 Limitations

- Only the legacy `openai-codex` OAuth provider at the canonical ChatGPT backend is accepted. Custom gateways, API keys, generic OpenAI OAuth, and automatic CLI credential reuse are unsupported.
- The fixed image model is `gpt-image-2`, with quality and size set to `auto`. Image editing, references, masks, batches, and extra model/format controls are unsupported.
- Authentication waits are limited to 30 seconds; the whole operation has a five-minute HTTP/auth budget. Generation can finish before headers are sent, so headers share that longer budget. The client never retries automatically.
- Cancelling closes owned HTTP work but cannot guarantee that remote generation stops or quota is refunded. Pi-owned OAuth refresh may finish after this extension stops waiting. A file saved before late cancellation remains on disk.
- Pi's normal session shutdown aborts work directly. Direct SDK `AgentSession.dispose()` omits that event in the tested runtime; active flows check public context liveness every 100 ms and before subsequent side effects. No poll runs while the extension is idle.
- Responses are limited to 32 MiB decoded, 16,384 pixels per side, and 16,777,216 pixels total. Static PNG, JPEG, and WebP containers are supported; animations are rejected. Header/container checks are not a complete JPEG/WebP entropy decoder or a codec-security guarantee.
- Inline previews depend on terminal support and Pi image settings. Manual previews can be resized while the original file stays unchanged. Image usage and quota are not reported as an invented Pi dollar cost.

See the [protocol contract](./docs/protocol.md) for implementation evidence and the [verification guide](./docs/verification.md) for remaining account and physical-terminal checks.

## 🗂️ Package layout

- `src/index.ts` forwards the extension factory; descriptive source modules own requests, storage, and UI.
- `docs/` contains the protocol contract, verification evidence, and release restrictions.
- `test/` contains repository-only deterministic fixtures and Pi runtime tests; it is not published.

## 🔎 Keywords

Pi extension, Codex, image generation, ChatGPT OAuth, terminal UI, image assets.

## 📄 License

[MIT](./LICENSE) © narumiruna
