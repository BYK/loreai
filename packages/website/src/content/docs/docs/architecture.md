---
title: Architecture
description: How Lore's three-tier memory, gradient context manager, and cost-aware context management fit together.
sidebar:
  order: 2
---

Lore treats context management and memory as one pipeline. The same gradient engine that decides what to put in the prompt also decides when to distill, when to compress, and when to bust the cache — balancing detail preservation against cost on every turn.

## Three-tier memory

### Tier 1 — Temporal storage

Every message is stored locally in SQLite with full-text search. This creates a searchable raw history that the recall tool can query when distilled context is not enough. Temporal storage is the ground truth — distillations and long-term knowledge are *derived* from it, never the other way around.

### Tier 2 — Distillation

Conversation segments are distilled into observation logs by an LLM observer. Distillations preserve the operational details that summaries lose: file paths, error messages, exact decisions, command output. They are timestamped, append-only, and consolidated by a second-pass meta-distillation when the gen-0 count crosses a threshold (default 20). Older distillations are still searchable via recall; only the in-context prefix is consolidated.

### Tier 3 — Long-term knowledge

Durable project facts — decisions, patterns, preferences, gotchas — are curated into long-term memory. The curator is an LLM call that runs on idle or after a configurable number of turns. Curated knowledge can be exported to `.lore.md` and reviewed in pull requests, so team knowledge moves with the code, not in a private database.

## Gradient context manager

The gradient context manager is what makes Lore different from a summarization wrapper. It is a four-layer system that decides — on **every turn** — how much of each tier to include in the next request, balancing detail preservation against prompt-cache cost.

| Layer | Contents | When used |
|---|---|---|
| **0** | Full raw window (no distillation, no compression) | Best quality. Default for sessions under the cost-aware cap. |
| **1** | Distilled prefix + recent raw window | When the raw window no longer fits. The cached distilled prefix is the cache-write anchor — appending a new raw message at the front is cheap. |
| **2** | Distilled prefix + raw window with old tool outputs stripped | When the distilled prefix plus full raw still overflows. Tool outputs from old turns are replaced with compact annotations preserving line count, error signals, and file paths. The last 2 turns are always protected from stripping. |
| **3** | Distilled prefix + raw window with all tool outputs stripped + only the 5 most-recent gen-0 distillations retained | Emergency compression. The 5 most recent gen-0 segments retain full detail in the prefix; older distillations are consolidated by the meta-distillation pass. |

The escalation between layers is automatic. The 0→1 boundary is driven by **cost-aware context management** (see below); the 1→2 and 2→3 boundaries are driven by token-fit. There is also a per-session `forceMinLayer` floor, persisted to SQLite, that survives process restarts — when the upstream API returns "prompt is too long", the error handler sets it to the layer that fit, and the next turn starts at that layer.

## Cost-aware context management

Lore's pricing is built around prompt-cache economics. A typical session spends most of its time at layer 0 (full passthrough) where the marginal cost of adding a message is the cache-read cost — roughly an order of magnitude cheaper than cache-write. Lore is designed to keep you in layer 0 for as long as it makes economic sense to do so.

### The cost-aware layer-0 cap

Layer 0 (full-raw passthrough) is the cheapest layer to *use* — adding a message costs only the cache-read price for the message's tokens, ~10× cheaper than a cache write. But the layer-0 prompt itself is the *whole conversation*, so every turn pays cache-read for that full window. As sessions grow, the per-turn cache-read cost grows linearly. A 200K-token prompt at Claude Sonnet's cache-read price ($3/Mtok) costs $0.60 per turn to re-read; a 600K-token prompt costs $1.80 per turn. At 100 turns, that's $60-$180 of cache reads on a single session — most of the model's full-context cost.

The layer-0 cap is the answer. Instead of "use the full context because it's there", Lore asks: "for a given per-turn budget, how many tokens of layer-0 context fit?" The cap is derived from your model and your `budget.targetCacheReadCostPerTurn` setting (default `$0.10`):

```
maxLayer0Tokens = max(target / model.cost.cache.read, 40K)
```

So a Claude Sonnet session with `cache.read = $3/Mtok` and the default target gets a 33K-token cap, while a cheaper model with `cache.read = $0.30/Mtok` gets a 333K cap. **The floor at 40K is a safety net**: a free-write or near-zero-cost provider would otherwise produce an absurdly large or even negative cap. 40K is enough to fit a representative code-editing session comfortably and small enough that the worst-case per-turn read cost stays bounded.

