# Durable source frontier and bounded model window (#1710)

Measured 2026-09-08 on Linux, Node 24.19, candidate
`980896f942367cd7b9af05ff40572c6c82398960`, using the legacy full-rebuild path retained in the candidate
(base `ffe04ec6be874daae7105c285be5251b27eef0a7`). The full modes disable
checkpoint preparation; they do not execute a separate base checkout. Raw samples:
[source-frontier-1710.json](source-frontier-1710.json) and
[source-frontier-large-window-1710.json](source-frontier-large-window-1710.json).

## What changes

A successful response now commits a local source checkpoint in the same
savepoint as its temporal writes. A validated append-only request converts
only the suffix at its absolute source indexes, restores a bounded unresolved
raw window and lossless Responses provenance, resolves tools within that window,
and supplies gradient with the omitted token subtotal and calibration metadata.
Unchanged resolved token estimates are reused; an appended result refreshes
any retained call it completes. Existing post-response latest-user/assistant
storage and pre-v82 identity behavior remain intact.

This checkpoint records accepted normalized input. It is **not** a distillation
or historical-message ingestion watermark and never marks omitted messages as
stored, observed, or distilled. A failed response transaction rolls back both
its temporal writes and checkpoint publication; an interrupted request can
safely replay its suffix.

Generic clients still need a length-framed SHA-256 pass over the complete
normalized wire prefix to detect arbitrary earlier edits. HTTP decoding and
this validation remain O(wire bytes). Semantic object creation, per-message ID
hashing, provenance BPE, identity lookup, tool pairing and gradient input work
are suffix/window bounded on a hit. Client head/count headers are not trusted
as proof of unchanged history. Authenticated client revision hints and streaming
ingress are separate work; no OpenCode header fast path is introduced here.

## Measurement

The fixture contains 930 completed six-message agentic turns (5,580 messages),
with distinct read calls/results and no user transcript or network calls.
A smaller-budget case has 276,338 source tokens and a 1,952-token model window.
The large case has 1,094,736 source tokens and a 170,167-token model window,
matching the approximate active-window size in the report. Each mode runs five
times, alternating the order. All unchanged modes produce identical SHA-256
hashes of serialized model messages; both appended modes also match exactly.

`restart` closes/reopens SQLite and evicts gradient's in-memory session. It is
a durable rehydration test in the same process, not a whole-process startup
benchmark. `warm` retains the open database but uses the same evicted gradient
state for a fair output comparison. `append` adds a user message and assistant
tool call. Medians below include only semantic preparation and gradient;
combined medians are computed per sample, not by adding separate medians.

| Fixture | Mode | Preparation ms | Gradient ms | Combined ms | Active raw messages | Converted messages | SQL statements |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small model window | full | 55.47 | 56.52 | 124.33 | 5580 | 5580 | 21 |
| Small model window | warm | 12.80 | 2.84 | 16.45 | 259 | 0 | 12 |
| Small model window | restart | 19.00 | 2.79 | 22.15 | 259 | 0 | 12 |
| Small model window | full-append | 37.77 | 46.81 | 84.83 | 5582 | 5582 | 21 |
| Small model window | append | 22.06 | 2.51 | 24.44 | 261 | 2 | 12 |
| 170k model window | full | 54.12 | 167.08 | 230.10 | 5580 | 5580 | 21 |
| 170k model window | warm | 27.75 | 44.99 | 73.56 | 901 | 0 | 12 |
| 170k model window | restart | 33.96 | 42.41 | 74.85 | 901 | 0 | 12 |
| 170k model window | full-append | 48.29 | 145.58 | 192.59 | 5582 | 5582 | 21 |
| 170k model window | append | 26.59 | 48.76 | 74.83 | 903 | 2 | 12 |

The large-window unchanged/reopened paths take about 74–75 ms combined versus
230 ms for the already-optimized full rebuild (about 3.1×). The improvement
is the removal of repeated semantic history work; it is not another 10× claim
against current main. The original acute costs were addressed by
[batched temporal preparation](temporal-preparation-1712.md) and
[durable exact provenance counts](semantic-token-cache-1710.md), whose committed
measurements already exceed the original order-of-magnitude target. These
synthetic measurements cannot predict the reported machine's total latency.

