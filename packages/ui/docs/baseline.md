# Gateway baseline for the UI roadmap (UI-01 / UI-02)

Reproducible measurements of the gateway *before* the Solid UI existed and
*after* UI-02 wired the built SPA into the gateway bundle. The point is to prove
that shipping the memory browser does not regress gateway startup, resident
memory, or foreground proxy latency — the gateway's primary job.

## Script

`scripts/ui-baseline.mjs` (repository root). It:

1. Creates a throw-away data directory and points `XDG_DATA_HOME`,
   `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `LORE_DB_PATH` at it, so the real
   `~/.local/share/lore` is never touched. An isolated `.lore.json` disables
   embeddings; `LORE_BATCH_DISABLED=1` and `HF_HUB_OFFLINE=1` keep background
   work and model downloads out of the numbers.
2. Starts a local mock upstream that answers `POST /v1/messages` instantly and
   sets `LORE_UPSTREAM_ANTHROPIC` to it. The probe uses a model name outside the
   built-in routing table plus `x-lore-agent: coder` so the request is routed to
   that mock, never to a real provider.
3. For each of `--runs` (default 5): spawns `packages/gateway/dist/bin.cjs start
   --local` from the **npm bundle**, measures spawn → first `200 /health`
   (startup) and the child's RSS ~1 s later.
4. Against the last instance, after 5 warm-up requests, times `--requests`
   (default 40) sequential `POST /v1/messages` (foreground proxy latency),
   `GET /health` and `GET /api/v1/projects`, then samples RSS again.
5. Prints a Markdown table and, with `--json <file>`, writes the raw numbers.

```sh
pnpm --filter @loreai/gateway run bundle
node scripts/ui-baseline.mjs --runs 5 --requests 40 --json baseline.json
```

Numbers below are wall-clock on a shared cloud VM; compare p50s between rows
of the same table, not against other machines.

## Machine

| | |
|---|---|
| Platform | linux 6.8.0-1061-aws x64 |
| CPU | INTEL(R) XEON(R) PLATINUM 8559C ×8 |
| Memory | 31.34 GB |
| Node | v24.19.0 |
| pnpm | 10.28.0 |

## Before (clean `main`, commit `a4e6af5b`, 2026-09-18)

Gateway bundle `packages/gateway/dist/index.cjs`: 17,565,653 bytes. No UI assets
in the published output.

| Metric | n | min | p50 | p95 | max |
|---|---|---|---|---|---|
| Startup → `200 /health` (ms) | 5 | 1115.38 | 1297.44 | 1323.72 | 1323.72 |
| RSS after start (MB) | 5 | 361.64 | 361.77 | 361.88 | 361.88 |
| Proxy `POST /v1/messages` (ms) | 40 | 26.59 | 32.70 | 107.84 | 216.83 |
| `GET /health` (ms) | 40 | 0.49 | 0.86 | 18.68 | 19.51 |
| `GET /api/v1/projects` (ms) | 40 | 0.46 | 0.62 | 15.50 | 101.64 |

RSS after the latency load: 1186.3 MB (the proxy path lazily loads the
tokenizer and pipeline modules on first request).

## After UI-02

_Recorded in the UI-02 PR once the SPA is served by the gateway; same script,
same machine class, same flags._