The default of `$0.10` per turn is calibrated to a typical developer session: ~100 turns/day × $0.10 = $10 in cache reads, sitting comfortably under most pro-tier daily budgets. **Lower the target** (say to $0.05) and the cap drops proportionally — sessions compress earlier, layer 1/2/3 kick in sooner, and total spend decreases. **Raise it** (to $0.30 or $0.50) and the cap grows — sessions stay in layer 0 longer, but you pay more in cache reads. Set the cap to $0 to disable cost-aware capping entirely (the session then uses the model's full context at layer 0). Set `budget.maxLayer0Tokens` directly to override the formula and pin a specific cap (useful for benchmarks, or for forcing layer 1 to engage earlier than the cost model would naturally dictate).

Two side branches tighten the cap further in specific situations:

- **Cold-cache first turn.** On the very first turn, the entire context is a cache WRITE at 12.5× the cache-read price. Lore applies a 70% multiplier to the cap on uncalibrated turns (no prior API data to confirm the cap) — paying a smaller cold-write is cheaper than writing the full context for a 1-turn session that may end right after.
- **Free-write or non-caching providers.** When the upstream reports zero cache-creation tokens for 3+ consecutive turns (free-write cache, MiniMax passive caching, or no caching at all), Lore caps layer 0 at 65% of the model's max input — there's no expensive cache write to avoid, so it compresses earlier to leave headroom for tool-heavy turns that follow.

### Tier-based bust-vs-continue

At larger context sizes, the choice between "bust the cache" (compress and re-write, paying cache-write) and "keep growing" (pay cache-read for the new message) becomes a real economic decision. Lore makes this per-turn based on three model-quality tiers:

| Tier | Token range | Behavior |
|---|---|---|
| **1** | 0 – 200K | Best quality. No compression pressure. |
| **2** | 200K – 500K | Acceptable quality. Lore compares bust cost vs continue cost and only compresses when it makes economic sense. |
| **3** | 500K – model limit | Degraded quality. Compression is more aggressive but still gated by the same economic check. |

The per-turn math:

```
bustCost    = compressedSize × cacheWriteCostPerToken
continueCost = currentSize   × cacheReadCostPerToken
compress when bustCost < continueCost × threshold
```

If 5+ consecutive turns bust the cache, Lore stops trying to compress and just keeps growing — something structural is causing the busts, and forced compression would just add cost on top of churn. The threshold is per-tier, calibrated so that compression fires in the same scenarios where the user would manually choose it.

### Per-turn usage signal

Lore records the actual cache-hit / cache-creation / cache-read token counts from each upstream response into a rolling window. This calibration closes the loop on the cost estimates: if the model is returning higher cache-read costs than the static table predicts, the layer-0 cap drops to compensate. Sessions self-tune to the actual model-pricing regime, not the published one.

### Cost tracker

The cost tracker watches the session against an optional `LORE_DAILY_BUDGET` (USD) cap. When the session is projected to exceed the cap, Lore does two things:

1. **Compresses earlier** — forces layer 2 at smaller context sizes, trading prompt detail for per-turn spend.
2. **Injects invisible proxy-level sleeps** to slow the agent's request rate. The throttle delay is computed from the current spend velocity vs the budget, with the curve `MAX_THROTTLE_DELAY × pressure² × tanh(overshoot / 3)`. A session burning twice its target rate gets a squared penalty; one burning at 3× the target saturates to the max delay. The delay is also capped to keep the next request *inside* the cache TTL window (delaying past TTL would bust the cache and undo the savings).

A second independent throttle signal comes from the **Anthropic OAuth quota** (`packages/gateway/src/quota.ts`): the gateway tracks the model's utilization against its 5-hour rolling entitlement and derives a quota pressure in `[0, 1]`. The final delay is the **max** of the budget-derived delay and the quota-derived delay, so either signal can engage throttling — and quota throttling works even when no USD budget is configured (a free user on a tight OAuth entitlement still gets throttled, not silently 429'd).

The dashboard surfaces a "budget pressure" signal with two counters: `throttle.events` (number of requests delayed) and `throttle.totalDelayMs` (total wait time imposed).

## Distillation pipeline

The distillation pipeline runs on idle, on a debounced timer. The first distillation is conservative (5 messages, 64 tokens minimum). As segments accumulate, gen-0 segments are emitted, and when the count crosses `metaThreshold` (default 20) a second-pass meta-distillation consolidates them. Meta-distillation keeps the 5 most recent gen-0 segments in the in-context prefix un-archived; older ones become a single higher-level summary that the recall tool can still search.

The distillation input is rendered from temporal messages with a configurable `toolOutputMaxChars` truncation (default 4000) — tool outputs longer than this are replaced with a compact annotation preserving line count, error signals, and file paths. This is what keeps distillation input from blowing up on noisy tool runs.

## Recall tool

The recall tool is the escape hatch when neither the in-context prefix nor the gradient layer has the answer. It runs a hybrid search over temporal messages, distillations, and the knowledge base, fusing:

- **BM25 keyword search** over FTS5 indices, with per-column weights configurable in `search.ftsWeights` (default: title 6, content 2, category 3).
- **Vector similarity search** using `@huggingface/transformers` + `nomic-embed-text-v1.5` (768-dim INT8 quantized, on-device by default). Hosted providers (`voyage`, `openai`) are an explicit opt-in via `search.embeddings.provider` in `.lore.json` — there is no automatic fallback from local to remote. If the local model fails to load (for example, on Linux/x64 with CUDA 13 where `onnxruntime-node` is broken), recall degrades to FTS-only with a one-time `log.info` notification.
- **LLM-based query expansion** generates 2-3 alternative phrasings of the query before search, guarded by a 3-second timeout.

Results are fused with reciprocal rank fusion (RRF) and re-ranked. A query-expansion-aware boost is applied to vector results when the query has enough terms (≥2 after stopword removal) — single-term queries stay on BM25 because that's where it wins.

## What this means in practice

You should not have to think about context management. The gradient engine handles layer escalation, the cost-aware cap keeps you in the cheap layer for as long as possible, distillation preserves the details that summaries lose, and the recall tool gives you a way out when none of the layers have what you need. The settings that *are* worth tuning (cost targets, distillation thresholds, embedding provider) are surfaced in the [configuration reference](./configuration/).
