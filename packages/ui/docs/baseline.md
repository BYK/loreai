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

## After UI-02 (UI-02 branch, commit `3439476c`, 2026-09-18, same machine, Node v24.19.0)

Gateway bundle `packages/gateway/dist/index.cjs`: 18,125,556 bytes (+559,903,
+3.2 %). The SPA (`packages/ui/dist`, 619,783 bytes: `index.html`,
`favicon.svg`, one hashed JS and one hashed CSS file, two logo SVGs and eight
self-hosted woff2 font subsets — DM Sans / Playfair Display, the website's
font stack) is embedded in the bundle as `src/ui-assets.generated.ts`; the
legacy `ui.ts` (~4,000 lines of HTML templates) is gone, which is why the
delta is smaller than the asset size.

| Metric | n | min | p50 | p95 | max |
|---|---|---|---|---|---|
| Startup → `200 /health` (ms) | 5 | 1138.50 | 1143.72 | 1228.25 | 1228.25 |
| RSS after start (MB) | 5 | 355.63 | 356.09 | 359.82 | 359.82 |
| Proxy `POST /v1/messages` (ms) | 40 | 25.89 | 30.51 | 81.22 | 197.83 |
| `GET /health` (ms) | 40 | 0.44 | 0.58 | 10.62 | 119.01 |
| `GET /api/v1/projects` (ms) | 40 | 0.44 | 0.57 | 6.90 | 49.42 |

RSS after the latency load: 1213.6 MB.

### Before → after

| Metric (p50) | Before | After | Δ |
|---|---|---|---|
| Startup (ms) | 1297.44 | 1143.72 | −154 (−12 %, within run-to-run noise of a shared VM) |
| RSS after start (MB) | 361.77 | 356.09 | −5.7 (−1.6 %, run-to-run noise; the ~620 KB of embedded UI assets sit in the lazily imported `ui-static` module, so nothing is decoded until the first `/ui` request) |
| Proxy `POST /v1/messages` (ms) | 32.70 | 30.51 | −2.2 |
| `GET /health` (ms) | 0.86 | 0.58 | −0.28 |
| `GET /api/v1/projects` (ms) | 0.62 | 0.57 | −0.05 |

The UI is only loaded when `/ui` is requested (`ui-static.ts` is a lazy
`import()` in `server.ts`), so the proxy path pays nothing beyond the larger
bundle file. Nothing in the proxy pipeline changed in UI-02.
