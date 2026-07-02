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
- **OpenCode without `lore run`** — `lore setup opencode` writes `~/.config/opencode/opencode.json` with the gateway URL and disables OpenCode's built-in auto-compaction. It also installs the `@loreai/opencode` plugin and registers it in the `plugin` array, which is what makes the integration worth having (transparent per-session routing, project-path injection, per-session cost rollups). Pass `--no-plugin` to skip the install (useful in CI, air-gapped networks, or when `npm` is not on PATH).
- **Claude Code without `lore run`** — `lore setup claude-code` writes `~/.claude/settings.json` with `env.ANTHROPIC_BASE_URL` and `env.DISABLE_AUTO_COMPACT`.
- **Pi without `lore run`** — `lore setup pi` writes `~/.pi/agent/models.json`, pointing every gateway-routable provider's `baseUrl` at the gateway (Anthropic-family providers at the root, OpenAI-family at `/v1`). Pi has no env-var base-URL override, so this file is the only way to route a standalone `pi` without the `@loreai/pi` extension. For richer, dynamic routing plus memory features, install the extension instead (add `npm:@loreai/pi@latest` to the `packages` array in `~/.pi/settings.json`, then run `pi install`).
- **Hermes Agent without `lore run`** — `lore setup hermes` writes `~/.hermes/.env` with `OPENAI_BASE_URL` (the gateway URL, including `/v1`) and `HERMES_INFERENCE_PROVIDER=custom`. Hermes loads that `.env` at launch (via python-dotenv), so a standalone `hermes` routes through the gateway — the persistent equivalent of what `lore run hermes` injects.
- **Remote gateway** — `lore setup <app> -r http://remote:3207` writes the config pointing at a non-default gateway URL, useful when the gateway runs on a different machine (Tailscale, LAN, a hosted deployment) and you want the local client to talk to it.

If you launch your agent through `lore run`, you do **not** need `lore setup` — `lore run` injects the right config (env vars or `-c` overrides) into the child process at launch. `lore setup <app>` is for the other case: launching the agent directly (a GUI/IDE app, or a standalone CLI) where a persistent config file is the only integration point. Each supported app reads provider config from its own file — Codex/Pi from a JSON/TOML config, Claude Code/Hermes from an env file, OpenCode from JSON plus a plugin — so `lore setup` writes the persistent config they need.

## Usage

```bash
lore setup                     # Auto-detect installed supported apps and configure them
lore setup codex               # Configure Codex explicitly
lore setup opencode            # Configure OpenCode explicitly
lore setup claude-code         # Configure Claude Code explicitly
lore setup pi                  # Configure Pi explicitly (~/.pi/agent/models.json)
lore setup hermes              # Configure Hermes Agent explicitly (~/.hermes/.env)
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
| `pi`         | `~/.pi/agent/models.json` (with `providers.<id>.baseUrl` for every gateway-routable provider) | Anthropic-family providers point at the gateway root; OpenAI-family at `/v1`. Deep-merges with existing config (preserves custom providers and models). Honors `PI_CODING_AGENT_DIR`. The `@loreai/pi` extension is the richer alternative (dynamic routing + memory features). |
| `hermes`     | `~/.hermes/.env` (with `OPENAI_BASE_URL` + `HERMES_INFERENCE_PROVIDER=custom`) | The base URL keeps its `/v1` suffix (Hermes speaks the OpenAI-compatible wire format). Upserts the two keys and preserves all other lines (credentials, comments). Honors `HERMES_HOME`. A named `model.provider` in `~/.hermes/config.yaml` takes precedence over these env vars. |

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
- **OpenCode** — `lore setup opencode` writes `provider.openai.options.baseURL` to `~/.config/opencode/opencode.json`. If you have a custom OpenAI provider configured (e.g. `provider.openrouter`), the helper only updates the built-in `openai` provider — your custom providers are preserved. The compaction setting is also disabled by default; you can re-enable it in the same file if you want. By default, `lore setup opencode` also installs the `@loreai/opencode` plugin (via `npm install -g @loreai/opencode`) and registers it in the `plugin` array of the same config file. The plugin provides transparent per-session routing, automatic project-path injection, and per-session cost rollups in the dashboard — features the config-file approach alone can't provide. Pass `--no-plugin` to skip the install (CI, air-gapped, no npm on PATH).
- **Claude Code** — `lore setup claude-code` writes `env.ANTHROPIC_BASE_URL` (without the `/v1` suffix) to `~/.claude/settings.json`. The Anthropic SDK appends `/v1/messages` itself, so the gateway URL must not have `/v1`. If you have a project-level `.claude/settings.local.json`, that file overrides the user-level one — re-run `lore setup` after editing the project-level file.
- **Pi** — `lore setup pi` writes `providers.<id>.baseUrl` for every gateway-routable provider to `~/.pi/agent/models.json` (honoring `PI_CODING_AGENT_DIR`). Pi splits by wire protocol: Anthropic-family providers (`anthropic`, `fireworks`, `minimax`, …) get the gateway root; OpenAI-family providers (`openai`, `openrouter`, `groq`, local runtimes, …) get `${root}/v1`. A bare `baseUrl` override routes Pi's built-in providers and is a harmless no-op for the rest, so your custom providers and models are preserved. Pi has no base-URL env var, so unlike Hermes there's no `lore run`-only shortcut — either run `lore setup pi` or install the `@loreai/pi` extension (add `npm:@loreai/pi@latest` to `~/.pi/settings.json`'s `packages` array and run `pi install`), which routes all providers dynamically and adds per-session memory features. `lore setup undo pi` restores the prior config.
- **Hermes Agent** — `lore setup hermes` upserts `OPENAI_BASE_URL` (with `/v1`) and `HERMES_INFERENCE_PROVIDER=custom` into `~/.hermes/.env` (honoring `HERMES_HOME`), which Hermes loads via python-dotenv at launch. All other lines — API keys, comments, unrelated vars — are preserved, and a `#`-commented backup block records prior values for `lore setup undo hermes`. One caveat: a named `model.provider` in `~/.hermes/config.yaml` takes precedence over these env vars (Hermes warns when it detects the mismatch), so if you pin a provider there, set `provider: custom` in that file too. `lore run hermes` injects the same pair per-launch without persisting anything.

## Next steps

- [Codex with Lore](/docs/guides/with-codex/) — full per-harness guide for Codex, including the Codex Desktop caveat and custom-upstream headers.
- [Custom upstreams](/docs/guides/custom-upstreams/) — corporate proxies, LiteLLM, Cloudflare AI Gateway. Pairs with `lore setup -r` for remote gateways.
- [Architecture](/docs/architecture/) — how temporal storage, distillation, and the gradient context manager fit together.
