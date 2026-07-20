---
title: Configuration reference
description: Complete reference for every field in .lore.json, the env vars that override them, and the configuration file location.
sidebar:
  order: 4
---

<!-- Auto-generated from packages/core/src/config.ts. Hand-edit the header above; the reference below regenerates via pnpm generate:docs. Do not hand-edit field tables. -->

Lore's configuration has three layers, in order of precedence (highest first):

1. **Environment variables** (the LORE_* family — see the env-vars reference page) — process-level overrides, used by the gateway CLI and runtime.
2. The .lore.json file in the project root — per-project, JSONC-parseable, the primary config surface for memory behavior, budget, distillation, search, knowledge, and cross-project settings. This page documents it.
3. **Built-in defaults** — every field is optional; the Zod schema supplies safe defaults for anything you omit.

## Where .lore.json lives

The gateway looks for the .lore.json file in a single location:

- The **project root** — the directory the gateway was launched from, identified by the .lore.json file at its top level.

If no .lore.json is found, the gateway uses all defaults (every field is optional). In **hosted mode** (env var LORE_HOSTED_MODE=1), .lore.json is not read at all — a crafted file on a client-controlled path could alter gateway behavior, so the gateway uses the defaults to prevent tampering. Hosted-mode deployments should configure Lore through other means (admin-controlled env vars, fixed configuration baked into the deployment).

