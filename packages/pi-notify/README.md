# 🔔 pi-notify

[![npm](https://img.shields.io/npm/v/@narumitw/pi-notify)](https://www.npmjs.com/package/@narumitw/pi-notify)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Send Telegram reminders when Pi stops automatic work, so you can return to review its result.

## ✨ Features

- Notify private chats, groups, supergroups, and forum topics, including multiple selected destinations.
- Identify the computer, session, repository, branch, and worktree without forwarding conversations.
- Choose immediate notifications or reminders after terminal inactivity.
- Configure and test destinations through a masked, menu-first setup flow.

## 📦 Install

Extensions run with Pi's permissions. Enable this extension only if the notification metadata may leave your computer. Bot credentials are stored in a private user settings file, not project settings.

From a local checkout, run these commands from the repository root:

```sh
npm install
npm run build
pi -e ./packages/pi-notify
```

After npm publication, persistent and temporary installation will be available with:

```sh
pi install npm:@narumitw/pi-notify
pi -e npm:@narumitw/pi-notify
```

Restart Pi or run `/reload` after persistent installation. The extension uses Pi's TypeScript loader and does not require a package-owned build. It requires Pi APIs for `agent_settled`, `getAgentDir()`, and trusted project settings, plus Node.js with native `fetch` and `AbortSignal.any()`.

## 🚀 Quick start

Create a bot with Telegram's [BotFather](https://t.me/BotFather), then start a private conversation with it. Obtain that conversation's numeric chat ID through the [Bot API](https://core.telegram.org/bots/api#getupdates) after sending a message; keep the bot token private. For a group, add the bot and permit it to send messages. Stop any other update consumer before manually using `getUpdates`; an active webhook also prevents that method from working.

Run `/notify`, add a Telegram destination, and confirm its settings. Use Send test to preview the disclosed metadata and explicitly send a test. In Settings, select the destination and enable notifications. The next eligible settled work period sends a reminder. Setup alone does not enable automatic notifications.

## 💬 Commands

`/notify` opens destination management, Settings, Status, Help, and confirmed test delivery in TUI mode. It accepts no arguments. Settings changes save immediately; closing the screen does not undo them. Destination edits remain unsaved until confirmation. Escape goes back; Ctrl+C closes the flow. Cancelling a running test closes the menu and cannot recall a message already accepted by Telegram.

RPC receives manual configuration instructions instead of a custom terminal screen. Print and JSON reject interactive setup. Automatic delivery is independent of the menu and requires no model tool or prompt changes.

## ⚙️ Settings

User settings are stored at `<getAgentDir()>/pi-notify.json`, normally `~/.pi/agent/pi-notify.json`. Trusted project overrides use `<workspace>/.pi/pi-notify.json`. Choose User or Project scope in `/notify` Settings. Destinations and credentials are always User-scoped.

Notifications default to disabled, with immediate mode and a stored inactivity duration of 30 seconds. Loading defaults does not create a file. Successful menu saves apply immediately; manual edits take effect on session start or `/reload`.

```json
{
  "enabled": true,
  "mode": "after-inactivity",
  "inactivitySeconds": 30,
  "targetIds": ["personal"],
  "destinations": {
    "personal": {
      "provider": "telegram",
      "label": "Personal Telegram",
      "botToken": "<bot-token>",
      "chatId": "123456789"
    }
  }
}
```

See the bundled [settings and behavior reference](./docs/settings.md) for accepted values, inheritance, persistence, provider boundaries, failure recovery, and inactivity timing.

## 🔒 Security and privacy

Notifications send the operating-system hostname, session name and ID, working directory, available Git repository/worktree/branch, elapsed time, and settlement timestamp to the selected Telegram chats. Paths shorten the home prefix to `~` when possible, but names and paths can still disclose private information. They describe the host running Pi, which can differ from your SSH client computer.

No prompts, assistant answers, code, tool output, Git remotes, or raw provider errors are sent. Dynamic metadata is bounded and terminal controls are removed; `@` is replaced with `＠` to avoid accidental mentions. Messages use plain text with link previews disabled. Credential values never appear in preview, status, or error output. POSIX settings writes use `0600` permissions and temporary-file-plus-rename publication. JavaScript memory is not secure credential storage; revoke an exposed bot token through BotFather.

## 🚧 Limitations

Only Telegram is implemented. The provider boundary separates transport from notification policy, but it does not load third-party plugins.

Inactivity means no input reached this extension, not proof that you are away. Pi handles fullscreen focus, mouse, scrolling, and search before extension input listeners. Those actions do not reliably cancel a reminder. Reading without typing can still produce one. Type a key that reaches the editor to cancel a pending reminder. Focus or mouse events count only if Pi forwards them; terminal support alone is not sufficient. This extension does not change Pi's listener order, enable focus reporting, or detect screen locks. RPC, print, and JSON cannot observe terminal input, so inactivity mode delivers at settlement instead.

Notification delivery is best effort with one attempt and a 10-second request timeout. There is no automatic retry, persistent queue, or replay after reload. Accepted means Telegram accepted a message, not that someone read it. Telegram rate limits can reject rapid runs; Status reports a safe error code and available retry-after time. Immediate shutdown can cancel an in-flight notification, especially in a short-lived headless session.

Manual aborts and interactive confirmation prompts do not notify. `agent_settled` means Pi will not continue automatically, not that the requested task succeeded. Preflight errors that do not produce a settled work period cannot generate a completion notification. No cooldown suppresses distinct eligible work periods.

## 🗂️ Package layout

- `src/index.ts`: Pi entrypoint forwarding to `src/notify.ts`.
- `src/`: session coordination, metadata, settings, menu, provider contract, and Telegram transport.
- `docs/`: installed settings and behavior reference.
- `test/`: repository-only deterministic tests.

The package publishes TypeScript source, documentation, and its license. It does not publish test fixtures or credentials.

## 🔎 Keywords

Pi coding agent, Telegram bot, completion notification, inactivity reminder, session, Git worktree.

## 📄 License

[MIT](./LICENSE).
