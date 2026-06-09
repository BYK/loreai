---
title: Environment variables
description: Every LORE_* env var, grouped by subsystem, with the parsing rule and default value.
sidebar:
  order: 5
---

<!-- Auto-generated from packages/gateway/src/**/*.ts and packages/core/src/**/*.ts. Hand-edit the header above; the table below regenerates via pnpm generate:env-docs. -->

Every env var the gateway reads. Default values are extracted from the source (look for the `||` / `??` / `parseXxx(env.LORE_X, DEFAULT)` pattern at the first use site). The `Subsystem` column is the source file; click through to read the full JSDoc.

Env vars override `.lore.json` for the same setting. To override a `.lore.json` field, look for the corresponding `LORE_*` variable in this table — not all fields are env-var overridable; most budget, distillation, and search tuning fields require a config file change.

## CLI / `lore` command

| Variable | Default | Parser | Description |
|---|---|---|---|
| `LORE_BATCH_DISABLED` | — | — | _no description in source_ |
| `LORE_CONFIG_DIR` | — | — | Get the Lore config directory. Uses $LORE_CONFIG_DIR if set, otherwise ~/.lore |
| `LORE_GIT_REMOTE` | — | — | _no description in source_ |
| `LORE_HOSTED_MODE` | — | — | When true, disables hosted mode even for `lore start`. CLI: `--local` / `-l`. Env: `LORE_HOSTED_MODE=0`. |
| `LORE_INSTALL_DIR` | — | — | Determine the install directory for a curl-installed binary. Priority: 1. $LORE_INSTALL_DIR environment variable 2. ~/.local/bin (if exists AND in $PATH) 3. ~/bin (if exists AND in $PATH) 4. ~/.lore/bin (fallback) |
| `LORE_NO_UPDATE_CHECK` | — | — | _no description in source_ |
| `LORE_PROJECT` | — | — | Expose project path & git remote as env vars so Hermes can map them to custom headers if supported in the future.  The gateway resolves the project from system-prompt inference and cwd for now. |
| `LORE_REMOTE_GATEWAY` | — | — | _no description in source_ |
| `LORE_REMOTE_URL` | — | — | CLI remote helper — shared utilities for CLI commands that need to call the remote gateway REST API when `LORE_REMOTE_URL` is set. |
| `LORE_TARGET` | ``${process.platform}-${process.arch}`` | — | _no description in source_ |
| `LORE_UPSTREAM_EXTRA_HEADERS` | — | — | Forward LORE_UPSTREAM_EXTRA_HEADERS to Codex via the `openai_provider_headers` config key (TOML map of header name → value). Codex appends these to every outbound request to the OpenAI-compatible upstream, which now points at the Lore gateway. The gateway reads the same env var and re-injects them on the actual upstream call — this is a belt-and-suspenders pass-through so a user with a custom corporate proxy gets headers on both hops. |

## Gateway startup + routing

| Variable | Default | Parser | Description |
|---|---|---|---|
| `LORE_DEBUG` | — | `isTruthy` | Whether to log requests. Default: false. Env: LORE_DEBUG |
| `LORE_IDLE_TIMEOUT` | `parsePositiveInt(60)` | `parsePositiveInt` | _no description in source_ |
| `LORE_LISTEN_HOST` | — | `parseHosts` | Hosts to bind to. Default: ["127.0.0.1"]. Env: LORE_LISTEN_HOST (comma-separated for multiple addresses). CLI: --host (can be specified multiple times, or comma-separated). |
| `LORE_LISTEN_PORT` | `parsePort(DEFAULT_PORT)` | `parsePort` | Default port preference order when LORE_LISTEN_PORT is not set. - 3207: flip upside-down → 7=L, 0=O, 2=R, 3=E → LORE (calculator-word) - 5673: T9 phone keypad → 5=L, 6=O, 7=R, 3=E → LORE |
| `LORE_SESSION_EVICTION_TIMEOUT` | — | — | Session eviction timeout in seconds. Sessions idle beyond this are evicted from memory (state is preserved in DB). Default: 1800 (30 min). Set to 0 to disable eviction. Env: LORE_SESSION_EVICTION_TIMEOUT |
| `LORE_UPSTREAM_ANTHROPIC` | `"https://api.anthropic.com"` | — | Upstream Anthropic API URL. Default: "https://api.anthropic.com". Env: LORE_UPSTREAM_ANTHROPIC |
| `LORE_UPSTREAM_OPENAI` | `"https://api.openai.com"` | — | Upstream OpenAI API URL. Default: "https://api.openai.com". Env: LORE_UPSTREAM_OPENAI |
| `LORE_WORKER_API_KEY` | `undefined` | — | Standalone API key for background worker calls (distillation, curation, consolidation, etc.). When set, workers authenticate with this key instead of the session's client credential — enabling workers to use a different provider (e.g. MiniMax) than the session's Anthropic key. Env: LORE_WORKER_API_KEY |
| `LORE_WORKER_UPSTREAM` | — | — | Custom upstream URL for background worker calls. When set, all worker HTTP calls route to this URL instead of the default upstream URLs. Enables routing workers to a different provider (e.g. MiniMax's Anthropic-compatible endpoint) while sessions continue using Anthropic. Env: LORE_WORKER_UPSTREAM |

## Upstream + worker pipeline

| Variable | Default | Parser | Description |
|---|---|---|---|
| `LORE_DAILY_BUDGET` | — | — | Get the effective daily budget in USD. Resolution priority: 1. `LORE_DAILY_BUDGET` env var (override for automation / CI) 2. DB-persisted value from `kv_meta` (set via UI) 3. 0 (disabled) |
| `LORE_WORKER_MODEL` | — | — | Env var override — highest priority. Useful for global worker model configuration without per-project .lore.json (e.g. routing all workers to MiniMax). Format: "providerID/modelID" or just "modelID" (defaults to anthropic provider). |

## ..

| Variable | Default | Parser | Description |
|---|---|---|---|
| `LORE_DB_PATH` | — | — | _no description in source_ |

## How variables are evaluated

The gateway reads env vars once at startup (`loadConfig()` in `packages/gateway/src/config.ts`) and once at the boundary of each subsystem (worker model, cache warmer, cost tracker, etc.). Process-level changes after startup are not picked up — restart the gateway to apply.

Boolean env vars use the rule: `LORE_X=1` or `LORE_X=true` (case-insensitive) is truthy; anything else (including `LORE_X=0` or unset) is falsy. Numeric env vars use `parsePositiveInt` or `parseNonNegativeInt`; invalid values fall back to the default with a `console.error` warning.
