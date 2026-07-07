# Jiso

Jiso is a fork of [Visual Studio Code – Open Source ("Code - OSS")](https://github.com/microsoft/vscode) with a built-in **local Claude Code agent host**. Instead of routing through a hosted proxy, the editor's chat drives your own local [`claude`](https://docs.anthropic.com/en/docs/claude-code) (Claude Code) using the Claude Agent SDK and your existing Claude login — the agent runs on your machine, against your workspace, on your subscription.

> Jiso is an independent fork and is **not** affiliated with or endorsed by Microsoft or Anthropic.

## Highlights

- **Local Claude agent host** — chat sends prompts to a locally running `claude` session (native SDK, headless). Tool-permission prompts, plan mode, and `AskUserQuestion` are surfaced in the UI.
- **Bring your own Claude** — authenticates with your local Claude Code login / subscription; no separate API key or hosted proxy required.
- **Tiered plan/execute models** — pick `Opus Plan (Sonnet execution)` or `Fable Plan (Sonnet execution)`: the premium model does plan-mode reasoning, Sonnet runs the execution steps. Concrete Opus/Sonnet/Haiku and `Auto` stay selectable, and a per-prompt token readout is shown on each response.
- **Local context management** — oversized tool outputs are capped before they enter the conversation, repeated identical file reads can be deduplicated, and long sessions are auto-compacted before they get expensive. All client-side, all configurable in the Claude settings panel.
- **Transparent usage** — per-session logs (grouped by prompt: every tool call, token usage, cache reads/writes, trims and compactions) plus a plan-usage readout, so you can see exactly what a session consumed.
- **Agent sessions** — chats open as editor tabs; sessions and their history are managed alongside your workspace.
- **Everything else is Code - OSS** — the same editor, extensions, terminal, and debugging you already know.

## Install

### 1. Install and sign in to Claude Code

Jiso drives your own local `claude` CLI — install it first and log in once:

```sh
npm install -g @anthropic-ai/claude-code   # or see https://docs.anthropic.com/en/docs/claude-code
claude                                      # then run /login and follow the browser flow
```

Any Claude subscription that works with Claude Code works with Jiso. Jiso itself stores no credentials — it inherits the CLI's login.

### 2. Download and run Jiso

Grab the artifact for your platform from the [Releases](../../releases) page:

| Platform | Artifact |
|---|---|
| macOS (Apple Silicon) | `VSCode-darwin-arm64.tar.gz` — unpack and move the app to `/Applications` |
| Windows (x64) | `VSCode-win32-x64.zip` — unpack anywhere and run the executable |
| Linux (x64) | `VSCode-linux-x64.tar.gz` — unpack and run `bin/code-oss` |

> **Note:** release builds are **unsigned**. On first launch macOS Gatekeeper will warn — right-click the app → **Open** (or `xattr -dr com.apple.quarantine "/Applications/Code - OSS.app"`). On Windows, SmartScreen will warn — **More info → Run anyway**.

### 3. First chat

Open a folder, open the chat view (`⌃⌘I` on macOS, `Ctrl+Alt+I` on Windows/Linux), pick a model in the input's model picker, and send a prompt. Tool permissions are asked in the UI as the agent works; the **Claude Settings** button in the title bar holds context-management and permission-mode options, and **Session Logs** in the chat input shows exactly what each prompt consumed.

## Build from source

Requires the standard VS Code build prerequisites (Node.js, Python, a C/C++ toolchain — see the [VS Code contributing guide](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites)).

```sh
npm install
./scripts/code.sh          # macOS/Linux — launch the dev build
# scripts\code.bat         # Windows
```

## Acknowledgements

Jiso is built on Microsoft's [Code - OSS](https://github.com/microsoft/vscode), released under the MIT license. "Claude" and "Claude Code" are products of [Anthropic](https://www.anthropic.com/).

## License

This fork's source is licensed under the [MIT](LICENSE.txt) license.

Portions Copyright (c) Microsoft Corporation. All rights reserved, used under the MIT license.
