# Jiso

Jiso is a fork of [Visual Studio Code – Open Source ("Code - OSS")](https://github.com/microsoft/vscode) with a built-in **local agent host**: the editor's chat drives coding agents that run on your machine, through each vendor's own official CLI or SDK, on your own logins. No hosted proxy, no middleman, no credentials held by the IDE.

The default agent is **Claude Code** — chat sends prompts to a locally running `claude` session via the official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), using the Claude Code login you already have.

> Jiso is an independent community fork. It is **not** affiliated with, endorsed by, or supported by Microsoft, Anthropic, Cursor, OpenAI, or Google.

## Highlights

- **Local Claude agent** — prompts run in a local, headless `claude` session. Tool-permission prompts, plan mode, and `AskUserQuestion` are surfaced natively in the UI.
- **Bring your own login** — Jiso authenticates nothing itself; it inherits your `claude` CLI login. No API key, no separate sign-in, no hosted relay.
- **Multiple agents, one picker** — models from every enabled agent appear in the chat's model picker, grouped per agent; picking another agent's model switches the conversation to that agent in place.
- **Tiered plan/execute models** — pick `Opus Plan (Sonnet execution)` or `Fable Plan (Sonnet execution)`: the premium model does plan-mode reasoning, Sonnet runs the execution steps. Concrete Opus/Sonnet/Haiku and `Auto` stay selectable, and a per-prompt token readout is shown on each response.
- **Local context management** — oversized tool outputs are capped before they enter the conversation, repeated identical file reads can be deduplicated, and long sessions are auto-compacted before they get expensive. All client-side, all configurable in the Claude settings panel.
- **Transparent usage** — per-session logs (grouped by prompt: every tool call, token usage, cache reads/writes, trims and compactions) plus a plan-usage readout, so you can see exactly what a session consumed.
- **Agent sessions** — chats open as editor tabs; sessions and their history are managed alongside your workspace.
- **Everything else is Code - OSS** — the same editor, extensions, terminal, and debugging you already know, under the MIT license.

## Supported agents

| Agent | Backend | Status |
|---|---|---|
| **Claude Code** | Official Claude Agent SDK + your local `claude` login | Default |
| **Cursor Agent** | Official `cursor-agent` CLI (documented headless mode) + your Cursor login | Opt-in setting |
| **Codex** | Official `codex` CLI/SDK + your login | Opt-in setting, experimental |
| Antigravity | `agy` CLI | **Disabled.** Google's policy on third-party tools driving Antigravity is currently unclear and enforcement has been strict, so this integration is switched off in source until that changes. |

Every agent follows the same rule: Jiso spawns the vendor's **own official client** locally, under **your own login**, using only documented interfaces. See [Authentication & Terms of Service](#authentication--terms-of-service).

## Known limitations

Things most developers expect from an IDE that Jiso can't do (yet). Read this before making it your daily driver:

- **No extension marketplace.** Microsoft's Marketplace is licensed exclusively to official VS Code builds, and no alternative gallery is configured yet — so there is no in-app extension search/install. Extensions must be sideloaded via `Extensions: Install from VSIX...`.
- **No Microsoft-proprietary extensions.** Remote-SSH / Dev Containers / WSL, Live Share, Pylance, and GitHub Copilot are licensed for official VS Code only and won't run here. If remote development is core to your workflow, Jiso isn't a fit today.
- **No AI tab-autocomplete.** The agents live in chat; there is no ghost-text inline completion engine yet. Regular (non-AI) IntelliSense from Code - OSS works as usual.
- **Claude Code power features are only partly surfaced.** Sub-agent activity renders as collapsed tool calls, not as first-class parallel sessions you can watch or steer individually; custom subagents (`/agents`), hooks, and custom slash-command management have no in-IDE UI. Because Jiso drives your real Claude Code install, file-based configuration (`~/.claude/`, your repo's `.claude/` directory, `CLAUDE.md`) still fully applies — you just edit it outside the IDE.
- **No auto-update.** There is no update server; updating means downloading the next release yourself.
- **No settings sync or cloud session sync.** Settings and chat sessions live on the machine; nothing follows you to another device.
- **Three build targets only**: macOS Apple Silicon, Linux x64, Windows x64. No Intel Mac, Linux arm64, or Windows arm64 builds; the Windows build is a portable `.zip`, not an installer.
- **Unsigned builds** — see [Security](#security).

## Install

### 1. Install and sign in to Claude Code

Jiso drives your own local `claude` CLI — install it first and log in once:

```sh
npm install -g @anthropic-ai/claude-code   # or see https://code.claude.com/docs
claude                                      # then run /login and follow the browser flow
```

Any Claude subscription that works with Claude Code works with Jiso. Jiso itself stores no credentials — it inherits the CLI's login, exactly as if you ran `claude` in a terminal.

### 2. Download and run Jiso

Grab the artifact for your platform from the [Releases](../../releases) page:

| Platform | Artifact | Run |
|---|---|---|
| macOS (Apple Silicon) | `VSCode-darwin-arm64.tar.gz` | Move `Jiso.app` to `/Applications` |
| Windows (x64) | `VSCode-win32-x64.zip` | Unpack anywhere, run `Jiso.exe` |
| Linux (x64) | `VSCode-linux-x64.tar.gz` | Unpack, run `bin/jiso` |

> **Release builds are currently unsigned.** On macOS, Gatekeeper blocks unsigned browser downloads; either install from the terminal (no quarantine flag, opens normally):
>
> ```sh
> curl -L https://github.com/Badarch-Blueprint/jiso/releases/latest/download/VSCode-darwin-arm64.tar.gz | tar xz
> mv VSCode-darwin-arm64/Jiso.app /Applications/
> ```
>
> or clear the flag after a browser download: `xattr -dr com.apple.quarantine /Applications/Jiso.app`. On Windows, SmartScreen warns — **More info → Run anyway**. If you'd rather not trust unsigned binaries (a reasonable position), [build from source](#build-from-source).

### 3. First run

Open a folder, open the chat view (`⌃⌘I` on macOS, `Ctrl+Alt+I` on Windows/Linux), pick a model in the input's model picker, and send a prompt. On the very first Claude session, Jiso downloads the Claude Agent SDK from the npm registry (a one-time ~100 MB download with visible progress — see [How Jiso is built](#how-jiso-is-built) for why it isn't bundled). Tool permissions are asked in the UI as the agent works; the **Claude Settings** button in the title bar holds context-management and permission-mode options, and **Session Logs** in the chat input shows exactly what each prompt consumed.

## How Jiso is built

- **Source**: this repository — Code - OSS plus the agent-host fork layer, all MIT. There is no private code.
- **Pipeline**: releases are built by the public GitHub Actions workflow in [`.github/workflows/release.yml`](.github/workflows/release.yml) — the same `gulp` packaging path upstream Code - OSS uses, on GitHub-hosted runners. Every release corresponds to a tag you can build yourself and diff against.
- **No proprietary vendor code in artifacts**: the Claude Agent SDK is published by Anthropic under an all-rights-reserved license, so Jiso does **not** bundle or re-host it. Release artifacts contain only MIT-licensed code; at first use the app downloads the SDK for your platform **directly from the npm registry** (Anthropic's own distribution channel, pinned version) and caches it under your user-data folder.
- **Unsigned**: no Apple/Microsoft signing certificates yet. The workflow already supports signing + notarization the moment certificates are added; until then, first-launch OS warnings are expected.

## Authentication & Terms of Service

Jiso is designed to stay strictly on the compliant side of every vendor's terms. Three hard rules, enforced by design rather than policy:

1. **Jiso never asks for, mints, stores, or transmits any vendor credential.** There is no OAuth flow, no token capture, no API-key field for agent auth. Signing in means logging in to the vendor's own CLI (`claude /login`, etc.) — the credential lives wherever that vendor's client keeps it.
2. **All model traffic flows through the vendor's own official client**, spawned locally under your login, via documented interfaces (Claude Agent SDK / headless CLI modes). Jiso never talks to a vendor's backend, never proxies requests, and never modifies wire traffic.
3. **When a vendor's policy is unclear, the integration goes off.** The Antigravity provider is disabled in source today for exactly this reason.

What that means per vendor:

- **Claude**: your usage rides your own Claude subscription identically to running `claude` in a terminal. Anthropic's [legal & compliance page](https://code.claude.com/docs/en/legal-and-compliance) states that advertised Pro/Max usage limits assume "ordinary, individual usage of Claude Code and the Agent SDK" — which is what Jiso is. Anthropic directs *developers building products or services* to API-key authentication; if your use of Jiso goes beyond ordinary individual use, follow that guidance.
- **Cursor Agent**: uses `cursor-agent`'s documented headless mode; usage is metered and billed by Cursor exactly as their CLI documents.
- **In all cases** you are party to your own agreement with each vendor — review their terms, and know that vendors can change policies at any time. If they do, Jiso adjusts (as it already did with Antigravity).

## Security

- **Agents execute with your user privileges.** A coding agent can read, write, and run things in your workspace — that's the point, and also the risk. Tool-permission prompts are on by default; review what you approve, use the permission-level settings deliberately, and prefer trusted workspaces.
- **Data flow is yours to choose**: prompts and workspace context go only to the model vendor whose agent you invoke, through that vendor's own client. Jiso operates no servers and adds no telemetry of its own.
- **Unsigned binaries**: until releases are signed, the strongest assurance available is building from source at a release tag. Treat any Jiso binary you didn't download from this repository's Releases page as untrusted.
- **Reporting**: found a vulnerability? Please open a [GitHub security advisory](../../security/advisories/new) rather than a public issue.

## Build from source

Requires the standard VS Code build prerequisites (Node.js, Python, a C/C++ toolchain — see the [VS Code contributing guide](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites)).

```sh
npm install
./scripts/code.sh          # macOS/Linux — launch the dev build
# scripts\code.bat         # Windows
```

## Acknowledgements & trademarks

Jiso is built on Microsoft's [Code - OSS](https://github.com/microsoft/vscode), released under the MIT license. "Claude" and "Claude Code" are trademarks of [Anthropic](https://www.anthropic.com/); "Cursor" is a trademark of Anysphere; "Codex" is a trademark of OpenAI. Names are used only to identify the third-party tools Jiso integrates with; no affiliation or endorsement is implied.

## License

This fork's source is licensed under the [MIT](LICENSE.txt) license.

Portions Copyright (c) Microsoft Corporation. All rights reserved, used under the MIT license.
