# Exact provenance token counts on long resumed sessions

Measured 2026-09-07 on Linux x64, Node 24, from base
`4f92eaafab5c463127f3de8e9f42d8f47f2bcd9f`. Raw observations are in
[`semantic-token-cache-1710.json`](semantic-token-cache-1710.json).

## Problem and scope

The reported successive warm turns spent 83.2 and 83.7 seconds before the
`ltm-budget` log, despite only three additional normalized messages. The
earlier #1712 benchmark used repetitive synthetic ciphertext. Increasing the
fixture to distinct high-entropy reasoning exposes a much larger cost:
`gatewayMessagesToLore` tokenizes both full provenance and visible JSON for
every historical provenance-bearing message to compute `hiddenInputTokens`.
This is exact BPE work on encrypted data, repeated before LTM on every turn.

The fix reuses that exact scalar only when both full serialized inputs and
the tokenizer algorithm version match. It preserves the complete authoritative
message graph, tool pairing, wire provenance, source IDs, and fresh timestamps.
No source position or ingestion boundary is inferred from the cache.

This addresses the measured bottleneck within #1710; it does **not** complete
the larger durable source-frontier/active-window design. Full source hashing,
conversion, and gradient processing remain. Budget expansion, global dedup,
and tool boundaries need explicit source fallback before truncating the graph
can preserve current behavior. #1710 stays open. #1716 recall-depth completion
is separate.

## Reproduction

```sh
LORE_TOKEN_BENCHMARK=1 pnpm exec vitest run packages/gateway/test/semantic-token-benchmark.test.ts
```

The synthetic Responses fixture has 5,580 normalized messages, 2,789 tool-result
messages, two tool calls per turn, and 4,096 deterministic random bytes encoded
as base64 per reasoning item. It uses no user transcript, network, or model.
The five modes run serially in one process: no durable cache, first population,
same request again, database close/reopen, and append one assistant/tool-result
pair. Database reopen validates durable reuse; it is not a separate-process
startup measurement. The first four produce the same SHA-256 of serialized
upstream wire messages. Appending adds exactly one uncached provenance pair.

The initial run measured 107.0 seconds without durable reuse and 113.9 seconds
for first population. Warm preparation took 138 ms; after database reopen it
took 140 ms. Appending two messages took 180 ms with 2,790 hits and one miss.
The cache payload was 206,580 bytes. BPE accounted for 106.3 seconds of the
uncached run and zero on unchanged warm/reopened requests.

The final implementation, including lifecycle checks and nonblocking writes,
was measured again without other CPU-heavy validation running:

| Mode | Preparation | BPE | Hits / misses |
| --- | ---: | ---: | ---: |
| No durable cache | 102,376 ms | 101,740 ms | 0 / 2,790 |
| First population | 110,825 ms | 110,171 ms | 0 / 2,790 |
| Unchanged warm turn | 150 ms | 0 ms | 2,790 / 0 |
| Database close/reopen | 148 ms | 0 ms | 2,790 / 0 |
| Append two source messages | 196 ms | 35 ms | 2,790 / 1 |

These are individual synthetic observations, not a production latency promise
or a statistical latency distribution. Timings include semantic conversion,
snapshot/provenance handling, batched ID lookup and tool resolution; they
exclude HTTP parsing, LTM retrieval, gradient processing, and model inference.
The first use, eviction, changed content, or disabled persistence can still pay
the full tokenization cost. The live logs identify a matching phase but do not
prove this is their only remaining bottleneck.

## Persistence and validation

Schema v86 adds a local-only derived table scoped by tenant-resolved project
and session. It stores full-input SHA-256 keys and integer counts, with a
versioned/checksummed envelope. Limits are 8,192 entries per session, 1 MB per
payload and 64 retained session rows. Cache loss, invalid metadata, or a
version mismatch causes recomputation. No-store mode bypasses durable reads
and writes. Project clear removes even pre-response cache data; project merge
discards the source cache, and project/session deletion cascades it away.

Publication checks the same database connection, tenant, parent rows, local
write count and external commit version under the INSERT's writer lock.
Intervening writes conservatively discard the pending publication, including
delete/recreate. It runs before yielding, uses a zero busy timeout, restores
the caller's timeout, and never waits for background writers. Cache publication
does not mark source messages ingested or advance distillation boundaries.

Regressions cover actual unchanged/edited/rewound requests, persistence across
reopen, changed hidden bytes/signature/error/opaque tail, fresh timestamps,
tenant isolation, no-store, bounds, corruption, rollback, merge, deletion,
same-ID recreation from either connection, and v85 migration/table recovery.
The log-sink and repeated-tokenization tests failed before their fixes;
review-found lifecycle and contention regressions also failed before repair.

## Diagnostics (#1715)

`semantic-preparation` now explicitly serializes its numeric payload so the
real log sink preserves stage timings instead of printing `[object Object]`.
It includes wall/CPU stage values and numeric observations for cache hits,
misses, tokenized bytes, BPE milliseconds, and cache errors. These also emit as
`lore.preparation.provenance_tokens_*` distributions. Dimensions remain fixed;
no source text, ciphertext, paths, credentials, or session IDs are logged.
Cache publication is included in `semantic_total`; `turn_to_upstream` also
includes later preparation stages. Process-wide CPU and event-loop samples
can include unrelated work.
