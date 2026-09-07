# Temporal preparation benchmark — #1712

Synthetic Responses/Codex history normalized to exactly 5,580 messages, 11,158 Lore parts, 5,578 tool uses, 5,578 tool results and 2,789 placeholder-producing messages. Each tool turn contains two parallel calls/results, roughly 4 KiB of output, and synthetic encrypted reasoning provenance. No production content is included.

The mixed cohort contains legacy, current and restored rows; the restored cohort starts with all `source_id` values NULL. New-message behavior, error results, rollback and ownership boundaries are covered by regression tests.

## Reproduce

```sh
LORE_BENCHMARK=1 pnpm exec vitest run packages/gateway/test/semantic-preparation.test.ts \
  -t "reports before/after" --execArgv=--expose-gc
```

The committed generator is `packages/gateway/test/fixtures/semantic-history.ts`. Raw samples are in [temporal-preparation-1712.json](temporal-preparation-1712.json). Results below are medians of three alternating before/after samples on Node.js 24.19.0, Linux x64, in a shared development runner. GC is explicitly exposed for memory-lifetime measurements. Wall times vary with host load.

## Results

| Workload | Preparation before / after | Temporal-ID SQL before / after | Post-response before / after |
|---|---:|---:|---:|
| 20 messages, mixed | 1.75 / 2.12 ms | 9 / 1 | 2.43 / 1.24 ms |
| 5,580 messages, mixed | 2277.34 / 219.81 ms | 2,789 / 28 | 2284.01 / 4.20 ms |
| 5,580 messages, restored | 1226.26 / 193.29 ms | 2,789 / 28 | 1269.63 / 3.97 ms |

Large mixed-session preparation improved by **10.4×**. The short-session preparation overhead was **0.37 ms**, while its post-response work decreased.

| Large mixed-session stage | Before | After |
|---|---:|---:|
| Conversion wall time | 164.38 ms | 184.80 ms |
| Conversion CPU | 213.12 ms | 236.16 ms |
| Provenance construction | 1.53 ms | 1.99 ms |
| SQLite execution time | 2026.02 ms | 13.25 ms |
| Tool resolution wall time | 2115.91 ms | 10.81 ms |
| Preparation CPU | 2374.12 ms | 294.84 ms |
| Event-loop probe delay | 2277.28 ms | 219.72 ms |

Before, tool-resolution time includes scalar ID resolution. After, that work is measured separately: 28.29 ms in `stored_ids`, including derivation, batching and SQL; 0.14 ms captures the narrow user snapshot.

The benchmark measures semantic preparation up to a simulated dispatch boundary and temporal bookkeeping, excluding LTM selection, gradient, transport serialization and network latency. It does **not** reproduce or claim to eliminate the reported 74-second production stall. The actual pipeline additionally emits the full `turn_to_upstream` timing from the `turn:` log to the first `forwardToUpstream` invocation.

## Memory and compatibility

Both implementations still convert the full history before gradient; this change introduces no transcript frontier. The post-response snapshot contains one user message plus the original assistant index: **5,230 serialized bytes** on the large fixture, independent of historical length. It has no reference to either full request graph. After releasing conversion output, yielding, and collecting garbage, the mixed after samples retained a median **59 KiB** above baseline (including runtime bookkeeping). Transient preparation heap allocation was comparable; RSS deltas ranged **0.62–5.00 MiB** after versus **0.50–2.75 MiB** before and are allocator/load sensitive, so no RSS reduction is claimed.

Normal lookups use one set-based statement per 100 placeholders. Restored candidates are materialized through primary-key probes before owner/NULL filtering; a query-plan regression guards against scanning all restored rows per chunk. Genuinely ambiguous legacy/current identities use one additional chunked statement containing the unchanged scalar lookup, preserving SQLite's historical planner-dependent selection. That rare path retains scalar scan cost, though statement count remains bounded. Removing compatibility entirely would require a separate migration of durable references.

## Production telemetry

`lore.preparation.*` distributions and `lore.semantic.prepare` spans record conversion, provenance, snapshot capture, stored-ID resolution, in-memory tool resolution, semantic total and dispatch timing. Counts cover messages, parts, calls, results, placeholders and ID resolutions; additional metrics cover event-loop probe delay and RSS/heap deltas. Dimensions are limited to protocol, Codex/streaming booleans and fixed stage names. Transcript content, message IDs, paths, models, credentials and SQL are excluded. CPU deltas are process-wide and can include concurrent background activity.
