---
title: Claude Code with Lore
description: Route Claude Code through the Lore memory gateway with the hosted install script or a manual setup.
sidebar:
  order: 3
---

Claude Code is Anthropic's terminal-based AI coding agent. Lore's gateway is the recommended way to run Claude Code with persistent memory and gradient context management.

## Install

The hosted install script sets up Lore and Claude Code in one step:

```bash
curl -fsSL https://withlore.ai/install | bash
```

Then launch Claude Code through the gateway:

```bash
lore run
```

`lore run` starts the Lore gateway (if not already running) and launches Claude Code with the right env vars to route through it. The gateway auto-detects Claude Code on your `PATH`.

## Manual setup

If you'd rather start the gateway yourself and launch Claude Code directly:

```bash
# Terminal 1
lore start

# Terminal 2
ANTHROPIC_BASE_URL=http://127.0.0.1:3207 \
DISABLE_AUTO_COMPACT=1 \
claude
```

`DISABLE_AUTO_COMPACT=1` is mandatory. Without it, Claude Code's built-in auto-compaction destroys the very context Lore is trying to preserve. The gateway already sets this when you launch via `lore run`.

## What you get

Every Claude Code conversation is captured in Lore's three-tier memory. Distillations run in the background, the recall tool is available, and your project knowledge is exported to `.lore.md` and `AGENTS.md` automatically. See the [architecture overview](../architecture/) for the full picture.

## Per-harness notes

- **Project identity is injected automatically.** When launched via `lore run`, the gateway injects `X-Lore-Project` (your `cwd`) and `X-Lore-Git-Remote` (your git remote, if any) as `ANTHROPIC_CUSTOM_HEADERS`. This lets the gateway attribute sessions to the right project even when Claude Code's system prompt doesn't include the path explicitly.
- **Custom upstream headers** are passed through Claude Code's `ANTHROPIC_CUSTOM_HEADERS` env var. Set it before launching Claude Code and the headers reach the upstream unchanged. This is the official Claude Code way to send custom headers to the upstream.
- **Beta-gated fields are preserved.** The gateway forwards `anthropic-beta` from the original request so features like `context_management` work transparently.

## Switching to a different harness

Your project knowledge (`.lore.md`, `AGENTS.md`, the SQLite database at `~/.local/share/lore/lore.db`) is shared across every supported harness. Switching from Claude Code to Pi or OpenCode on the same project preserves curated knowledge, distillations, and the AGENTS.md sync.

## Desktop app

The Claude Code Desktop app is an Electron app (macOS + Windows) that wraps the same `claude` CLI in a GUI. For local Code sessions, the Desktop spawns the `claude` CLI as a child process and reads `ANTHROPIC_BASE_URL` from `~/.claude/settings.json` — the same file the CLI uses.

**Setup:**

```bash
lore setup claude-code-desktop
```

This writes `~/.claude/settings.json` with `env.ANTHROPIC_BASE_URL` and `env.DISABLE_AUTO_COMPACT` — the documented path the Desktop's Code tab honors for Claude sessions. On Windows it also runs `setx ANTHROPIC_BASE_URL …` so dev/preview servers inherit the gateway URL too. Restart the Desktop app afterward.

**Fallback — in-app Local env editor.** If your Desktop build does not pick up `settings.json` (upstream bug [anthropics/claude-code#67619](https://github.com/anthropics/claude-code/issues/67619)), or you want dev/preview servers covered on macOS, set the values in the Desktop's in-app Local env editor: open the environment dropdown in the prompt box → hover **Local** → click the gear icon → add (one per line):

```
ANTHROPIC_BASE_URL=http://127.0.0.1:3207
DISABLE_AUTO_COMPACT=1
```

Restart the Desktop app. These values are stored encrypted (Electron `safeStorage`), so Lore cannot write them for you — this step is manual.

**Linux note:** The Desktop app is not available on Linux. Use the `claude` CLI through `lore run` (see the Install / Manual setup sections above).

**Verifying the route:** Start `lore start` in one terminal, then open the Desktop. The gateway dashboard at `http://127.0.0.1:3207/ui` will show incoming requests from the Desktop. If the dashboard stays empty, `settings.json` wasn't picked up — apply the in-app env editor fallback above and restart the Desktop.

## Next steps

- [Architecture](../architecture/) — how temporal storage, distillation, and the gradient context manager fit together.
- [Configuration](../configuration/) — full reference for `.lore.json`.
- [Custom upstreams](./custom-upstreams/) — corporate proxies, LiteLLM, Cloudflare AI Gateway.
