---
title: Environment variables
description: Every LORE_* env var, grouped by subsystem, with the parsing rule and default value.
sidebar:
  order: 5
---

<!-- Auto-generated from packages/gateway/src/**/*.ts and packages/core/src/**/*.ts. Hand-edit the header above; the table below regenerates via pnpm generate:env-docs. -->

Every env var the gateway reads. Default values are extracted from the source (look for the `||` / `??` / `parseXxx(env.LORE_X, DEFAULT)` pattern at the first use site) and shown under the variable name when set. The parser used to coerce the raw string is also shown under the variable name when present.

Env vars override `.lore.json` for the same setting. To override a `.lore.json` field, look for the corresponding `LORE_*` variable in this table — not all fields are env-var overridable; most budget, distillation, and search tuning fields require a config file change.

## background-limiter

| Variable | Description |
|---|---|
| `LORE_BACKGROUND_CONCURRENCY` | Resolve the upper bound for background concurrency. `LORE_BACKGROUND_CONCURRENCY` is a hard ceiling override (escape hatch for large multi-tenant hosts); otherwise the built-in MAX applies. Clamped to a sane [1, 32]. |

## CLI / `lore` command

| Variable | Description |
|---|---|
| `LORE_CONFIG_DIR` | Get the Lore config directory. Uses $LORE_CONFIG_DIR if set, otherwise ~/.lore |
| `LORE_GIT_REMOTE` | Git remote URL (e.g. `git@github.com:org/repo.git`) of the project the spawned Codex CLI is operating in. Exported by the gateway so a user-defined `env_http_headers` in `~/.codex/config.toml` can map it to a custom header for upstream telemetry. Set only when `git remote get-url origin` returns a value; the gateway does not read this env var itself. |
| `LORE_HOSTED_MODE` | Hosted/remote mode — disables all filesystem operations that use client-controlled paths (git subprocess, .lore.json/.lore.md read/write, lat.md/ directory scan, file watchers). Env: LORE_HOSTED_MODE. |
| `LORE_INSTALL_DIR` | Determine the install directory for a curl-installed binary. Priority: 1. $LORE_INSTALL_DIR environment variable 2. ~/.local/bin (if exists AND in $PATH) 3. ~/bin (if exists AND in $PATH) 4. ~/.lore/bin (fallback) |
| `LORE_NO_BROWSER` | Heuristic: can we open a browser ON THIS machine that could reach our loopback callback? False for SSH sessions, headless Linux (no display), and CI — in those cases the user's browser is elsewhere, so we use the scan-the-QR / paste-the-code device flow instead. `LORE_NO_BROWSER=1` forces it off explicitly. |
| `LORE_NO_UPDATE_CHECK` | Check if update checking is disabled via environment variable. When set to `1`, the CLI does not phone home to GitHub for the latest released version and does not print "new version available" notifications. Use this in CI, air-gapped environments, or when you've pinned a version and don't want the upgrade hint. Env: `LORE_NO_UPDATE_CHECK=1`. |
| `LORE_PROJECT` | Expose project path & git remote as env vars so downstream agents can map them to custom headers if supported in the future. The gateway resolves the project from system-prompt inference and cwd for now. |
| `LORE_REMOTE_GATEWAY` | Remote/central gateway mode. When true, the gateway is serving agents running on OTHER machines, so its own `process.cwd()` has no relationship to any client's project. In this mode the gateway MUST NOT attribute path-less requests to its own cwd (doing so merges unrelated projects). Instead, requests that cannot resolve a confident project path are routed to a per-session synthetic "unattributed" bucket (`/__lore_unattributed__/<sessionID>`) that can later self-heal or be consolidated. Env: LORE_REMOTE_GATEWAY. Note: hosted mode (`LORE_HOSTED_MODE`) implies remote-gateway behavior — a hosted gateway never shares a filesystem with its clients. Auto-detection: when neither `LORE_REMOTE_GATEWAY` nor `LORE_HOSTED_MODE` is set, the gateway auto-enables remote-gateway mode if its bind address(es) include any non-loopback host. This catches the common case of running a long-lived gateway on a server (Tailscale, LAN IP, `0.0.0.0`, etc.) without requiring an explicit env var. |
| `LORE_REMOTE_URL` | CLI remote helper — shared utilities for CLI commands that need to call the remote gateway REST API when `LORE_REMOTE_URL` is set. |
| `LORE_SHUTDOWN_TIMEOUT_MS` | Hard cap (ms) on how long graceful shutdown may run before the gateway force-exits, so Ctrl+C can never hang. Env: `LORE_SHUTDOWN_TIMEOUT_MS` (default 4000). Invalid / non-positive / non-finite values fall back to the default — the timeout can never be disabled. |
| `LORE_TARGET`<br>**Default:** ``${process.platform}-${process.arch}`` | Platform target string used to locate the vendored embedding model directory when running the SEA (single executable) binary. Format: `${platform}-${arch}` (e.g. `darwin-arm64`, `linux-x64`). Defaults to the current host. Override this to pre-warm the embedding model cache on a machine of one platform and run the binary on another (CI cross-builds, OCI images). Env: `LORE_TARGET=<platform>-<arch>`. |
| `LORE_UPSTREAM_EXTRA_HEADERS` | Forward LORE_UPSTREAM_EXTRA_HEADERS to Codex via the `openai_provider_headers` config key (TOML map of header name → value). Codex appends these to every outbound request to the OpenAI-compatible upstream, which now points at the Lore gateway. The gateway reads the same env var and re-injects them on the actual upstream call — this is a belt-and-suspenders pass-through so a user with a custom corporate proxy gets headers on both hops. |