Unchanged checkpoint requests convert and newly estimate **zero** messages;
the appended request converts and newly estimates **two**. The large checkpoint
retains 901 messages (903 after append) and occupies 136,192 compressed bytes;
the smaller one retains 259 messages and occupies 49,162 bytes. Total traced SQL
is 21 on the full path and 12 on the hit path, including gradient's fixed reads.
Historical placeholder identities are restored from the checkpoint; only new
suffix placeholders invoke batched resolution.

First population, checkpoint finish/compression/publication, request decoding,
LTM/embedding retrieval, and model inference are outside the timing table.
Initial population still rebuilds the full source. CPU/load and GC affect the
individual samples; raw observations include stage timings and process-wide
CPU/memory counters. No live-session speed or full-request latency is claimed.

Reproduce from the repository root:

```sh
LORE_FRONTIER_BENCHMARK=1 LORE_FRONTIER_REPORT=/tmp/frontier.json \
  pnpm exec vitest run packages/gateway/test/source-window-benchmark.test.ts
LORE_FRONTIER_BENCHMARK=1 LORE_FRONTIER_LARGE_WINDOW=1 \
  LORE_FRONTIER_REPORT=/tmp/frontier-large.json \
  pnpm exec vitest run packages/gateway/test/source-window-benchmark.test.ts
```

## Bounds and fallback

Schema v87 introduces the disposable, unsynced `source_windows` table. Limits
are 2,048 retained raw messages, 16 MB uncompressed JSON, 4 MB compressed data,
32 session rows, 4,096 cumulative prefix counts and a 64 KiB omitted-tool-ID
Bloom filter. Checkpoints contain private source text/provenance and inherit
the local database's access controls; they are never included in sync.

The old full path is retained for missing/damaged/version-mismatched state,
protocol changes, rewinds/compaction/earlier edits, uncertain omitted tool
boundaries, budget growth beyond the retained window, unavailable calibration
counts, uninterrupted tool chains, and full-source passthrough. Bloom false
positives only cost a full reconciliation. Both directions of old tool-ID reuse
are checked, so a late result or newly reused call cannot silently modify an
omitted message. Speculative gradient fallback restores session state and
preserves pending forced-layer requests before replaying the full source.

Publication requires a same-connection, same-tenant generation/revision lease
claimed under the temporal transaction's writer lock. External temporal source
edits invalidate the payload. Project/session deletion, project clear/merge,
amnesia and project/credential rebinding invalidate ownership; source-only
sessions are covered even before their first temporal row. Canonical paths
and tenant-scoped worktree aliases remain valid project bindings. No-store
requests bypass checkpoint persistence.

## Validation and diagnostics

Regression coverage includes 5,580-message warm/reopen suffix conversion,
real buffered and streamed pipeline resumes, exact full/window wire parity,
late and parallel tool results/errors, encrypted reasoning/opaque provenance,
legacy temporal IDs, history edits, corrupt payloads, version/protocol/rewind
fallback, transaction rollback/retry, competing completions, external writes,
delete/recreate, project clear/merge/rebind, amnesia, tenant isolation and bounds.
Review-found cumulative token and ownership defects were reproduced before
repair. Independent correctness and security reviews exercise mutation guards
and compare local full-suite failures to the base revision.

`source_validation` adds a bounded-label preparation span. Existing numeric
Sentry distributions and the serialized `semantic-preparation` log report
`source_checkpoint_hit`, fixed `source_fallback_*` reasons,
`source_total_messages`, `source_converted_messages`,
`source_estimated_messages`, `source_checkpoint_messages`,
`source_omitted_messages`, and `stored_id_resolutions` alongside stage latency.
The active message/part/tool counters consistently describe the restored window
plus suffix. `source_checkpoint_published` is emitted after response storage,
so it is a Sentry distribution rather than a field in the earlier pre-upstream
log. Telemetry includes no transcript, provenance, IDs, credentials or paths.
