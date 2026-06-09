---
title: Setup command
description: Use `lore setup` to configure an AI coding agent to route through the Lore memory gateway. The recommended path for Codex and Codex Desktop.
sidebar:
  order: 5
---

`lore setup [app]` configures a supported AI coding agent to route its requests through the Lore gateway. It writes the right config file (or, for agents that don't read env vars at runtime, the right `-c` override) so the agent's API calls land on the gateway instead of going to the upstream provider directly.

## When to use `lore setup`

- **Codex Desktop** — the Desktop app does not accept `-c` CLI overrides at launch and has no obvious way to inject a custom `openai_base_url` through its UI. `lore setup codex` writes `~/.codex/config.toml` once and the Desktop app picks it up on next launch. This is the **recommended** path for Codex Desktop.
- **Codex CLI without `lore run`** — if you'd rather start the gateway yourself and launch Codex directly (for example, in a long-running dev workflow where you don't want `lore run` to manage the gateway lifecycle), `lore setup codex` writes the same config.
- **OpenCode without `lore run`** — `lore setup opencode` writes `~/.config/opencode/opencode.json` with the gateway URL and disables OpenCode's built-in auto-compaction.
- **Claude Code without `lore run`** — `lore setup claude-code` writes `~/.claude/settings.json` with `env.ANTHROPIC_BASE_URL` and `env.DISABLE_AUTO_COMPACT`.
- **Remote gateway** — `lore setup <app> -r http://remote:3207` writes the config pointing at a non-default gateway URL, useful when the gateway runs on a different machine (Tailscale, LAN, a hosted deployment) and you want the local client to talk to it.

If you're using `lore run` with a CLI-based agent that reads env vars (Pi, Hermes Agent), you do **not** need `lore setup` — `lore run` injects the right env vars into the child process at launch. Codex, OpenCode, and Claude Code are the exceptions: each reads provider config from its own config file rather than env vars at launch. `lore setup <app>` writes the persistent config they need so you can launch them directly without going through `lore run`.

## Usage

```bash
lore setup                     # Auto-detect installed supported apps and configure them
lore setup codex               # Configure Codex explicitly
lore setup opencode            # Configure OpenCode explicitly
lore setup claude-code         # Configure Claude Code explicitly
lore setup codex -p 8080       # Configure Codex to talk to a gateway on a non-default port
lore setup codex -r http://remote:3207  # Configure Codex for a remote gateway
```

If no app is given, `lore setup` scans `$PATH` for supported apps and configures whichever ones it finds. If nothing matches, it prints the supported app list and exits with a non-zero status — it never modifies a config file unless it found a matching installed app. When you pass an explicit app name, `setup` proceeds even if the binary is missing on `$PATH` (prints a warning and writes the config anyway). This is intentional so you can pre-configure Codex on a workstation where the binary lives elsewhere, or write the config before installing the binary.

If the named app isn't installed (for example, `lore setup codex` on a machine without the Codex binary), the command prints a warning and proceeds with the configuration. The intent is to let you set up Codex on a workstation where the binary lives elsewhere, or to pre-configure before installing the binary.

## Supported apps

| App          | Config written                                                            | Notes                                                                                       |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `codex`      | `~/.codex/config.toml` (with `openai_base_url` + `model_auto_compact_token_limit`) | Required for Codex Desktop. Idempotent — re-running updates existing fields without losing other settings. |
| `opencode`   | `~/.config/opencode/opencode.json` (with `provider.openai.options.baseURL` + `compaction.auto: false`) | Sets the built-in `openai` provider's `baseURL` and disables OpenCode's auto-compaction. Deep-merges with existing config (preserves custom providers, themes, keybinds). |
| `claude-code`| `~/.claude/settings.json` (with `env.ANTHROPIC_BASE_URL` + `env.DISABLE_AUTO_COMPACT`) | The Anthropic base URL is written without the `/v1` suffix — Claude Code appends `/v1/messages` itself. Deep-merges with existing settings (preserves permissions, hooks, model overrides). |

`openai_base_url` is set to the gateway's `baseUrl`, normalized to end with `/v1` (required by Codex). The port defaults to `3207` (the first entry in `DEFAULT_PORTS`); override with `-p` or `-r`.

`model_auto_compact_token_limit = 999999999` disables Codex's built-in auto-compaction so Lore's gradient context manager and distillation pipeline can do their job. Re-running `lore setup` resets this value to `999999999` — any custom value you set is overwritten.

To remove the configuration and restore Codex's default behavior, delete the relevant lines from `~/.codex/config.toml` or run `git checkout -- ~/.codex/config.toml` if you keep the file under version control.

## Verifying the setup

After `lore setup codex`, launch the gateway in one terminal:

```bash
lore start
```

In a second terminal, run Codex (or launch the Codex Desktop app). In the gateway's request log you should see requests originating from `127.0.0.1` with `model` set to your configured Codex model. If you see requests going to `api.openai.com` instead, the `config.toml` write was overridden — check that no other tool (Codex's own first-run wizard, a system service, a different shell profile) is writing to the file after `lore setup` runs.

A quick check for override-by-another-tool: `stat -c '%y' ~/.codex/config.toml`. If the mtime updates after the next Codex Desktop launch and you didn't change anything, another tool is touching the file.

## Per-harness notes

- **Codex Desktop** — `lore setup codex` is the **only** way to route the Desktop app through Lore (the app does not honor `-c` CLI overrides at launch). Run it once, leave the gateway running via `lore start` (or a system service), and the Desktop app routes correctly. If the Desktop app overwrites or ignores your `config.toml`, run the gateway under a system service manager (`systemd`, `launchd`, etc.) so the URL stays stable. Check Codex's docs for a session-scoped override file at `~/.codex/sessions/<session-id>/config.toml` if your Codex version supports it.
- **Codex CLI** — `lore run codex` is simpler than `lore setup codex` because it manages the gateway lifecycle and passes `-c` overrides per-invocation (no persisted config). Use `lore setup` only when you want to launch Codex without `lore run`.
- **OpenCode** — `lore setup opencode` writes `provider.openai.options.baseURL` to `~/.config/opencode/opencode.json`. If you have a custom OpenAI provider configured (e.g. `provider.openrouter`), the helper only updates the built-in `openai` provider — your custom providers are preserved. The compaction setting is also disabled by default; you can re-enable it in the same file if you want. For transparent per-session routing, automatic project-path injection, and per-session cost rollups in the dashboard, also install the `@loreai/opencode` plugin (`npm install -g @loreai/opencode`) and add `"@loreai/opencode"` to the `plugin` array in `~/.config/opencode/opencode.json`.
- **Claude Code** — `lore setup claude-code` writes `env.ANTHROPIC_BASE_URL` (without the `/v1` suffix) to `~/.claude/settings.json`. The Anthropic SDK appends `/v1/messages` itself, so the gateway URL must not have `/v1`. If you have a project-level `.claude/settings.local.json`, that file overrides the user-level one — re-run `lore setup` after editing the project-level file.

## Next steps

- [Codex with Lore](./guides/with-codex/) — full per-harness guide for Codex, including the Codex Desktop caveat and custom-upstream headers.
- [Custom upstreams](./guides/custom-upstreams/) — corporate proxies, LiteLLM, Cloudflare AI Gateway. Pairs with `lore setup -r` for remote gateways.
- [Architecture](./architecture/) — how temporal storage, distillation, and the gradient context manager fit together.