The file is **JSONC** (JSON with // line comments and slash-star block comments, plus trailing commas). Example:

```jsonc
{
  // Use a cheaper worker model for distillation
  "workerModel": { "providerID": "anthropic", "modelID": "claude-3-5-haiku-latest" },
  "curator": { "enabled": true, "maxEntries": 30 },
}
```

## How to override a single field

The cleanest way to override a single field is via env var if Lore reads it, or by adding the field to .lore.json in the project root. See the env-vars reference page for the env-var override path; everything else is here in the .lore.json reference below.


## Field reference

- [`model`](#model) — Default session model. When omitted, Lore uses the model from the first client request.
- [`workerModel`](#workerModel) — Background-worker model for distillation, curation, and query expansion. Same-provider invariant: workers MUST use the same provider as the session.
- [`budget`](#budget) — Context-window budget fractions. Sum plus LTM ≈ 1.0.
- [`idleResumeMinutes`](#idleResumeMinutes) — Minutes of inactivity after which Lore refreshes the byte-identity caches on resume (upstream prompt cache is cold). 5 = matches Anthropic's default-tier TTL. Set to 60 for extended (1h) cache tier. 0 to disable. Default: 5.
- [`distillation`](#distillation) — Distillation pipeline tuning (segment size, thresholds, tool-output truncation).
- [`knowledge`](#knowledge) — Long-term knowledge (curator, entity injection) controls.
- [`curator`](#curator) — Curator scheduling and consolidation thresholds.
- [`pruning`](#pruning) — Storage retention and emergency-pruning thresholds.
- [`search`](#search) — Recall and search pipeline tuning: FTS weights, query expansion, vector boost, embeddings, and output formatting.
- [`cache`](#cache) — Anthropic prompt cache TTL and speculative warming.
- [`workspaces`](#workspaces) — Workspace sub-project paths or globs (relative to `.lore.json`). Imported into the root knowledge base on startup. Supports literal paths and single-level globs (e.g. "packages/*").
- [`crossProject`](#crossProject) — Include cross-project knowledge in compaction summaries and auto-promote knowledge that recurs across 3+ projects. Default: true.
- [`agentsFile`](#agentsFile) — AGENTS.md/CLAUDE.md export/import configuration.
- [`loreFile`](#loreFile) — `.lore.md` export/import configuration.
- [`user`](#user) — User identity for the self-entity. Falls back to git config user.name / user.email if omitted.
- [`invariantCheck`](#invariantCheck) — `lore invariant-check` (semantic linter) tuning.

## `model`

Default session model. When omitted, Lore uses the model from the first client request.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `providerID` | string | — |  | Provider ID (e.g. 'anthropic', 'openai'). |
| `modelID` | string | — |  | Model identifier within the provider. |


## `workerModel`

Background-worker model for distillation, curation, and query expansion. Same-provider invariant: workers MUST use the same provider as the session.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `providerID` | string | — |  | Provider ID for the worker model. |
| `modelID` | string | — |  | Model identifier within the provider. |


## `budget`

Context-window budget fractions. Sum plus LTM ≈ 1.0.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `distilled` | number | `0.25` | min 0.05, max 0.5 | Fraction of usable context for distilled prefix. Default: 0.25. |
| `raw` | number | `0.4` | min 0.1, max 0.7 | Fraction of usable context for the recent raw window (un-distilled). Default: 0.4. |
| `output` | number | `0.25` | min 0.1, max 0.5 | Fraction of usable context reserved for model output. Default: 0.25. |
| `ltm` | number | `0.05` | min 0.02, max 0.3 | Max fraction of usable context reserved for context-bound LTM system-prompt injection. Default: 0.05 (5%). |
| `preferenceLtm` | number | `0.02` | min 0.01, max 0.1 | Fraction of usable context for stable LTM (preferences). Independent of `ltm`. Default: 0.02 (2%). |
| `targetCacheReadCostPerTurn` | number | `0.1` | min 0 | Per-turn cache-read cost target in dollars. Controls when layer 0 escalates to layer 1. Default: 0.10. Set to 0 to disable cost-aware capping. |
| `maxLayer0Tokens` | number | — | min 0 | Direct override for the layer-0 token cap. 0 = disabled (use full context). Default: undefined (use cost-aware auto). |
| `targetBustCost` | number | `1` | min 0 | @deprecated Ignored. Tier-based bust-vs-continue replaces static cap. |
| `maxContextTokens` | number | — | min 0 | @deprecated Ignored. Tier-based bust-vs-continue replaces static cap. |
| `qualityKnee` | number | — | min 0, max 1 | Manual override for the per-model quality knee (fill fraction where compression ramps). (0,1). Default: undefined (use the built-in per-model-family seed table, fallback 0.4). |


## `idleResumeMinutes`

Minutes of inactivity after which Lore refreshes the byte-identity caches on resume (upstream prompt cache is cold). 5 = matches Anthropic's default-tier TTL. Set to 60 for extended (1h) cache tier. 0 to disable. Default: 5.


## `distillation`

Distillation pipeline tuning (segment size, thresholds, tool-output truncation).

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `minMessages` | number | `5` | min 3 | Minimum number of messages before a segment is eligible for distillation. Default: 5. |
| `minSegmentTokens` | number | `64` | min 16 | Minimum tokens for a segment to be worth distilling. Default: 64. |
| `maxSegmentTokens` | number | `16384` | min 256 | Maximum tokens per distillation segment before splitting. Default: 16384. |
| `metaThreshold` | number | `20` | min 3 | Number of gen-0 segments that triggers meta-distillation. Default: 20. |
| `toolOutputMaxChars` | number | `4000` | min 0 | Max chars per tool output for distillation input. Set to 0 to disable truncation. Default: 4000. |
| `userBlobMaxChars` | number | `12000` | min 0 | Trigger threshold (chars) for embedding-based user-blob reduction. Set to 0 to disable. Default: 12000. |
| `userBlobKeepChars` | number | `6000` | min 0 | Chars kept after reducing an oversized user blob. Default: 6000. |
| `userBlobMaxSegments` | number | `48` | min 1 | Max blob segments embedded during user-blob reduction. Default: 48. |
| `userBlobHeadChars` | number | `1500` | min 0 | Chars of the leading user-prose prefix always kept during blob reduction. Set to 0 to disable. Default: 1500. |
| `recentSegmentsToKeep` | number | `5` | min 0 | Number of most-recent gen-0 segments to keep un-archived when meta-distillation fires. Default: 5. |


## `knowledge`

Long-term knowledge (curator, entity injection) controls.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `enabled` | boolean | `true` |  | Enable long-term knowledge storage and system-prompt injection. When false, the curator is disabled but recall and context management remain active. Default: true. |
| `maxEntityInject` | number | `30` | min 0 | Max entities to inject into the agent system prompt. Set to 0 to disable. Default: 30. |
| `autoToolFailureGotchas` | boolean | `false` |  | Auto-create gotcha entries from recurring tool failures. Default false (noisy; can churn the LTM cache). |
| `outcomeReward` | boolean | `true` |  | Adjust knowledge confidence by within-session verifier (test/build/typecheck/lint) outcomes. Default: true. |
| `referenceValidation` | boolean | `true` |  | Lower confidence on entries whose file:line / command references no longer resolve against the repo. Unverifiable refs never penalize. Default: true. |
| `contextSources` | array<enum> | `["distillation"]` |  | Fold relevance-ranked distillation/temporal memory into the context-bound injection so facts are passively present (no recall tool needed). Default: ["distillation"]; add "temporal" for raw messages; [] = off. |
| `minRelevance` | number | `0.35` | min 0, max 1 | Minimum cosine similarity for a vector-only knowledge match to be surfaced into a session. FTS keyword matches bypass it. 0 disables. Default: 0.35. |


## `curator`

Curator scheduling and consolidation thresholds.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `enabled` | boolean | `true` |  | Enable the curator (knowledge extraction from conversation). Default: true. |
| `onIdle` | boolean | `true` |  | Run the curator on session idle (in addition to turn-based). Default: true. |
| `inFlight` | boolean | `false` |  | Run the curator mid-conversation (turn-based), not just on idle. Default: false. WARNING: only enable on free-write / non-caching providers (e.g. MiniMax). On cache-sensitive providers (Anthropic), mid-session curation changes the knowledge base, which rewrites the context-bound LTM block (system[2]) and busts the prompt cache for the rest of a large conversation (a single change can re-write hundreds of thousands of cached tokens). Deferring curation to idle makes that rewrite free (the cache is cold then). Where cache writes are free this is harmless and yields fresher knowledge sooner. |
| `afterTurns` | number | `3` | min 1 | Minimum turns between curator runs. Default: 3. |
| `maxEntries` | number | `200` | min 10 | Per-project knowledge entry ceiling. A generous backstop, not a quality gate: injection is already token-budget-capped, and the confidence lifecycle (decay + reinforcement) governs what stays. When exceeded, the lowest-value entries are evicted. Default: 200. |
| `contextTokenBudget` | number | `20000` | min 2000 | Token budget for the existing-entries context sent to the curator each run. Bounds curator LLM cost so it stops scaling with stored entry count; a generous safety ceiling that only trims pathological sets (cross-project entries are always kept). Default: 20000. |


## `pruning`

Storage retention and emergency-pruning thresholds.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `retention` | number | `120` | min 1 | Days to keep distilled temporal messages before pruning. Default: 120. |
| `maxStorage` | number | `1024` | min 50 | Max total temporal_messages storage in MB before emergency pruning. Default: 1024 (1 GB). |


## `search`

Recall and search pipeline tuning: FTS weights, query expansion, vector boost, embeddings, and output formatting.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `ftsWeights` | object | `{"title":6,"content":2,"category":3}` |  | BM25 column weights for knowledge FTS5 [title, content, category]. |
| `recallLimit` | number | `10` | min 1, max 50 | Max results per source in recall tool before fusion. Default: 10. |
| `queryExpansion` | boolean | `true` |  | Enable LLM-based query expansion (2-3 alternative phrasings) for the recall tool. Guarded by a 3s timeout. Default: true. |
| `queryExpansionMaxTerms` | number | `8` | min 2, max 20 | Max query terms (after stopword removal) for LLM expansion. Longer queries skip expansion. Default: 8. |
| `vectorBoostWeight` | number | `1.5` | min 1, max 5 | RRF weight multiplier for vector search lists (when query has enough terms). Set to 1.0 to disable. Default: 1.5. |
| `vectorBoostMinTerms` | number | `2` | min 1, max 10 | Minimum meaningful query terms (after stopword removal) to activate vector boost. Default: 2. |
| `graphExpansion` | boolean | `true` |  | Enable entity-graph fan-in (linked knowledge + 1-hop relation neighbors) for the recall tool. Default: true. |
| `graphBoostWeight` | number | `1` | min 0, max 5 | RRF weight multiplier for entity-graph fan-in lists. Set to 0 to neutralize. Default: 1.0. |
| `embeddings` | object | `{"enabled":true,"provider":"local","model":"nomic-ai/nomic-embed-text-v1.5","dimensions":768,"workerOffload":true,"workerPoolSize":2}` |  | Vector embedding search provider, model, and dimensions. |
| `recall` | object | `{"charBudget":12000,"relevanceFloor":0.15,"maxResults":15,"absoluteFloor":0}` |  | Recall output formatting and result-count limits. |

### `search.ftsWeights`

BM25 column weights for knowledge FTS5 [title, content, category].

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `title` | number | `6` | min 0 | BM25 weight for the entry title column. Default: 6.0. |
| `content` | number | `2` | min 0 | BM25 weight for the entry content column. Default: 2.0. |
| `category` | number | `3` | min 0 | BM25 weight for the entry category column. Default: 3.0. |

### `search.embeddings`

Vector embedding search provider, model, and dimensions.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `enabled` | boolean | `true` |  | Enable vector embedding search. Set to false to explicitly disable. Default: true. |
| `provider` | enum | `"local"` |  | Embedding provider. "local" (no API key, on-device), "voyage" (VOYAGE_API_KEY), "openai" (OPENAI_API_KEY). Default: "local". |
| `model` | string | `"nomic-ai/nomic-embed-text-v1.5"` |  | Model ID for the embedding provider. Default depends on provider. |
| `dimensions` | number | `768` | min 64, max 2048 | Embedding dimensions. Default: 768 (local) / 1024 (voyage) / 1536 (openai). Local Nomic v1.5 supports Matryoshka: 64, 128, 256, 512, 768. |
| `workerOffload` | boolean | `true` |  | Run vector searches on a read-worker pool off the main event loop. Kill switch (default true); set false to force the in-process path. |
| `workerPoolSize` | number | `2` | min 1, max 16 | Number of read-worker threads for off-thread vector search. Default: 2. |
| `embedPoolSize` | number | — | min 1, max 8 | Number of local embedding worker threads (each loads its own ~137MB model). Default: memory-gated (1–2). Override with LORE_EMBED_POOL_SIZE. |
| `backfillCpuDuty` | number | — | min 0.1, max 1 | Duty cycle (0.1–1.0) for the one-time temporal re-chunk backfill — the fraction of time it may spend embedding, sleeping the rest so it doesn't peg a core on weak hosts. 1.0 = full speed. Default: auto-scaled by CPU count. Override with LORE_BACKFILL_CPU_DUTY. |

### `search.recall`

Recall output formatting and result-count limits.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `charBudget` | number | `12000` | min 2000, max 20000 | Total character budget for recall output (~3K tokens at 12000 chars). Default: 12000. |
| `relevanceFloor` | number | `0.15` | min 0, max 1 | Minimum RRF score (relative to top) to keep. Set to 0 to disable. Default: 0.15. |
| `maxResults` | number | `15` | min 3, max 30 | Max results to show in recall output. Default: 15. |
| `absoluteFloor` | number | `0` | min 0 | Absolute RRF score floor; drops weak matches even via the keep-3 backfill. Default: 0 (disabled). |


## `cache`

Anthropic prompt cache TTL and speculative warming.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `conversationTTL` | enum | `"auto"` |  | Conversation cache breakpoint TTL. "5m" (Anthropic standard), "1h" (extended tier, 2× write cost), "auto" (auto-upgrade based on cold-cache rate). Default: "auto". |
| `warming` | object | `{"enabled":true}` |  | Speculative cache warming (keepalive requests before TTL expiry). |

### `cache.warming`

Speculative cache warming (keepalive requests before TTL expiry).

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `enabled` | boolean | `true` |  | Enable cache warming. Default: true. |
| `minReturnProbability` | number | — | min 0, max 1 | Override return probability threshold below which warming is skipped. Default: auto-derived from cost ratio. |


## `workspaces`

Workspace sub-project paths or globs (relative to `.lore.json`). Imported into the root knowledge base on startup. Supports literal paths and single-level globs (e.g. "packages/*").


## `crossProject`

Include cross-project knowledge in compaction summaries and auto-promote knowledge that recurs across 3+ projects. Default: true.


## `agentsFile`

AGENTS.md/CLAUDE.md export/import configuration.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `enabled` | boolean | `true` |  | Enable AGENTS.md export/import behaviour. Set to false to disable. Default: true. |
| `path` | string | `"auto"` |  | Path to the agents file, relative to the project root, or 'auto' (default) to write CLAUDE.md for Claude Code sessions and AGENTS.md otherwise. Set an explicit path (e.g. 'AGENTS.md' or 'CLAUDE.md') to override. |


## `loreFile`

`.lore.md` export/import configuration.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `enabled` | boolean | `true` |  | Set to false to disable `.lore.md` export/import. When disabled, `.lore.md` is not written, startup skips the `.lore.md` import branch, the recall tool omits the .lore.md commit reminder, and the file watcher ignores `.lore.md`. Knowledge stays in the database and is still injected into the system prompt via LTM. Pair with `agentsFile.enabled=true` to keep sharing knowledge via an inline section in AGENTS.md. Default: true. |


## `user`

User identity for the self-entity. Falls back to git config user.name / user.email if omitted.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `name` | string | — |  | Display name. Overrides git config user.name. |
| `email` | string | — |  | Email address. Overrides git config user.email. |
| `aliases` | array<{ type, value }> | `[]` |  | Additional aliases for the self entity. |
| `metadata` | Record<string, unknown> | — |  | Metadata for the self entity (description, role, notes, etc.). |


## `invariantCheck`

`lore invariant-check` (semantic linter) tuning.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `effort` | enum | `"off"` |  | Reasoning effort for the invariant-check judge (off\|low\|medium\|high\|xhigh). Trades cost for depth on reasoning-capable models. Default: off. Override per-run with --effort. |

