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

If you'd rather start the gateway yourself and launch Codex directly — or if you're setting up the Codex Desktop app, which doesn't accept `-c` CLI overrides — run [`lore setup codex`](../setup/) once. It writes the right `~/.codex/config.toml` for both the CLI and the Desktop app, and supports `-r <url>` for remote gateways. See the [Setup command](../setup/) page for the full command reference.

## Custom upstream headers

The Codex plugin reads `LORE_UPSTREAM_EXTRA_HEADERS` from your environment and folds its values into Codex's `openai_provider_headers` TOML map. This is the path for corporate proxies, LiteLLM team-routing tokens, and Cloudflare AI Gateway. See the [custom upstreams guide](./custom-upstreams/) for full examples.

## Per-harness notes

- **Project identity is exposed as env vars.** The gateway sets `LORE_PROJECT` and `LORE_GIT_REMOTE` (when a git remote exists) so Codex can map them to `env_http_headers` if your `config.toml` is configured to.
- **Compaction is disabled.** Codex's `model_auto_compact_token_limit=999999999` override prevents the built-in compaction from destroying Lore's gradient context.

## Next steps

- [Setup command](../setup/) — `lore setup codex` for manual/Desktop configuration and remote gateways.
- [Architecture](../architecture/) — how temporal storage, distillation, and the gradient context manager fit together.
- [Configuration](../configuration/) — full reference for `.lore.json`.
- [Custom upstreams](./custom-upstreams/) — corporate proxies, LiteLLM, Cloudflare AI Gateway.