## Gateway startup + routing

| Variable | Description |
|---|---|
| `LORE_BEDROCK_REGION` | _no description in source_ |
| `LORE_DEBUG`<br>**Parser:** `isTruthy` | Whether to log requests. Default: false. Env: LORE_DEBUG |
| `LORE_IDLE_TIMEOUT`<br>**Default:** `parsePositiveInt(60)`<br>**Parser:** `parsePositiveInt` | Idle timeout in seconds. After this many seconds with no active request, the gateway stops the per-session in-memory cache warmer and distillation loop to free resources. State is preserved in the DB so a new request resumes from where the session left off. Default: 60. Env: `LORE_IDLE_TIMEOUT`. |
| `LORE_LISTEN_HOST`<br>**Parser:** `parseHosts` | Hosts to bind to. Default: ["127.0.0.1"]. Env: LORE_LISTEN_HOST (comma-separated for multiple addresses). CLI: --host (can be specified multiple times, or comma-separated). |
| `LORE_LISTEN_PORT`<br>**Default:** `parsePort(DEFAULT_PORT)`<br>**Parser:** `parsePort` | Default port preference order when LORE_LISTEN_PORT is not set. - 3207: flip upside-down → 7=L, 0=O, 2=R, 3=E → LORE (calculator-word) - 5673: T9 phone keypad → 5=L, 6=O, 7=R, 3=E → LORE |
| `LORE_SESSION_EVICTION_TIMEOUT` | Session eviction timeout in seconds. Sessions idle beyond this are evicted from memory (state is preserved in DB). Default: 1800 (30 min). Set to 0 to disable eviction. Env: LORE_SESSION_EVICTION_TIMEOUT |
| `LORE_UPSTREAM_ANTHROPIC`<br>**Default:** `"https://api.anthropic.com"` | Upstream Anthropic API URL. Default: "https://api.anthropic.com". Env: LORE_UPSTREAM_ANTHROPIC |
| `LORE_UPSTREAM_OPENAI`<br>**Default:** `"https://api.openai.com"` | Upstream OpenAI API URL. Default: "https://api.openai.com". Env: LORE_UPSTREAM_OPENAI |
| `LORE_VERTEX_PROJECT`<br>**Default:** `env.GOOGLE_CLOUD_PROJECT ?? ""` | Vertex config — standard GCP ADC chain + optional LORE overrides |
| `LORE_VERTEX_REGION` | _no description in source_ |
| `LORE_WORKER_API_KEY`<br>**Default:** `undefined` | Standalone API key for background worker calls (distillation, curation, consolidation, etc.). When set, workers authenticate with this key instead of the session's client credential — enabling workers to use a different provider (e.g. MiniMax) than the session's Anthropic key. Env: LORE_WORKER_API_KEY |
| `LORE_WORKER_UPSTREAM` | Custom upstream URL for background worker calls. When set, all worker HTTP calls route to this URL instead of the default upstream URLs. Enables routing workers to a different provider (e.g. MiniMax's Anthropic-compatible endpoint) while sessions continue using Anthropic. Env: LORE_WORKER_UPSTREAM |

## Upstream + worker pipeline

| Variable | Description |
|---|---|
| `LORE_DAILY_BUDGET` | Get the effective daily budget in USD. Resolution priority: 1. `LORE_DAILY_BUDGET` env var (override for automation / CI) 2. DB-persisted value from `kv_meta` (set via UI) 3. 0 (disabled) |
| `LORE_MAX_RETRIES` | Number of times a worker upstream call retries a transient failure before falling back to the caller's own handling (default: 8). Override with the LORE_MAX_RETRIES env var. |
| `LORE_WORKER_MODEL` | Env var override — highest priority. Useful for global worker model configuration without per-project .lore.json (e.g. routing all workers to MiniMax). Format: "providerID/modelID" or just "modelID" (defaults to anthropic provider). |

## Pipeline + idle work

| Variable | Description |
|---|---|
| `LORE_BATCH_DISABLED` | Disables the batch-queue wrapper for non-urgent worker calls (distillation, curation, embedding). With batching on, the gateway groups these calls and submits them via the Anthropic Message Batches API for ~50% cost savings. Set `LORE_BATCH_DISABLED=1` to bypass batching and dispatch each call immediately (useful for low-latency debugging or when the upstream rejects batch submissions). Env: `LORE_BATCH_DISABLED=1`. |

## Memory engine (`@loreai/core`)

| Variable | Description |
|---|---|
| `LORE_DB_PATH` | Resolved path of the SQLite database file. Reads `LORE_DB_PATH` first; falls back to `${dataDir}/lore.db` (typically `~/.local/share/lore/lore.db`). The test preload (`packages/core/test/setup.ts`) sets `LORE_DB_PATH` to a temp directory so tests never touch the production DB. Setting it to a non-existent path will create the file on first use. The gateway itself does not set this — it expects a stable location for the DB so the SQLite WAL and FTS5 indices persist across restarts. Env: `LORE_DB_PATH`. |
| `LORE_DISABLE_VEC` | LORE_DISABLE_VEC=1 forces the JS brute-force vector-search path. Useful as a production kill-switch if the native extension causes issues, and as a test seam for the JS fallback. Set before the first `db()` call — once attempted=true is sticky for the connection lifetime, the env var won't be re-read until resetVecState() runs (in close()). |
| `LORE_NO_DB_TRACING` | LORE_NO_DB_TRACING=1 returns the raw connection instead of the query-tracing Proxy (disables automatic per-query DB spans). |

## How variables are evaluated

The gateway reads env vars once at startup (`loadConfig()` in `packages/gateway/src/config.ts`) and once at the boundary of each subsystem (worker model, cache warmer, cost tracker, etc.). Process-level changes after startup are not picked up — restart the gateway to apply.

Boolean env vars use the rule: `LORE_X=1` or `LORE_X=true` (case-insensitive) is truthy; anything else (including `LORE_X=0` or unset) is falsy. Numeric env vars use `parsePositiveInt` or `parseNonNegativeInt`; invalid values fall back to the default with a `console.error` warning.
