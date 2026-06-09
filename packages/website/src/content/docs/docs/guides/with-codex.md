---
title: Codex with Lore
description: Set up OpenAI Codex to route through the Lore memory gateway, including the Codex Desktop app.
sidebar:
  order: 4
---

[Codex](https://github.com/openai/codex) is OpenAI's terminal-based AI coding agent. Lore's gateway is the recommended way to run Codex with persistent memory and gradient context management.

The Codex CLI is a Rust binary that does NOT read `OPENAI_BASE_URL` from the environment. Provider routing is done exclusively via `~/.codex/config.toml` or `-c` CLI overrides. The gateway uses `-c` overrides when launched via `lore run` so you do not have to edit the config file by hand.

## Install (CLI)

The hosted install script sets up Lore and Codex in one step:

```bash
curl -fsSL https://withlore.ai/install | bash
```

Then launch Codex through the gateway:

```bash
lore run
```

`lore run` starts the Lore gateway (if not already running) and launches Codex with the right `-c` overrides to route through it. The gateway auto-detects Codex on your `PATH`.

## What `lore run` does for Codex

It launches Codex with these CLI overrides:

```text
-c openai_base_url="http://127.0.0.1:3207/v1"
-c model_auto_compact_token_limit=999999999
```

- `openai_base_url` points Codex at the Lore gateway instead of OpenAI directly.
- `model_auto_compact_token_limit=999999999` disables Codex's auto-compaction, so Lore's gradient context manager and distillation pipeline can do their job.

Both overrides are per-invocation — they do not affect Codex's persisted `config.toml` or session scoping.

## Manual setup (CLI)

If you'd rather start the gateway yourself and launch Codex directly, edit `~/.codex/config.toml`:

```toml
[model]
auto_compact_token_limit = 999999999

[providers.openai]
base_url = "http://127.0.0.1:3207/v1"
```

Start the gateway and Codex in separate terminals:

```bash
# Terminal 1
lore start

# Terminal 2
codex
```

## Codex Desktop app

The Codex Desktop app does not accept `-c` CLI overrides at launch and has no obvious way to inject a custom `openai_base_url` through its UI. The recommended setup is to point the Desktop app at a `config.toml` that routes through the Lore gateway.

1. Start the Lore gateway in the background (via `lore start` or a system service).
2. Edit or create `~/.codex/config.toml` with the snippet above.
3. Launch the Codex Desktop app and verify the request log shows requests going to `127.0.0.1:3207` instead of `api.openai.com`.

If the Desktop app overwrites or ignores your `config.toml`, run the gateway under a system service manager (`systemd`, `launchd`, etc.) so the URL stays stable, and consider using a session-scoped override file at `~/.codex/sessions/<session-id>/config.toml` if the Desktop app supports per-session configs.

## Custom upstream headers

The Codex plugin reads `LORE_UPSTREAM_EXTRA_HEADERS` from your environment and folds its values into Codex's `openai_provider_headers` TOML map. This is the path for corporate proxies, LiteLLM team-routing tokens, and Cloudflare AI Gateway. See the [custom upstreams guide](./custom-upstreams/) for full examples.

## Per-harness notes

- **Project identity is exposed as env vars.** The gateway sets `LORE_PROJECT` and `LORE_GIT_REMOTE` (when a git remote exists) so Codex can map them to `env_http_headers` if your `config.toml` is configured to.
- **Compaction is disabled.** Codex's `model_auto_compact_token_limit=999999999` override prevents the built-in compaction from destroying Lore's gradient context.

## Next steps

- [Architecture](../architecture/) — how temporal storage, distillation, and the gradient context manager fit together.
- [Configuration](../configuration/) — full reference for `.lore.json`.
- [Custom upstreams](./custom-upstreams/) — corporate proxies, LiteLLM, Cloudflare AI Gateway.
