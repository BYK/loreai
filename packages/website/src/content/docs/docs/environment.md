ropic.com". Env: LORE_UPSTREAM_ANTHROPIC |
| `LORE_UPSTREAM_OPENAI`<br>**Default:** `"https://api.openai.com"` | Upstream OpenAI API URL. Default: "https://api.openai.com". Env: LORE_UPSTREAM_OPENAI |
| `LORE_VERTEX_PROJECT`<br>**Default:** `env.GOOGLE_CLOUD_PROJECT ?? ""` | Vertex config — standard GCP ADC chain + optional LORE overrides |
| `LORE_VERTEX_REGION` | _no description in source_ |
| `LORE_WORKER_API_KEY`<br>**Default:** `undefined` | Standalone API key for background worker calls (distillation, curation, consolidation, etc.). When set, workers authenticate with this key instead of the session's client credential — enabling workers to use a different provider (e.g. MiniMax) than the session's Anthropic key. Env: LORE_WORKER_API_KEY |
| `LORE_WORKER_UPSTREAM` | Custom upstream URL for background worker calls. When set, all worker HTTP calls route to this URL instead of the default upstream URLs. Enables routing workers to a different provider (e.g. MiniMax's Anthropic-compatible endpoint) while sessions continue using Anthropic. Env: LORE_WORKER_UPSTREAM |

## Pipeline + idle work

| Variable | Description |
|---|---|
| `LORE_BATCH_DISABLED` | Disables the batch-queue wrapper for non-urgent worker calls (distillation, curation, embedding). With batching on, the gateway groups these calls and submits them via the Anthropic Message Batches API for ~50% cost savings. Set `LORE_BATCH_DISABLED=1` to bypass batching and dispatch each call immediately (useful for low-latency debugging or when the upstream rejects batch submissions). Env: `LORE_BATCH_DISABLED=1`. |

## runtime-files

| Variable | Description |
|---|---|
| `LORE_RUNTIME_ACL_ACTION` | _no description in source_ |
| `LORE_RUNTIME_ACL_KIND` | _no description in source_ |
| `LORE_RUNTIME_ACL_PATH` | _no description in source_ |

## shutdown-deadline

| Variable | Description |
|---|---|
| `LORE_SHUTDOWN_TIMEOUT_MS` | Environment variable: LORE_SHUTDOWN_TIMEOUT_MS overrides the single process-wide deadline shared by signal-driven and authenticated-control shutdown. Values are milliseconds and are clamped to the minimum safe deadline; invalid values use the default. |

## sse-inactivity

| Variable | Description |
|---|---|
| `LORE_FOREGROUND_REQUEST_TIMEOUT_MS` | Whole-request foreground ceiling. Default: 900000ms; raised as needed to preserve 60000ms of headroom. Also set as `timeouts.foregroundRequestTimeoutMs` in `.lore.json`; this environment variable takes priority. |
| `LORE_FOREGROUND_SSE_INACTIVITY_MS` | How long the foreground relay tolerates upstream silence. Default: 600000ms. Also set as `timeouts.foregroundSseInactivityMs` in `.lore.json`; this environment variable takes priority. |
| `LORE_WORKER_REQUEST_TIMEOUT_MS` | Whole-request worker ceiling. Default: 900000ms; raised as needed to preserve 60000ms of headroom. Also set as `timeouts.workerRequestTimeoutMs` in `.lore.json`; this environment variable takes priority. |
| `LORE_WORKER_RESPONSE_INACTIVITY_MS` | How long a worker tolerates upstream silence. Default: 600000ms. Also set as `timeouts.workerResponseInactivityMs` in `.lore.json`; this environment variable takes priority. |

## Memory engine (`@loreai/core`)

| Variable | Description |
|---|---|
| `LORE_BACKFILL_CPU_DUTY` | Legacy temporal backfill duty setting (`LORE_BACKFILL_CPU_DUTY`) retained for configuration compatibility. Durable temporal admission no longer performs inference; the bounded scheduler controls embedding concurrency. |
| `LORE_DISABLE_VEC` | LORE_DISABLE_VEC=1 forces the JS brute-force vector-search path. Useful as a production kill-switch if the native extension causes issues, and as a test seam for the JS fallback. Set before the first `db()` call — once attempted=true is sticky for the connection lifetime, the env var won't be re-read until resetVecState() runs (in close()). |
| `LORE_DISABLE_VEC_WORKER` | Kill switch: force the in-process vector-search path, disabling the off-thread read-worker pool. Default-on escape hatch, not opt-in. |
| `LORE_EMBED_POOL_SIZE` | Number of local ONNX embedding worker threads (each loads its own ~137MB model). Distinct from workerPoolSize (the cheap DB-only vector pool) because an embedding worker's memory footprint is far larger. Omit to let lore size the pool from available memory (1 on constrained hosts, up to 2 when there's headroom). Override with LORE_EMBED_POOL_SIZE. |
| `LORE_NO_DB_TRACING` | LORE_NO_DB_TRACING=1 returns the raw connection instead of the query-tracing Proxy (disables automatic per-query DB spans). |
| `LORE_VEC_SEARCH_TIMEOUT_MS` | LORE_VEC_SEARCH_TIMEOUT_MS overrides the per-request vector-search timeout (a positive integer in milliseconds; invalid or non-positive values are ignored). Defaults to 10000 (10s). On timeout, recall degrades to an empty result instead of re-running the O(n) scan on the main thread. |

## How variables are evaluated

The gateway reads env vars once at startup (`loadConfig()` in `packages/gateway/src/config.ts`) and once at the boundary of each subsystem (worker model, cache warmer, cost tracker, etc.). Process-level changes after startup are not picked up — restart the gateway to apply.

Boolean env vars use the rule: `LORE_X=1` or `LORE_X=true` (case-insensitive) is truthy; anything else (including `LORE_X=0` or unset) is falsy. Numeric env vars use `parsePositiveInt` or `parseNonNegativeInt`; invalid values fall back to the default with a `console.error` warning.
