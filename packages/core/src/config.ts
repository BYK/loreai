import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isHostedMode } from "./hosted";
import { warn } from "./log";

/**
 * Strip JS-style comments from a JSON string, enabling JSONC support for
 * `.lore.json`. Preserves `//` and `/* ... *​/` inside quoted strings.
 * Also removes trailing commas before `}` or `]`.
 */
function stripJsonComments(str: string): string {
  return str
    .replace(
      /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (_m, s) => s ?? "",
    )
    .replace(/,\s*([}\]])/g, "$1");
}

export const LoreConfig = z.object({
  model: z
    .object({
      providerID: z
        .string()
        .describe("Provider ID (e.g. 'anthropic', 'openai')."),
      modelID: z.string().describe("Model identifier within the provider."),
    })
    .optional()
    .describe(
      "Default session model. When omitted, Lore uses the model from the first client request.",
    ),
  /** Explicit worker model override. When set, all background workers (distillation,
   *  curation, query expansion) use this model instead of the session model or the
   *  auto-selected worker model. Bypasses dynamic worker model selection entirely. */
  workerModel: z
    .object({
      providerID: z.string().describe("Provider ID for the worker model."),
      modelID: z.string().describe("Model identifier within the provider."),
    })
    .optional()
    .describe(
      "Background-worker model for distillation, curation, and query expansion. Same-provider invariant: workers MUST use the same provider as the session.",
    ),
  budget: z
    .object({
      distilled: z
        .number()
        .min(0.05)
        .max(0.5)
        .default(0.25)
        .describe(
          "Fraction of usable context for distilled prefix. Default: 0.25.",
        ),
      raw: z
        .number()
        .min(0.1)
        .max(0.7)
        .default(0.4)
        .describe(
          "Fraction of usable context for the recent raw window (un-distilled). Default: 0.4.",
        ),
      output: z
        .number()
        .min(0.1)
        .max(0.5)
        .default(0.25)
        .describe(
          "Fraction of usable context reserved for model output. Default: 0.25.",
        ),
      /** Max fraction of usable context reserved for context-bound LTM system-prompt injection. Default: 0.05 (5%). */
      ltm: z
        .number()
        .min(0.02)
        .max(0.3)
        .default(0.05)
        .describe(
          "Max fraction of usable context reserved for context-bound LTM system-prompt injection. Default: 0.05 (5%).",
        ),
      /** Fraction of usable context for stable LTM (preferences). Independent of `ltm`. Default: 0.02 (2%). */
      preferenceLtm: z
        .number()
        .min(0.01)
        .max(0.1)
        .default(0.02)
        .describe(
          "Fraction of usable context for stable LTM (preferences). Independent of `ltm`. Default: 0.02 (2%).",
        ),
      /** Per-turn cache-read cost target in dollars. Controls when layer 0 (full
       *  passthrough) escalates to layer 1 (compressed). The cap is derived as:
       *  maxLayer0Tokens = max(target / model.cost.cache.read, 40K).
       *  Lower = cheaper but earlier compression. Default: 0.10. Set to 0 to
       *  disable cost-aware capping (use the model's full context). */
      targetCacheReadCostPerTurn: z
        .number()
        .min(0)
        .default(0.1)
        .describe(
          "Per-turn cache-read cost target in dollars. Controls when layer 0 escalates to layer 1. Default: 0.10. Set to 0 to disable cost-aware capping.",
        ),
      /** Direct override for the layer-0 token cap. When set, bypasses the
       *  cost-aware formula from targetCacheReadCostPerTurn. 0 = disabled
       *  (no cap, use full context). Default: undefined (use cost-aware auto). */
      maxLayer0Tokens: z
        .number()
        .min(0)
        .optional()
        .describe(
          "Direct override for the layer-0 token cap. 0 = disabled (use full context). Default: undefined (use cost-aware auto).",
        ),
      /** @deprecated Ignored. Tier-based bust-vs-continue replaces static cap. */
      targetBustCost: z
        .number()
        .min(0)
        .default(1.0)
        .optional()
        .describe(
          "@deprecated Ignored. Tier-based bust-vs-continue replaces static cap.",
        ),
      /** @deprecated Ignored. Tier-based bust-vs-continue replaces static cap. */
      maxContextTokens: z
        .number()
        .min(0)
        .optional()
        .describe(
          "@deprecated Ignored. Tier-based bust-vs-continue replaces static cap.",
        ),
    })
    .default({
      distilled: 0.25,
      raw: 0.4,
      output: 0.25,
      ltm: 0.05,
      preferenceLtm: 0.02,
      targetCacheReadCostPerTurn: 0.1,
    })
    .describe("Context-window budget fractions. Sum plus LTM ≈ 1.0."),
  /**
   * Cold-cache idle-resume handling.
   *
   * Anthropic's prompt cache evicts entries after ~5 min (default tier) /
   * ~1 hour (extended tier). When a session resumes after the eviction window,
   * Lore's byte-identity caches (distilled prefix, raw window pin, LTM block)
   * are providing no value because the underlying provider cache is already
   * cold. On detection, Lore refreshes those caches so the next turn can
   * produce a better-fitting window without paying a cache cost it would
   * otherwise be trying to preserve. Reasoning blocks are NOT touched —
   * Anthropic's April 23 postmortem identified dropping reasoning blocks as
   * the root cause of forgetfulness/repetition.
   *
   * `idleResumeMinutes` is the threshold in minutes. Default 5 — matches
   * Anthropic's default-tier prompt cache TTL. After 5 min of inactivity the
   * upstream cache is cold, so preserving byte-identity wastes cache-write cost
   * for no benefit. Refreshing the caches on resume produces a better-fitting
   * window at the same cold-write price. Users on Anthropic's extended-cache
   * tier (1 h TTL) should set this to 60 in `.lore.json`.
   * Set to 0 to disable the feature.
   */
  idleResumeMinutes: z
    .number()
    .min(0)
    .max(24 * 60)
    .default(5)
    .describe(
      "Minutes of inactivity after which Lore refreshes the byte-identity caches on resume (upstream prompt cache is cold). 5 = matches Anthropic's default-tier TTL. Set to 60 for extended (1h) cache tier. 0 to disable. Default: 5.",
    ),
  distillation: z
    .object({
      minMessages: z
        .number()
        .min(3)
        .default(5)
        .describe(
          "Minimum number of messages before a segment is eligible for distillation. Default: 5.",
        ),
      /** Minimum total tokens for a segment to be worth distilling.
       *  Segments below this are deferred (normal mode) or absorbed without
       *  an LLM call (force/urgent mode). Default: 64. */
      minSegmentTokens: z
        .number()
        .min(16)
        .default(64)
        .describe(
          "Minimum tokens for a segment to be worth distilling. Default: 64.",
        ),
      /** Maximum total tokens per distillation segment. Segments exceeding
       *  this are split at time-gap or token boundaries. Replaces the former
       *  message-count-based maxSegment. Default: 8192. */
      maxSegmentTokens: z
        .number()
        .min(256)
        .default(16384)
        .describe(
          "Maximum tokens per distillation segment before splitting. Default: 16384.",
        ),
      metaThreshold: z
        .number()
        .min(3)
        .default(20)
        .describe(
          "Number of gen-0 segments that triggers meta-distillation. Default: 20.",
        ),
      /** Max chars per tool output when rendering temporal messages for distillation input.
       *  Outputs longer than this are replaced with a compact annotation preserving line
       *  count, error signals, and file paths. Default: 4000. Raised from 2000 to preserve
       *  error messages and stack traces that exceed 2K chars. See #417. Set to 0 to disable. */
      toolOutputMaxChars: z
        .number()
        .min(0)
        .default(4_000)
        .describe(
          "Max chars per tool output for distillation input. Set to 0 to disable truncation. Default: 4000.",
        ),
      /** Number of most-recent gen-0 segments to keep un-archived when
       *  meta-distillation fires. These segments retain full detail in the
       *  context prefix while older segments are consolidated. Default: 5.
       *  See #417. */
      recentSegmentsToKeep: z
        .number()
        .min(0)
        .default(5)
        .describe(
          "Number of most-recent gen-0 segments to keep un-archived when meta-distillation fires. Default: 5.",
        ),
    })
    .default({
      minMessages: 5,
      minSegmentTokens: 64,
      maxSegmentTokens: 16384,
      metaThreshold: 20,
      toolOutputMaxChars: 4_000,
      recentSegmentsToKeep: 5,
    })
    .describe(
      "Distillation pipeline tuning (segment size, thresholds, tool-output truncation).",
    ),
  knowledge: z
    .object({
      /** Set to false to disable long-term knowledge storage and system-prompt injection.
       *  Conversation recall (temporal search, distillation search) and context management
       *  (gradient transform, distillation) remain fully active. Disabling this turns off
       *  the curator, knowledge DB writes, AGENTS.md sync, and LTM injection into the
       *  system prompt. Default: true. */
      enabled: z
        .boolean()
        .default(true)
        .describe(
          "Enable long-term knowledge storage and system-prompt injection. When false, the curator is disabled but recall and context management remain active. Default: true.",
        ),
      /** Max entities to inject into the agent system prompt. When the total entity count
       *  exceeds this cap, the self entity + its relations are always included and the rest
       *  are relevance-ranked. Remaining entities are discoverable via recall.
       *  Set to 0 to disable entity injection. Default: 30. */
      maxEntityInject: z
        .number()
        .min(0)
        .default(30)
        .describe(
          "Max entities to inject into the agent system prompt. Set to 0 to disable. Default: 30.",
        ),
      /** Auto-create `gotcha` knowledge entries from recurring tool failures
       *  (same tool + error type across multiple sessions). Default false:
       *  these entries are usually environmental noise (agent/tool flakiness,
       *  not codebase facts), and minting them mid-session churns the selected
       *  LTM set, which can bust the prompt cache. Opt in to surface recurring
       *  tool-failure patterns as knowledge. */
      autoToolFailureGotchas: z
        .boolean()
        .default(false)
        .describe(
          "Auto-create gotcha entries from recurring tool failures. Default false (noisy; can churn the LTM cache).",
        ),
    })
    .default({
      enabled: true,
      maxEntityInject: 30,
      autoToolFailureGotchas: false,
    })
    .describe("Long-term knowledge (curator, entity injection) controls."),
  curator: z
    .object({
      enabled: z
        .boolean()
        .default(true)
        .describe(
          "Enable the curator (knowledge extraction from conversation). Default: true.",
        ),
      onIdle: z
        .boolean()
        .default(true)
        .describe(
          "Run the curator on session idle (in addition to turn-based). Default: true.",
        ),
      inFlight: z
        .boolean()
        .default(false)
        .describe(
          "Run the curator mid-conversation (turn-based), not just on idle. " +
            "Default: false. WARNING: only enable on free-write / non-caching " +
            "providers (e.g. MiniMax). On cache-sensitive providers (Anthropic), " +
            "mid-session curation changes the knowledge base, which rewrites the " +
            "context-bound LTM block (system[2]) and busts the prompt cache for " +
            "the rest of a large conversation (a single change can re-write " +
            "hundreds of thousands of cached tokens). Deferring curation to idle " +
            "makes that rewrite free (the cache is cold then). Where cache writes " +
            "are free this is harmless and yields fresher knowledge sooner.",
        ),
      afterTurns: z
        .number()
        .min(1)
        .default(3)
        .describe("Minimum turns between curator runs. Default: 3."),
      /** Max knowledge entries per project before consolidation triggers. Default: 40. */
      maxEntries: z
        .number()
        .min(10)
        .default(40)
        .describe(
          "Max knowledge entries per project before consolidation. Default: 40.",
        ),
    })
    .default({
      enabled: true,
      onIdle: true,
      inFlight: false,
      afterTurns: 3,
      maxEntries: 40,
    })
    .describe("Curator scheduling and consolidation thresholds."),
  pruning: z
    .object({
      /** Days to keep distilled temporal messages before pruning. Default: 120. */
      retention: z
        .number()
        .min(1)
        .default(120)
        .describe(
          "Days to keep distilled temporal messages before pruning. Default: 120.",
        ),
      /** Max total temporal_messages storage in MB before emergency pruning. Default: 1024 (1 GB). */
      maxStorage: z
        .number()
        .min(50)
        .default(1024)
        .describe(
          "Max total temporal_messages storage in MB before emergency pruning. Default: 1024 (1 GB).",
        ),
    })
    .default({ retention: 120, maxStorage: 1024 })
    .describe("Storage retention and emergency-pruning thresholds."),
  search: z
    .object({
      /** BM25 column weights for knowledge FTS5 [title, content, category]. */
      ftsWeights: z
        .object({
          title: z
            .number()
            .min(0)
            .default(6.0)
            .describe("BM25 weight for the entry title column. Default: 6.0."),
          content: z
            .number()
            .min(0)
            .default(2.0)
            .describe(
              "BM25 weight for the entry content column. Default: 2.0.",
            ),
          category: z
            .number()
            .min(0)
            .default(3.0)
            .describe(
              "BM25 weight for the entry category column. Default: 3.0.",
            ),
        })
        .default({ title: 6.0, content: 2.0, category: 3.0 })
        .describe(
          "BM25 column weights for knowledge FTS5 [title, content, category].",
        ),
      /** Max results per source in recall tool before fusion. Default: 10. */
      recallLimit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe(
          "Max results per source in recall tool before fusion. Default: 10.",
        ),
      /** Enable LLM-based query expansion for the recall tool. Default: true.
       *  The configured model generates 2–3 alternative query phrasings before
       *  search, improving recall for ambiguous queries. Guarded by a 3-second
       *  timeout — if expansion fails or times out, the original query is used. */
      queryExpansion: z
        .boolean()
        .default(true)
        .describe(
          "Enable LLM-based query expansion (2-3 alternative phrasings) for the recall tool. Guarded by a 3s timeout. Default: true.",
        ),
      /** Max query terms (after stopword removal) for LLM expansion to activate.
       *  Queries longer than this skip expansion — they already have high
       *  specificity and expansion tends to introduce noise that dilutes precision.
       *  Entity-based expansion always runs regardless of this cap. Default: 8. */
      queryExpansionMaxTerms: z
        .number()
        .min(2)
        .max(20)
        .default(8)
        .describe(
          "Max query terms (after stopword removal) for LLM expansion. Longer queries skip expansion. Default: 8.",
        ),
      /** RRF weight multiplier for vector search lists. Applied when the query
       *  has >= `vectorBoostMinTerms` meaningful terms (after stopword removal).
       *  Boosts semantic/vector results relative to keyword-based BM25 lists.
       *  Default: 1.5. Set to 1.0 to disable. */
      vectorBoostWeight: z
        .number()
        .min(1)
        .max(5)
        .default(1.5)
        .describe(
          "RRF weight multiplier for vector search lists (when query has enough terms). Set to 1.0 to disable. Default: 1.5.",
        ),
      /** Minimum meaningful query terms (after stopword removal) to activate
       *  vector boost. Single-term queries are left unweighted since BM25
       *  excels there. Default: 2. */
      vectorBoostMinTerms: z
        .number()
        .min(1)
        .max(10)
        .default(2)
        .describe(
          "Minimum meaningful query terms (after stopword removal) to activate vector boost. Default: 2.",
        ),
      /** Vector embedding search.
       *  Supports multiple providers:
       *  - "local" (default): @huggingface/transformers + nomic-embed-text-v1.5, no API key needed.
       *    768 dims (Matryoshka-capable: 64–768). Model downloaded on first use (~137MB INT8),
       *    cached locally. Uses task instruction prefixes (search_document: / search_query:).
       *  - "voyage": Voyage AI (VOYAGE_API_KEY, voyage-code-3, 1024 dims)
       *  - "openai": OpenAI (OPENAI_API_KEY, text-embedding-3-small, 1536 dims)
       *  Set enabled: false to explicitly disable even with a provider available. */
      embeddings: z
        .object({
          /** Enable/disable vector embedding search. Default: true.
           *  Set to false to explicitly disable. */
          enabled: z
            .boolean()
            .default(true)
            .describe(
              "Enable vector embedding search. Set to false to explicitly disable. Default: true.",
            ),
          /** Embedding provider. Default: "local".
           *  - "local": @huggingface/transformers, no API key (default model: nomic-embed-text-v1.5, 768 dims)
           *  - "voyage": VOYAGE_API_KEY (default model: voyage-code-3, 1024 dims)
           *  - "openai": OPENAI_API_KEY (default model: text-embedding-3-small, 1536 dims) */
          provider: z
            .enum(["local", "voyage", "openai"])
            .default("local")
            .describe(
              'Embedding provider. "local" (no API key, on-device), "voyage" (VOYAGE_API_KEY), "openai" (OPENAI_API_KEY). Default: "local".',
            ),
          /** Model ID for the embedding provider. Default depends on provider. */
          model: z
            .string()
            .default("nomic-ai/nomic-embed-text-v1.5")
            .describe(
              "Model ID for the embedding provider. Default depends on provider.",
            ),
          /** Embedding dimensions. Default: 768 (local) / 1024 (voyage) / 1536 (openai).
           *  For the local Nomic v1.5 model, supports Matryoshka dimensions: 64, 128, 256, 512, 768. */
          dimensions: z
            .number()
            .min(64)
            .max(2048)
            .default(768)
            .describe(
              "Embedding dimensions. Default: 768 (local) / 1024 (voyage) / 1536 (openai). Local Nomic v1.5 supports Matryoshka: 64, 128, 256, 512, 768.",
            ),
        })
        .default({
          enabled: true,
          provider: "local",
          model: "nomic-ai/nomic-embed-text-v1.5",
          dimensions: 768,
        })
        .describe("Vector embedding search provider, model, and dimensions."),
      /** Recall output formatting — controls how search results are presented to the agent. */
      recall: z
        .object({
          /** Total character budget for recall output. Controls how much context the
           *  recall results consume. ~3K tokens at 12000 chars. Default: 12000. */
          charBudget: z
            .number()
            .min(2000)
            .max(20000)
            .default(12000)
            .describe(
              "Total character budget for recall output (~3K tokens at 12000 chars). Default: 12000.",
            ),
          /** Minimum RRF score relative to top result. Results below
           *  topScore * relevanceFloor are dropped. Default: 0.15.
           *  Set to 0 to disable score-based cutoff. */
          relevanceFloor: z
            .number()
            .min(0)
            .max(1)
            .default(0.15)
            .describe(
              "Minimum RRF score (relative to top) to keep. Set to 0 to disable. Default: 0.15.",
            ),
          /** Max results to show in recall output. Default: 15. */
          maxResults: z
            .number()
            .min(3)
            .max(30)
            .default(15)
            .describe("Max results to show in recall output. Default: 15."),
          /** Absolute (not relative) RRF score floor. Results below this are
           *  dropped even when they are the top result and even by the
           *  "keep at least 3" backfill. Prevents weak cross-session archives
           *  from being injected when nothing is genuinely relevant. Default:
           *  0 (disabled). */
          absoluteFloor: z
            .number()
            .min(0)
            .default(0)
            .describe(
              "Absolute RRF score floor; drops weak matches even via the keep-3 backfill. Default: 0 (disabled).",
            ),
        })
        .default({
          charBudget: 12000,
          relevanceFloor: 0.15,
          maxResults: 15,
          absoluteFloor: 0,
        })
        .describe("Recall output formatting and result-count limits."),
    })
    .default({
      ftsWeights: { title: 6.0, content: 2.0, category: 3.0 },
      recallLimit: 10,
      queryExpansion: true,
      queryExpansionMaxTerms: 8,
      vectorBoostWeight: 1.5,
      vectorBoostMinTerms: 2,
      embeddings: {
        enabled: true,
        provider: "local" as const,
        model: "nomic-ai/nomic-embed-text-v1.5",
        dimensions: 768,
      },
      recall: {
        charBudget: 12000,
        relevanceFloor: 0.15,
        maxResults: 15,
        absoluteFloor: 0,
      },
    })
    .describe(
      "Recall and search pipeline tuning: FTS weights, query expansion, vector boost, embeddings, and output formatting.",
    ),
  cache: z
    .object({
      /** TTL for the conversation cache breakpoint.
       *  - "5m" — standard Anthropic ephemeral (5 min eviction, 1.25× write cost)
       *  - "1h" — extended 1-hour TTL (2× write cost, requires extended cache tier)
       *  - "auto" — auto-upgrade to 1h when frequent cold-cache turns are detected.
       *    Monitors rolling window of recent turns; upgrades when >40% are cold-cache,
       *    downgrades when <20%. Auto-syncs idleResumeMinutes to 60 when 1h is active.
       *  Default: "auto". */
      conversationTTL: z
        .enum(["5m", "1h", "auto"])
        .default("auto")
        .describe(
          'Conversation cache breakpoint TTL. "5m" (Anthropic standard), "1h" (extended tier, 2× write cost), "auto" (auto-upgrade based on cold-cache rate). Default: "auto".',
        ),
      /** Speculative cache warming — sends max_tokens:0 keepalive requests to
       *  refresh the Anthropic prompt cache before it expires. Uses survival
       *  analysis on inter-turn gaps to predict whether the user will return. */
      warming: z
        .object({
          /** Enable cache warming. Default: true. */
          enabled: z
            .boolean()
            .default(true)
            .describe("Enable cache warming. Default: true."),
          /** Override the return probability threshold below which warming is
           *  skipped. Default: auto-derived from corrected cost ratio
           *  read/(write-read) (~0.087 for 5m TTL, ~0.042 for 1h TTL). */
          minReturnProbability: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "Override return probability threshold below which warming is skipped. Default: auto-derived from cost ratio.",
            ),
        })
        .default({ enabled: true })
        .describe(
          "Speculative cache warming (keepalive requests before TTL expiry).",
        ),
    })
    .default({
      conversationTTL: "auto",
      warming: { enabled: true },
    })
    .describe("Anthropic prompt cache TTL and speculative warming."),
  /** Workspace sub-project paths or globs, relative to the `.lore.json` directory.
   *  At startup, Lore imports `.lore.md` from each resolved sub-project into the
   *  root project's knowledge base. Supports literal paths (`"project-a"`) and
   *  single-level globs (`"packages/*"`). */
  workspaces: z
    .array(z.string())
    .default([])
    .describe(
      'Workspace sub-project paths or globs (relative to `.lore.json`). Imported into the root knowledge base on startup. Supports literal paths and single-level globs (e.g. "packages/*").',
    ),
  /** When true, include cross-project knowledge in compaction summaries and
   *  enable auto-promotion of knowledge that recurs across 3+ unrelated
   *  projects to `cross_project = 1` (issue #498). */
  crossProject: z
    .boolean()
    .default(true)
    .describe(
      "Include cross-project knowledge in compaction summaries and auto-promote knowledge that recurs across 3+ projects. Default: true.",
    ),
  agentsFile: z
    .object({
      /** Set to false to disable all AGENTS.md export/import behaviour. */
      enabled: z
        .boolean()
        .default(true)
        .describe(
          "Enable AGENTS.md export/import behaviour. Set to false to disable. Default: true.",
        ),
      /** Path to the agents file, relative to the project root. */
      path: z
        .string()
        .default("AGENTS.md")
        .describe(
          "Path to the agents file, relative to the project root. Default: 'AGENTS.md'.",
        ),
    })
    .default({ enabled: true, path: "AGENTS.md" })
    .describe("AGENTS.md export/import configuration."),
  loreFile: z
    .object({
      /** Set to false to disable `.lore.md` export/import. When disabled:
       *  - `.lore.md` is not written by the idle knowledge exporter.
       *  - Startup import skips the `.lore.md` branch and ignores any stale
       *    `.lore.md` on disk.
       *  - The recall tool description omits the "include .lore.md in commits"
       *    reminder.
       *  - The file watcher no longer watches `.lore.md` (root or sub-projects).
       *  Knowledge stays in the database and is still injected into the system
       *  prompt via LTM. Pair with `agentsFile.enabled=true` to keep sharing
       *  knowledge via an inline section in AGENTS.md. Default: true. */
      enabled: z
        .boolean()
        .default(true)
        .describe(
          "Set to false to disable `.lore.md` export/import. When disabled, `.lore.md` is not written, startup skips the `.lore.md` import branch, the recall tool omits the .lore.md commit reminder, and the file watcher ignores `.lore.md`. Knowledge stays in the database and is still injected into the system prompt via LTM. Pair with `agentsFile.enabled=true` to keep sharing knowledge via an inline section in AGENTS.md. Default: true.",
        ),
    })
    .default({ enabled: true })
    .describe("`.lore.md` export/import configuration."),
  /** User identity for the self-entity. When provided, creates/updates a "self" entity
   *  with this information. If omitted, falls back to git config user.name / user.email. */
  user: z
    .object({
      /** Display name. Overrides git config user.name. */
      name: z
        .string()
        .optional()
        .describe("Display name. Overrides git config user.name."),
      /** Email address. Overrides git config user.email. */
      email: z
        .string()
        .optional()
        .describe("Email address. Overrides git config user.email."),
      /** Additional aliases for the self entity. */
      aliases: z
        .array(
          z.object({
            type: z
              .enum([
                "name",
                "email",
                "github",
                "slack",
                "phone",
                "nickname",
                "url",
                "domain",
              ])
              .describe("Alias type."),
            value: z.string().describe("Alias value."),
          }),
        )
        .default([])
        .describe("Additional aliases for the self entity."),
      /** Metadata for the self entity (description, role, notes, etc.). */
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Metadata for the self entity (description, role, notes, etc.).",
        ),
    })
    .optional()
    .describe(
      "User identity for the self-entity. Falls back to git config user.name / user.email if omitted.",
    ),
});

export type LoreConfig = z.infer<typeof LoreConfig>;

let current: LoreConfig = LoreConfig.parse({});

export function config(): LoreConfig {
  return current;
}

export async function load(directory: string): Promise<LoreConfig> {
  // In hosted mode, never read config from client-controlled paths —
  // a crafted .lore.json could alter gateway behavior (budget, model, thresholds).
  if (!isHostedMode()) {
    const path = join(directory, ".lore.json");
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
        current = LoreConfig.parse(raw);
        return current;
      } catch (e) {
        warn(
          `Failed to parse ${path}: ${e instanceof Error ? e.message : e}. Using defaults.`,
        );
      }
    }
  }
  current = LoreConfig.parse({});
  return current;
}
