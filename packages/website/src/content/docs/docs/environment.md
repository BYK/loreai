---
title: Environment variables
description: Configure Lore startup, providers, memory, and operational behavior with environment variables.
sidebar:
  order: 5
---

<!-- Auto-generated from packages/gateway/src/**/*.ts and packages/core/src/**/*.ts. Hand-edit the header above; the table below regenerates via pnpm generate:env-docs. -->

Set environment variables in the shell or service that starts Lore, then restart the gateway. For everyday tasks, start with [data and costs](/docs/data-and-costs/) or [troubleshooting](/docs/troubleshooting/); use this page when you need a specific setting.

## Common tasks

| Task | Setting or guide |
|---|---|
| Opt out of production telemetry | Set `SENTRY_ENABLED=0` before startup; [full data boundary](/docs/installation-reference/#operational-telemetry) |
| Choose a background model | `LORE_WORKER_MODEL`; review provider/auth requirements below |
| Use a different data location | `LORE_DB_PATH`; point it at the database you intend to use |
| Connect to a different gateway | [Setup and remote gateway guidance](/docs/setup/) |
| Tune relevant knowledge | [Knowledge injection guide](/docs/guides/tune-knowledge-injection/) |

## Setting reference

Environment overrides are setting-specific. Not every `.lore.json` field has an environment equivalent; consult [configuration](/docs/configuration/) for file-based settings. Runtime-dependent defaults vary by platform or other configuration.

## Background request limits

| Variable | Description |
|---|---|
| `LORE_BACKGROUND_CONCURRENCY` | Resolve the upper bound for background concurrency. `LORE_BACKGROUND_CONCURRENCY` is a hard ceiling override (escape hatch for large multi-tenant hosts); otherwise the built-in MAX applies. Clamped to a sane [1, 32]. |

## Cache usage

| Variable | Description |
|---|---|
| `LORE_WARMUP_PROBE` | Env var `LORE_WARMUP_PROBE`: when set to `1`, enables the warmup cache-divergence diagnostic. It logs SHA comparisons of the cacheable segments (the stable head `system[0..1]`, tools, and the distilled prefix `messages[0..1]`) on real turns and warmups to tell an Anthropic-side cache eviction (segments match, `cacheRead=0`) apart from a warmup request-body divergence (segments differ). A debugging aid only; off by default, with zero cost when unset (callers skip all parsing/hashing). |

## Model providers and background work

| Variable | Description |
|---|---|
| `LORE_MAX_RETRIES` | Number of times a worker upstream call retries a transient failure before falling back to the caller's own handling (default: 8). Override with the LORE_MAX_RETRIES env var. |
| `LORE_WARMING_ENABLED` | Whether cache warming is enabled. Resolution priority (highest first): 1. `LORE_WARMING_ENABLED` env var — "0"/"false"/"off"/"no" disable, anything else enables (override for automation / CI). 2. DB-persisted KV override, set via the dashboard or `/lore:warm:on\|off` ("1" = on, "0" = off). Absent → fall through. 3. `cache.warming.enabled` from `.lore.json` (schema default: true). This makes the file-only config flag runtime-settable without a restart — mirroring the daily-budget toggle. The gate lives in `shouldWarm`, so warming can be turned off globally the moment it stops paying for itself. |

## Launching and managing Lore

| Variable | Description |
|---|---|
| `LORE_CONFIG_DIR` | Get the Lore config directory. Uses $LORE_CONFIG_DIR if set, otherwise ~/.lore |
| `LORE_DB_PATH` | Resolved path of the SQLite database file. Reads `LORE_DB_PATH` first; falls back to `${dataDir}/lore.db` (typically `~/.local/share/lore/lore.db`). The test preload (`packages/core/test/setup.ts`) sets `LORE_DB_PATH` to a temp directory so tests never touch the production DB. Setting it to a non-existent path will create the file on first use. The gateway itself does not set this — it expects a stable location for the DB so the SQLite WAL and FTS5 indices persist across restarts. Env: `LORE_DB_PATH`. |
| `LORE_GATEWAY_AUTH_TOKEN` | Optional gateway access credential for remote/hosted data-plane requests. It is sent as `x-lore-gateway-token` and remains separate from provider API keys/bearer tokens. When configured, it must be 32-256 visible ASCII characters without commas and clients must supply it. OpenCode/Pi consume LORE_REMOTE_URL + LORE_GATEWAY_AUTH_TOKEN in their adapters; Claude Code supports a per-request custom header directly. Never place it in a URL or CLI argument. Env: LORE_GATEWAY_AUTH_TOKEN. |
| `LORE_GIT_REMOTE` | Git remote URL (e.g. `git@github.com:org/repo.git`) of the project the spawned Codex CLI is operating in. Exported by the gateway so a user-defined `env_http_headers` in `~/.codex/config.toml` can map it to a custom header for upstream telemetry. Set only when `git remote get-url origin` returns a value; the gateway does not read this env var itself. |
| `LORE_HOSTED_MODE` | Hosted/remote mode — disables all filesystem operations that use client-controlled paths (git subprocess, .lore.json/.lore.md read/write, lat.md/ directory scan, file watchers). Env: LORE_HOSTED_MODE. |
| `LORE_INSTALL_DIR` | Determine the install directory for a curl-installed binary. Priority: 1. $LORE_INSTALL_DIR environment variable 2. ~/.local/bin (if exists AND in $PATH) 3. ~/bin (if exists AND in $PATH) 4. ~/.lore/bin (fallback) |
| `LORE_NO_BROWSER` | Heuristic: can we open a browser ON THIS machine that could reach our loopback callback? False for SSH sessions, headless Linux (no display), and CI — in those cases the user's browser is elsewhere, so we use the scan-the-QR / paste-the-code device flow instead. `LORE_NO_BROWSER=1` forces it off explicitly. |
| `LORE_NO_UPDATE_CHECK` | Check if update checking is disabled via environment variable. When set to `1`, the CLI does not phone home to GitHub for the latest released version and does not print "new version available" notifications. Use this in CI, air-gapped environments, or when you've pinned a version and don't want the upgrade hint. Env: `LORE_NO_UPDATE_CHECK=1`. |
| `LORE_PR_DESCRIPTION` | Env vars: LORE_PR_TITLE and LORE_PR_DESCRIPTION provide bounded, untrusted pull-request metadata for semantic lint prompts. |
| `LORE_PR_TITLE` | Env vars: LORE_PR_TITLE and LORE_PR_DESCRIPTION provide bounded, untrusted pull-request metadata for semantic lint prompts. |
| `LORE_PROJECT` | Expose project path & git remote as env vars so downstream agents can map them to custom headers if supported in the future. The gateway resolves the project from system-prompt inference and cwd for now. |
| `LORE_REMOTE_GATEWAY` | Remote/central gateway mode. When true, the gateway is serving agents running on OTHER machines, so its own `process.cwd()` has no relationship to any client's project. In this mode the gateway MUST NOT attribute path-less requests to its own cwd (doing so merges unrelated projects). Instead, requests that cannot resolve a confident project path are routed to a per-session synthetic "unattributed" bucket (`/__lore_unattributed__/<sessionID>`) that can later self-heal or be consolidated. Env: LORE_REMOTE_GATEWAY. Note: hosted mode (`LORE_HOSTED_MODE`) implies remote-gateway behavior — a hosted gateway never shares a filesystem with its clients. Auto-detection: when neither `LORE_REMOTE_GATEWAY` nor `LORE_HOSTED_MODE` is set, the gateway auto-enables remote-gateway mode if its bind address(es) include any non-loopback host. This catches the common case of running a long-lived gateway on a server (Tailscale, LAN IP, `0.0.0.0`, etc.) without requiring an explicit env var. `lore start` also defaults to remote-gateway mode. Use `lore start --local` when the gateway shares its filesystem with the agents it serves. For equivalent service configuration, set both `LORE_HOSTED_MODE=0` and `LORE_REMOTE_GATEWAY=0`. Local mode disables gateway access authentication, so use it only on loopback or a fully trusted isolated network; use remote/hosted mode for untrusted clients. |
| `LORE_REMOTE_URL` | CLI remote helper — shared utilities for CLI commands that need to call the remote gateway REST API when `LORE_REMOTE_URL` is set. |
| `LORE_TARGET`<br>**Default:** runtime-dependent | Platform target string used to locate the vendored embedding model directory when running the SEA (single executable) binary. Format: `${platform}-${arch}` (e.g. `darwin-arm64`, `linux-x64`). Defaults to the current host. Override this to pre-warm the embedding model cache on a machine of one platform and run the binary on another (CI cross-builds, OCI images). Env: `LORE_TARGET=<platform>-<arch>`. |
| `LORE_UPSTREAM_EXTRA_HEADERS`<br>**Default:** `""` | LORE_UPSTREAM_EXTRA_HEADERS forwards newline-separated `Name: Value` headers to Codex's HTTP provider and Lore's upstream requests. Explicit header values override persisted Codex headers. Codex excludes provider-authentication and gateway-access headers from this passthrough. |
| `LORE_WORKER_MODEL` | Parse the `LORE_WORKER_MODEL` env-var override into a `{providerID, modelID}`. Format: `"providerID/modelID"` (e.g. `openai/gpt-5.4-mini`) or a bare `"modelID"` which assumes the `anthropic` provider (the historical default). Returns `undefined` only for an unset/empty value. Single source of truth shared by the live worker-model selection (`getWorkerModel`) and standalone `lore import`, so the env override behaves identically in both paths. |

## Gateway startup and routing

| Variable | Description |
|---|---|
| `LORE_ALLOW_REMOTE_MANAGEMENT` | Allow non-loopback socket peers to access the dashboard and management API. Disabled by default. Env: LORE_ALLOW_REMOTE_MANAGEMENT. |
| `LORE_BEDROCK_REGION` | AWS Bedrock region. Selects both the bedrock-mantle Anthropic endpoint and the bedrock-runtime Converse/InvokeModel endpoint. Resolves from `LORE_BEDROCK_REGION` first, then falls back to `AWS_REGION` / `AWS_DEFAULT_REGION`, finally defaulting to `"us-east-1"`. Env: LORE_BEDROCK_REGION |
| `LORE_CALLER_UPSTREAM_ALLOWLIST` | Normalized HTTPS origins that remote/hosted clients may select with `X-Lore-Upstream-URL`. Empty by default, so caller-selected upstreams are denied unless the gateway administrator explicitly allows their origins. Local gateways do not consult this list. Env: LORE_CALLER_UPSTREAM_ALLOWLIST (comma-separated origins). |
| `LORE_DEBUG` | Whether to log requests. Default: false. Env: LORE_DEBUG |
| `LORE_EXPOSE_PROVIDER_DIAGNOSTICS` | Allow fixed provider-frame validation rules in internal error logs. Enabled by default; set LORE_EXPOSE_PROVIDER_DIAGNOSTICS to false or 0 to disable. Never includes provider content. |
| `LORE_IDLE_TIMEOUT`<br>**Default:** `60` | Idle timeout in seconds. After this many seconds with no active request, the gateway stops the per-session in-memory cache warmer and distillation loop to free resources. State is preserved in the DB so a new request resumes from where the session left off. Default: 60. Env: `LORE_IDLE_TIMEOUT`. |
| `LORE_LISTEN_HOST` | Hosts to bind to. Default: ["127.0.0.1"]. Env: LORE_LISTEN_HOST (comma-separated for multiple addresses). CLI: --host (can be specified multiple times, or comma-separated). |
| `LORE_LISTEN_PORT`<br>**Default:** runtime-dependent | Default port preference order when LORE_LISTEN_PORT is not set. - 3207: flip upside-down → 7=L, 0=O, 2=R, 3=E → LORE (calculator-word) - 5673: T9 phone keypad → 5=L, 6=O, 7=R, 3=E → LORE |
| `LORE_SESSION_EVICTION_TIMEOUT` | Session eviction timeout in seconds. Sessions idle beyond this are evicted from memory (state is preserved in DB). Default: 1800 (30 min). Pending tool calls retain state for at least 1 hour after the latest request or completed response (or this timeout, if longer). Active requests, response finalizers, and queued/running session work prevent eviction. Set to 0 to disable eviction. Env: LORE_SESSION_EVICTION_TIMEOUT |
| `LORE_UPSTREAM_ANTHROPIC`<br>**Default:** `"https://api.anthropic.com"` | Upstream Anthropic API URL. Default: "https://api.anthropic.com". Env: LORE_UPSTREAM_ANTHROPIC |
| `LORE_UPSTREAM_OPENAI`<br>**Default:** `"https://api.openai.com"` | Upstream OpenAI API URL. Default: "https://api.openai.com". Env: LORE_UPSTREAM_OPENAI |
| `LORE_VERTEX_PROJECT`<br>**Default:** runtime-dependent | Vertex config — standard GCP ADC chain + optional LORE overrides |
| `LORE_VERTEX_REGION` | No usage guidance is currently published for this setting. Keep the default unless an integration guide or maintainer directs otherwise. |
| `LORE_WORKER_API_KEY`<br>**Default:** not set | Standalone API key for background worker calls (distillation, curation, consolidation, etc.). When set, workers authenticate with this key instead of the session's client credential — enabling workers to use a different provider (e.g. MiniMax) than the session's Anthropic key. Env: LORE_WORKER_API_KEY |
| `LORE_WORKER_UPSTREAM` | Custom upstream URL for background worker calls. When set, all worker HTTP calls route to this URL instead of the default upstream URLs. Enables routing workers to a different provider (e.g. MiniMax's Anthropic-compatible endpoint) while sessions continue using Anthropic. Env: LORE_WORKER_UPSTREAM |

## Session processing and idle work

| Variable | Description |
|---|---|
| `LORE_BATCH_DISABLED` | Disables the batch-queue wrapper for non-urgent worker calls (distillation, curation, embedding). With batching on, the gateway groups these calls and submits them via the Anthropic Message Batches API for ~50% cost savings. Set `LORE_BATCH_DISABLED=1` to bypass batching and dispatch each call immediately (useful for low-latency debugging or when the upstream rejects batch submissions). Env: `LORE_BATCH_DISABLED=1`. |
| `LORE_MEMORY_PREPARATION_TIMEOUT_MS` | Override the normal-turn memory preparation budget at admission. Values from 1000–60000 ms are accepted; invalid values use .lore.json or the 8000 ms default. This budget ends before upstream generation. |

## Optional Model Tides uploads

| Variable | Description |
|---|---|
| `LORE_MODEL_TIDES_ENDPOINT` | Model Tides contribution client (#2026 PR3): a verbatim-behaviour port of scripts/contribute.mjs from BYK/model-tides (publishSnapshot, getOwnedReport, setSharing, reportVisibility, setAggregate, the delete/rotate requests and the upload-response validation + rollback, minus gist support). Endpoint: `process.env.LORE_MODEL_TIDES_ENDPOINT` (read only so tests can point at a local stub; deliberately not a config field) defaulting to https://modeltides.dev/api/contributions. Nothing uploads automatically — every call here is driven by an explicit confirmed UI request. |

## Runtime paths

| Variable | Description |
|---|---|
| `LORE_RUNTIME_ACL_ACTION` | No usage guidance is currently published for this setting. Keep the default unless an integration guide or maintainer directs otherwise. |
| `LORE_RUNTIME_ACL_KIND` | No usage guidance is currently published for this setting. Keep the default unless an integration guide or maintainer directs otherwise. |
| `LORE_RUNTIME_ACL_PATH` | No usage guidance is currently published for this setting. Keep the default unless an integration guide or maintainer directs otherwise. |

## Shutdown behavior

| Variable | Description |
|---|---|
| `LORE_SHUTDOWN_TIMEOUT_MS` | Environment variable: LORE_SHUTDOWN_TIMEOUT_MS overrides the single process-wide deadline shared by signal-driven and authenticated-control shutdown. Values are milliseconds and are clamped to the minimum safe deadline; invalid values use the default. |

## Streaming timeouts

| Variable | Description |
|---|---|
| `LORE_FOREGROUND_REQUEST_TIMEOUT_MS` | Whole-request foreground ceiling. Default: 900000ms; raised as needed to preserve 60000ms of headroom. Also set as `timeouts.foregroundRequestTimeoutMs` in `.lore.json`; this environment variable takes priority. |
| `LORE_FOREGROUND_SSE_INACTIVITY_MS` | How long the foreground relay tolerates upstream silence. Default: 600000ms. Also set as `timeouts.foregroundSseInactivityMs` in `.lore.json`; this environment variable takes priority. |
| `LORE_WORKER_REQUEST_TIMEOUT_MS` | Whole-request worker ceiling. Default: 900000ms; raised as needed to preserve 60000ms of headroom. Also set as `timeouts.workerRequestTimeoutMs` in `.lore.json`; this environment variable takes priority. |
| `LORE_WORKER_RESPONSE_INACTIVITY_MS` | How long a worker tolerates upstream silence. Default: 600000ms. Also set as `timeouts.workerResponseInactivityMs` in `.lore.json`; this environment variable takes priority. |

## Memory, recall, and context

| Variable | Description |
|---|---|
| `LORE_BACKFILL_CPU_DUTY` | Legacy temporal backfill duty setting (`LORE_BACKFILL_CPU_DUTY`) retained for configuration compatibility. Durable temporal admission no longer performs inference; the bounded scheduler controls embedding concurrency. |
| `LORE_DISABLE_VEC` | LORE_DISABLE_VEC=1 forces the JS brute-force vector-search path. Useful as a production kill-switch if the native extension causes issues, and as a test seam for the JS fallback. Set before the first `db()` call — once attempted=true is sticky for the connection lifetime, the env var won't be re-read until resetVecState() runs (in close()). |
| `LORE_DISABLE_VEC_WORKER` | LORE_DISABLE_VEC_WORKER=1 disables the off-thread read-worker pool. Required foreground memory reads then return retryable 503; optional reads degrade. This never enables an unbounded synchronous scan. |
| `LORE_EMBED_POOL_SIZE` | Number of local ONNX embedding worker threads (each loads its own ~137MB model). Distinct from workerPoolSize (the cheap DB-only vector pool) because an embedding worker's memory footprint is far larger. Omit to let lore size the pool from available memory (1 on constrained hosts, up to 2 when there's headroom). Override with LORE_EMBED_POOL_SIZE. |
| `LORE_NO_DB_TRACING` | LORE_NO_DB_TRACING=1 returns the raw connection instead of the query-tracing Proxy (disables automatic per-query DB spans). |
| `LORE_VEC_SEARCH_TIMEOUT_MS` | LORE_VEC_SEARCH_TIMEOUT_MS overrides the per-request vector-search timeout (a positive integer in milliseconds; invalid or non-positive values are ignored). Defaults to 10000 (10s). On timeout, recall degrades to an empty result instead of re-running the O(n) scan on the main thread. |

## How variables are evaluated

Restart Lore after changing its environment. A shell export does not change the environment of an already-running gateway. The startup diagnostics report invalid settings; interpretation and validation depend on the variable.

The reference is generated from documented source settings. Descriptions can contain advanced integration details; [open a docs issue](https://github.com/BYK/loreai/issues/new/choose) if a setting's effect is unclear.
