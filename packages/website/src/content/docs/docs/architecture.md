---
title: Architecture
description: How Lore's three-tier memory, gradient context manager, and cost-aware context management fit together.
sidebar:
  order: 2
---

Lore treats context management and memory as one pipeline. The same gradient engine that decides what to put in the prompt also decides when to distill, when to compress, and when to bust the cache — balancing detail preservation against cost on every turn.

## Where Lore fits in the stack

Lore is a **transparent HTTP proxy** that sits between a coding agent and its upstream LLM provider. Every supported agent — Claude Code, Codex, OpenCode, Pi, or Hermes — already speaks one of the standard LLM HTTP APIs (Anthropic's `/v1/messages`, OpenAI's `/v1/chat/completions` and `/v1/responses`, Codex's `/v1/codex/responses`). Lore redirects those requests to its own gateway, where the conversation is parsed, persisted, and transformed before being forwarded to the real upstream. The agent never knows it's there.

This position is deliberate. It means Lore is **agent-agnostic by construction** — any new agent that uses one of those HTTP APIs gets the full memory pipeline for free, with no per-agent SDK. It also means every conversation is captured exactly once, at the only place where it exists as structured LLM traffic: the request itself.

```mermaid
flowchart TD
    User([Developer]) --> Agent["Coding Agent<br/>Claude Code · Codex · OpenCode · Pi · Hermes"]

    Agent -->|"LLM API request"| Adapter{How Lore gets the request}

    Adapter -->|"Plugin + fetch interceptor"| P1["@loreai/opencode<br/>@loreai/pi"]
    Adapter -->|"Env var / CLI flag"| P2["ANTHROPIC_BASE_URL<br/>OPENAI_BASE_URL · codex -c<br/>gateway/src/cli/agents.ts"]

    P1 --> Gateway
    P2 --> Gateway

    subgraph Lore["Lore Gateway — sits in the LLM data path"]
        direction TB
        Gateway["HTTP proxy · :3207<br/>/v1/messages · /v1/chat/completions<br/>/v1/responses · /v1/codex/responses"]
        Gateway --> Parse["Protocol parser"]
        Parse --> Engine["Memory engine<br/>Tier 1 · Tier 2 · Tier 3 · Gradient"]
        Engine --> Transform["Provider-agnostic transformer<br/>gradient.transform"]
    end

    Transform -->|"Lore-shaped request"| Upstream["Upstream LLM provider<br/>Anthropic · OpenAI · vLLM · Ollama"]
    Upstream -->|"Response"| Transform

    Engine -. "idle 30s · in-flight" .-> SQLite[("SQLite + FTS5<br/>~/.local/share/lore/lore.db")]

    classDef lore fill:#c4ddc7,stroke:#1a3320,stroke-width:2px,color:#1a3320
    classDef agent fill:#f7f2e8,stroke:#5a8f63,color:#1a3320
    classDef ext fill:#ececec,stroke:#888,color:#333
    class Gateway,Parse,Engine,Transform,SQLite lore
    class Agent,User,Adapter,P1,P2 agent
    class Upstream ext
```

The supported agents reach the proxy through one of three mechanisms:

- **OpenCode and Pi** ship dedicated plugins (`@loreai/opencode`, `@loreai/pi`) that install a fetch interceptor and pin each provider's `baseURL` to the local gateway.
- **Claude Code, Codex, and Hermes** are auto-detected by `lore run` (`gateway/src/cli/agents.ts`), which sets the right env var (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) or CLI flag (`codex -c openai_base_url=...`) for that agent's SDK.
- **Anything else** that reads `baseURL` from environment can be pointed at the gateway manually.

## How context and knowledge flow through Lore

Once a request lands in the gateway, two flows kick off in parallel: a **request path** that runs on every LLM call and shapes the prompt, and a **knowledge path** that runs on an idle tick (every 30s) and consolidates the conversation into long-term memory. The diagram below shows both. Solid arrows are synchronous within a single request; dotted arrows are async, decoupled from any specific turn.

```mermaid
flowchart TB
    subgraph Sources["Sources"]
        S1["LLM traffic from agent"]
        S2[".lore.md / AGENTS.md<br/>startup + file watcher"]
        S3["lore import CLI<br/>7 providers, one-time history"]
    end

    subgraph Ingress["Ingress"]
        I1["Protocol parser<br/>Anthropic / OpenAI / Responses / Codex"]
    end

    subgraph T1["Tier 1 — Temporal storage"]
        TT["temporal.store"]
        DB1[("temporal_messages<br/>+ FTS5")]
    end

    subgraph Realtime["Real-time request path"]
        G0["L0 passthrough"]
        G1["L1 distilled prefix + raw tail"]
        G2["L2 strip old tool outputs"]
        G3["L3 strip all tool outputs"]
        G4["L4 emergency"]
        SP["3-block system prompt<br/>system 0/1/2 + cache_control"]
        RC["recall tool · 6 RRF sources"]
        UP["Upstream LLM call"]
        Resp["Response to agent"]
    end

    subgraph T2["Tier 2 — Distillation"]
        DR["distillation.run"]
        OB["LLM observer · gen-0"]
        DB2[("distillations gen-0<br/>archived")]
        MD["metaDistill"]
        DB3[("distillations gen-1+")]
    end

    subgraph T3["Tier 3 — Long-term knowledge"]
        CR["curator.run · LLM"]
        PE["pattern-extract · regex"]
        DB4[("knowledge + entities")]
        EX["exportLoreFile"]
        F4[".lore.md +<br/>AGENTS.md pointer"]
    end

    S1 --> I1
    S2 -. "startup / on edit" .-> DB4
    S3 -. "one-time" .-> DB4

    I1 --> TT
    TT --> DB1
    I1 --> G0
    G0 --> G1 --> G2 --> G3 --> G4
    G4 --> SP
    SP --> RC
    RC --> UP
    UP --> Resp

    DB1 -. "idle · in-flight" .-> DR
    DR --> OB
    OB --> DB2
    DB2 --> MD
    MD --> DB3
    DB2 -. "prefix for L1+" .-> G1

    DB1 -. "periodic" .-> CR
    OB -. "periodic" .-> CR
    CR --> DB4
    PE --> DB4
    DB4 --> EX
    EX --> F4
    DB4 -. "forSession · hybrid vector + FTS5" .-> SP

    classDef t1 fill:#c4ddc7,stroke:#1a3320,color:#1a3320
    classDef t2 fill:#8fba96,stroke:#1a3320,color:#1a3320
    classDef t3 fill:#5a8f63,stroke:#fff
    classDef rt fill:#f7f2e8,stroke:#5a8f63,color:#1a3320
    classDef src fill:#ececec,stroke:#888,color:#333
    class TT,DB1 t1
    class DR,OB,DB2,MD,DB3 t2
    class CR,PE,DB4,EX,F4 t3
    class G0,G1,G2,G3,G4,SP,RC,UP,Resp rt
    class S1,S2,S3,I1 src
```

The two paths converge at the upstream call: the request path assembles the prompt that the model actually sees (gradient-compressed messages + a 3-block system prompt with the most relevant knowledge entries + the recall tool), and the knowledge path quietly feeds the inputs that make that prompt useful in the first place. The sections below walk through each tier and each layer in detail.

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

You should not have to think about context management. The gradient engine handles layer escalation, the cost-aware cap keeps you in the cheap layer for as long as possible, distillation preserves the details that summaries lose, and the recall tool gives you a way out when none of the layers have what you need. The settings that *are* worth tuning (cost targets, distillation thresholds, embedding provider) are surfaced in the [configuration reference](/docs/configuration/).
