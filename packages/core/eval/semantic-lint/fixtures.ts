import type { DiffHunk } from "../../src/semantic-lint/check";
import type {
  RecordedJudgeTrace,
  RecordedVerifierTrace,
  SemanticLintReplayCase,
} from "./types";

function judge(
  verdict: RecordedJudgeTrace["verdict"],
  reason: string,
  overrides: Partial<RecordedJudgeTrace> = {},
): RecordedJudgeTrace {
  return {
    response: JSON.stringify({ verdict, reason }),
    verdict,
    reason,
    semanticCalls: 1,
    transportAttempts: 1,
    inputTokens: 1_800,
    outputTokens: 96,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 48,
    ...overrides,
  };
}

function verifier(
  outcome: RecordedVerifierTrace["outcome"],
  reason: string,
  overrides: Partial<RecordedVerifierTrace> = {},
): RecordedVerifierTrace {
  const parsedVerdict =
    outcome === "confirmed"
      ? "confirmed"
      : outcome === "cleared"
        ? "resolved"
        : "insufficient-context";
  return {
    response: JSON.stringify({
      evidence:
        parsedVerdict === "insufficient-context"
          ? []
          : [{ hunkId: "hunk-0001", reason }],
      reason,
      verdict: parsedVerdict,
    }),
    outcome,
    reason,
    semanticCalls: 1,
    transportAttempts: 1,
    inputTokens: 2_400,
    outputTokens: 128,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 64,
    ...overrides,
  };
}

function holisticJudge(
  invariantId: string,
  verdict: RecordedJudgeTrace["verdict"],
  reason: string,
  overrides: Partial<RecordedJudgeTrace> = {},
): RecordedJudgeTrace {
  const trace = judge(verdict, reason, overrides);
  return {
    ...trace,
    response: JSON.stringify({
      results: [
        {
          evidence:
            verdict === "violates" || verdict === "fixes"
              ? [{ hunkId: "hunk-0001", reason }]
              : [],
          invariantId,
          reason,
          verdict,
        },
      ],
    }),
  };
}

function invariant(
  id: string,
  title: string,
  content: string,
  severity: "advisory" | "soft" | "strict" = "strict",
) {
  return { id, title, content, severity } as const;
}

function hunk(
  file: string,
  text: string,
  extra: Partial<DiffHunk> = {},
): DiffHunk {
  return { file, text, ...extra };
}

const relocatedGateInvariant = invariant(
  "inv-temporal-recall-gate",
  "Temporal backfill must yield to live recall embedding",
  "Temporal backfill must wait while recallEmbedsInFlight() is non-zero; the gate may be implemented in core rather than the gateway.",
  "soft",
);

const lifecycleInvariant = invariant(
  "inv-embedded-gateway-lifecycle",
  "Owned embedded gateways must preserve lifecycle ownership",
  "An embedded gateway owned by the host process must remain registered with the existing lifecycle owner and preserve per-workspace disposal; replacing that contract with a process-level SIGTERM hook is an intentional baseline-rule change.",
  "strict",
);

const heldOutTerminationInvariant = invariant(
  "inv-process-worker-termination-hook",
  "Process-owned workers must release resources on termination",
  "A process-owned worker must register a one-shot termination hook that releases its resources before exit.",
  "strict",
);

const replacementInvariant = invariant(
  "inv-replacement-guard",
  "Replacement requests must retain the authentication guard",
  "A replacement request must pass through the shared authentication guard before dispatch; removing the guard is a true violation.",
  "strict",
);

const heldOutReplacementInvariant = invariant(
  "inv-session-replacement-authorization",
  "Session replacement must retain authorization before execution",
  "A session replacement must validate the caller before executing the replacement operation.",
  "strict",
);

const extractionInvariant = invariant(
  "inv-embedding-facade",
  "The embedding facade must preserve the bounded provider boundary",
  "Embedding callers must continue to use the bounded provider boundary when the implementation is split into modules.",
  "soft",
);

const heldOutExtractionInvariant = invariant(
  "inv-storage-facade",
  "The storage facade must preserve the bounded persistence boundary",
  "Storage callers must continue to use the bounded persistence provider when the implementation is split into modules.",
  "soft",
);

const lockedPr1766BackfillDiff =
  '@@ -0,0 +1,822 @@\n+/** Embedding configuration migration and startup backfills. */\n+\n+import { randomUUID } from "node:crypto";\n+import { performance } from "node:perf_hooks";\n+import {\n+  databaseInTransaction,\n+  db,\n+  getKV,\n+  isCurrentDatabase,\n+  setKV,\n+  withSavepoint,\n+  withTransaction,\n+} from "../db";\n+import { isVecAvailable } from "../db/vec";\n+import {\n+  clearAllEmbeddings,\n+  copyBlobsToVec0,\n+  dropEmbeddingColumn,\n+  type EmbeddingTable,\n+  embeddingColumnExists,\n+  ensureVec0Store,\n+  hasEmbeddingSql,\n+  missingEmbeddingSql,\n+  readStorageMode,\n+  resolveReadMode,\n+  setStorageMode,\n+  storeEmbedding,\n+} from "../db/vec-store";\n+import { config } from "../config";\n+import * as log from "../log";\n+import { nextEmbeddingBatch } from "./batching";\n+import {\n+  EmbeddingAbortError,\n+  EmbeddingQueueCapacityError,\n+  LocalProviderUnavailableError,\n+  awaitEmbeddingOperation,\n+  createEmbeddingAbortGuard,\n+  throwIfEmbeddingAborted,\n+  type EmbeddingOperationOptions,\n+} from "./contract";\n+import {\n+  embed,\n+  getProvider,\n+  isAvailable,\n+  recallEmbedsInFlight,\n+} from "./runtime";\n+import {\n+  enqueueTemporalEmbedding,\n+  invalidateTemporalEmbedding,\n+} from "../temporal-embedding-admission";\n+import { TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH } from "../embedding-units";\n+\n+// ---------------------------------------------------------------------------\n+// Config change detection\n+// ---------------------------------------------------------------------------\n+\n+function configFingerprint(): string {\n+  const cfg = config().search.embeddings;\n+  return `${cfg.provider}:${cfg.model}:${cfg.dimensions}`;\n+}\n+\n+const EMBEDDING_CONFIG_KEY = "lore:embedding_config";\n+\n+/** Check if embedding config has changed since the last backfill. */\n+export function checkConfigChange(): boolean {\n+  const current = configFingerprint();\n+  const readStored = (): { value: string } | null =>\n+    db()\n+      .query("SELECT value FROM kv_meta WHERE key = ?")\n+      .get(EMBEDDING_CONFIG_KEY) as { value: string } | null;\n+  const observed = readStored();\n+\n+  if (observed?.value === current) return false;\n+\n+  const reconcile = (): boolean => {\n+    // Re-check after BEGIN IMMEDIATE serializes competing processes. Without\n+    // this, a late reconciler can clear vectors another process just rebuilt.\n+    const stored = readStored();\n+    if (stored?.value === current) return false;\n+\n+    const mode = readStorageMode(db());\n+\n+    // A vec0-store DB whose extension didn\'t load (degraded) cannot manage its\n+    // embeddings — it can neither count/clear the unreadable vec0 tables nor\n+    // recreate them. Leave the stored fingerprint UNCHANGED so the change is\n+    // re-detected and handled the next time the DB opens on a capable runtime.\n+    if (mode === "vec0" && !isVecAvailable()) return false;\n+\n+    // Config changed (or first run) — clear all embeddings in all tables\n+    if (stored) {\n+      const total =\n+        mode === "vec0" ? countVec0Embeddings() : countBlobEmbeddings();\n+      if (total > 0) {\n+        clearAllEmbeddings(db());\n+        log.info(\n+          `embedding config changed (${stored.value} → ${current}), cleared ${total} stale embeddings`,\n+        );\n+      }\n+      // A *dimension* change makes the fixed-width vec0 tables incompatible:\n+      // recreate them at the new dimension (clearAllEmbeddings emptied the old\n+      // rows; ensureVec0Store drops + recreates when the stored dim differs, and\n+      // is a no-op for a same-dimension model/provider swap).\n+      if (mode === "vec0") {\n+        ensureVec0Store(db(), config().search.embeddings.dimensions);\n+      }\n+      // The clear wiped temporal vectors too, and temporal has no dedicated\n+      // backfill loop above — re-arm the resumable re-chunk walk so it refills\n+      // the corpus under the new model/dimension on this same startup.\n+      resetTemporalRechunkProgress();\n+    }\n+\n+    // Store new fingerprint\n+    db()\n+      .query(\n+        "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",\n+      )\n+      .run(EMBEDDING_CONFIG_KEY, current, current);\n+\n+    return true;\n+  };\n+\n+  return databaseInTransaction(db())\n+    ? withSavepoint("embedding_config_reconcile", reconcile)\n+    : withTransaction(reconcile);\n+}\n+\n+/** Count blob-layout embeddings across all four tables (config-change logging). */\n+function countBlobEmbeddings(): number {\n+  const n = (sql: string) => (db().query(sql).get() as { n: number }).n;\n+  return (\n+    n(\n+      "SELECT COUNT(*) as n FROM knowledge_current WHERE embedding IS NOT NULL",\n+    ) +\n+    n("SELECT COUNT(*) as n FROM distillations WHERE embedding IS NOT NULL") +\n+    n(\n+      "SELECT COUNT(*) as n FROM temporal_messages WHERE embedding IS NOT NULL",\n+    ) +\n+    n("SELECT COUNT(*) as n FROM entities WHERE embedding IS NOT NULL")\n+  );\n+}\n+\n+function countVec0Embeddings(): number {\n+  const n = (sql: string) => (db().query(sql).get() as { n: number }).n;\n+  return (\n+    n("SELECT COUNT(*) as n FROM knowledge_vec") +\n+    n("SELECT COUNT(*) as n FROM distillation_vec") +\n+    n("SELECT COUNT(*) as n FROM temporal_vec") +\n+    n("SELECT COUNT(*) as n FROM entity_vec")\n+  );\n+}\n+\n+/** The four embedding-bearing logical tables, in cutover order. */\n+const EMBEDDING_TABLES: readonly EmbeddingTable[] = [\n+  "knowledge",\n+  "entities",\n+  "distillations",\n+  "temporal",\n+];\n+\n+/** One-time blob→vec0 cutover. */\n+export function maybeCutoverToVec0(): void {\n+  if (!isVecAvailable()) return;\n+\n+  if (readStorageMode(db()) === "blob") {\n+    const dim = config().search.embeddings.dimensions;\n+    ensureVec0Store(db(), dim);\n+    // Relocate every existing blob into vec0 BEFORE flipping the mode. The copy\n+    // is idempotent (INSERT OR REPLACE) and does NOT drop anything, so a crash\n+    // here leaves mode="blob" with the base columns still INTACT — the copy\n+    // simply re-runs next startup. 🔴 INVARIANT: columns are dropped only AFTER\n+    // the flip below, so mode==="blob" always implies the embedding columns\n+    // still exist; no blob-mode query can ever read a half-dropped column (the\n+    // v55 boot-loop hazard).\n+    let staleSkipped = 0;\n+    for (const table of EMBEDDING_TABLES) {\n+      if (embeddingColumnExists(db(), table))\n+        staleSkipped += copyBlobsToVec0(db(), table, dim);\n+    }\n+    // Flip once vec0 is fully populated and authoritative.\n+    setStorageMode(db(), "vec0");\n+    // Arm the temporal re-chunk walk so backfillTemporalEmbeddings definitely\n+    // runs this startup and re-embeds every row skipped above (plus every legacy\n+    // single-vector row) at the correct dimension. This is a no-op today — the\n+    // done flag can only be latched from INSIDE a vec0-mode run of that walk, so\n+    // a machine transitioning from blob mode never has it set — but calling it at\n+    // the exact blob->vec0 transition hard-guards that invariant against future\n+    // refactors and self-documents that the walk is (re)armed here.\n+    resetTemporalRechunkProgress();\n+    if (staleSkipped > 0) {\n+      // Rare corpus corruption (blobs written under a different dimension). The\n+      // rows were skipped from the copy and will be re-embedded at `dim` by the\n+      // backfills below; surface it so an operator can see it happened.\n+      log.notice(\n+        `vec0 cutover skipped ${staleSkipped} stale-dimension embedding blob(s) (not ${dim}-dim / ${dim * 4} bytes); they will be re-embedded by the startup backfills`,\n+      );\n+    }\n+    log.info(`vec0 storage cutover complete (dim=${dim})`);\n+  }\n+\n+  // Reclaim: drop any leftover base embedding columns. Runs STRICTLY in vec0\n+  // mode (mode never reverts to blob), so no blob-mode reader can observe a\n+  // half-dropped column. Presence-aware + idempotent → resumable across a crash\n+  // mid-drop (the next startup finishes the remaining columns).\n+  if (readStorageMode(db()) === "vec0") {\n+    let droppedAny = false;\n+    for (const table of EMBEDDING_TABLES) {\n+      if (embeddingColumnExists(db(), table)) {\n+        dropEmbeddingColumn(db(), table);\n+        droppedAny = true;\n+      }\n+    }\n+    if (droppedAny) {\n+      try {\n+        // Best-effort: return the freed pages (notably ~320MB of temporal\n+        // vectors) to the OS. No-op unless auto_vacuum is on.\n+        db().query("PRAGMA incremental_vacuum").run();\n+      } catch {\n+        // ignore — space is already reclaimed within the DB file by DROP COLUMN.\n+      }\n+    }\n+  }\n+}\n+\n+// ---------------------------------------------------------------------------\n+// Startup backfill — single entry point for all hosts\n+// ---------------------------------------------------------------------------\n+\n+const STARTUP_BACKFILL_DELAY_MS = 2_000;\n+\n+/**\n+ * Outcome of a startup backfill pass, returned for host-side instrumentation (the gateway wraps the call\n+ * in a Sentry span).\n+ */\n+export interface BackfillStats {\n+  pendingKnowledge: number;\n+  pendingDistillations: number;\n+  knowledgeEmbedded: number;\n+  distillationEmbedded: number;\n+  entityEmbedded: number;\n+  knowledgeTotal: number;\n+  knowledgeWithEmbedding: number;\n+  distillationTotal: number;\n+  distillationWithEmbedding: number;\n+  temporalRechunked: number;\n+}\n+\n+function emptyBackfillStats(): BackfillStats {\n+  return {\n+    pendingKnowledge: 0,\n+    pendingDistillations: 0,\n+    knowledgeEmbedded: 0,\n+    distillationEmbedded: 0,\n+    entityEmbedded: 0,\n+    knowledgeTotal: 0,\n+    knowledgeWithEmbedding: 0,\n+    distillationTotal: 0,\n+    distillationWithEmbedding: 0,\n+    temporalRechunked: 0,\n+  };\n+}\n+\n+/** Host-supplied knobs for {@link runStartupBackfill}. */\n+export interface BackfillOptions {\n+  shouldPause?: () => boolean;\n+}\n+\n+export async function runStartupBackfill(\n+  opts: BackfillOptions = {},\n+): Promise<BackfillStats> {\n+  if (!isAvailable()) {\n+    // Make the degraded state visible in the startup path — this early return\n+    // was previously silent, so a consumer who omitted the optional\n+    // local-embedding stack (#1026), or is on a remote provider without a key,\n+    // had no startup signal that backfill (and vector recall) is off. Gate on\n+    // `enabled` so a deliberate `search.embeddings.enabled: false` stays quiet.\n+    // `isAvailable()` already emits the local-broken FTS-only line once; this is\n+    // the startup-scoped, backfill-specific companion.\n+    if (config().search.embeddings.enabled !== false) {\n+      log.info(\n+        "startup embedding backfill skipped — embeddings unavailable " +\n+          "(recall will use FTS-only search)",\n+      );\n+    }\n+    const stats = emptyBackfillStats();\n+    // Durable temporal admission is provider-independent. Preserve recovery\n+    // progress even while vector recall is temporarily FTS-only.\n+    stats.temporalRechunked = await backfillTemporalEmbeddings({\n+      shouldPause: opts.shouldPause,\n+    });\n+    return stats;\n+  }\n+\n+  // Handle an embedding-config change, then attempt the one-time blob→vec0\n+  // cutover (both no-ops in the steady state). Order matters: a config change\n+  // clears stale blobs BEFORE the cutover relocates the survivors, so the vec0\n+  // tables are never seeded with vectors from a since-changed model/dimension.\n+  checkConfigChange();\n+  maybeCutoverToVec0();\n+\n+  const mode = readStorageMode(db());\n+\n+  // A vec0-store DB on a runtime that cannot load sqlite-vec: the blob columns\n+  // are gone and the vec0 tables are unreadable. No backfill is possible — vector\n+  // recall degrades to empty (FTS still answers) and re-converges when the DB is\n+  // next opened on a capable runtime.\n+  if (resolveReadMode(mode, isVecAvailable()) === "degraded") {\n+    log.warn(\n+      "vec0 storage but sqlite-vec unavailable — skipping embedding backfill " +\n+        "(vector recall is FTS-only until reopened on a capable runtime)",\n+    );\n+    return emptyBackfillStats();\n+  }\n+\n+  // Surface backlog up-front so a slow startup is self-explanatory in logs.\n+  // Counts use the same mode-aware predicates the backfill loops use, so the\n+  // two numbers always match what we\'re about to do. (In vec0 mode the blob\n+  // column is gone — "pending" means a base row absent from the vec0 index.)\n+  const pendingKnowledge = (\n+    db()\n+      .query(\n+        `SELECT COUNT(*) as n FROM knowledge_current WHERE ${missingEmbeddingSql("knowledge", mode)} AND confidence > 0.2`,\n+      )\n+      .get() as { n: number }\n+  ).n;\n+  const pendingDistillations = (\n+    db()\n+      .query(\n+        `SELECT COUNT(*) as n FROM distillations WHERE ${missingEmbeddingSql("distillations", mode)} AND archived = 0 AND observations != \'\'`,\n+      )\n+      .get() as { n: number }\n+  ).n;\n+\n+  if (pendingKnowledge + pendingDistillations > 0) {\n+    log.info(\n+      `embedding backfill scheduled: ${pendingKnowledge} knowledge + ` +\n+        `${pendingDistillations} distillations pending — starting in ` +\n+        `${STARTUP_BACKFILL_DELAY_MS / 1000}s, batches yield between calls ` +\n+        `(host stays responsive)`,\n+    );\n+    await new Promise<void>((r) => setTimeout(r, STARTUP_BACKFILL_DELAY_MS));\n+  }\n+\n+  const knowledgeEmbedded = await backfillEmbeddings();\n+  const distillationEmbedded = await backfillDistillationEmbeddings();\n+  const entityEmbedded = await backfillEntityEmbeddings();\n+  // Re-chunk pre-multi-vector temporal survivors into the vec0 layout. Resumable\n+  // + done-flagged, so this is the heavy walk only on the first vec0 run (and\n+  // again after a config change); a no-op in blob mode and once converged. Idle-\n+  // gated (opts.shouldPause) so it yields the shared embed pool to live traffic.\n+  const temporalConnection = db();\n+  const temporalRechunked = await backfillTemporalEmbeddings({\n+    shouldPause: opts.shouldPause,\n+  });\n+  // The walk may stop after shutdown. Do not reopen storage for GC or coverage\n+  // stats, or use a successor connection that belongs to a different startup.\n+  if (!isCurrentDatabase(temporalConnection)) {\n+    return {\n+      ...emptyBackfillStats(),\n+      pendingKnowledge,\n+      pendingDistillations,\n+      knowledgeEmbedded,\n+      distillationEmbedded,\n+      entityEmbedded,\n+      temporalRechunked,\n+    };\n+  }\n+\n+  // Orphan discovery belongs to the host\'s idle read-worker maintenance.\n+  // Never scan the full vector corpus on the startup writer (#1681).\n+\n+  // Coverage stats — always log to stderr so the problem is visible.\n+  const kTotal = (\n+    db()\n+      .query(\n+        "SELECT COUNT(*) as n FROM knowledge_current WHERE confidence > 0.2",\n+      )\n+      .get() as { n: number }\n+  ).n;\n+  const kWithEmb = (\n+    db()\n+      .query(\n+        `SELECT COUNT(*) as n FROM knowledge_current WHERE ${hasEmbeddingSql("knowledge", mode)} AND confidence > 0.2`,\n+      )\n+      .get() as { n: number }\n+  ).n;\n+  const dTotal = (\n+    db()\n+      .query(\n+        "SELECT COUNT(*) as n FROM distillations WHERE archived = 0 AND observations != \'\'",\n+      )\n+      .get() as { n: number }\n+  ).n;\n+  const dWithEmb = (\n+    db()\n+      .query(\n+        // Mirror dTotal\'s predicate (incl. observations != \'\') so the coverage\n+        // numerator is always a subset of the denominator (never reads "11/10").\n+        `SELECT COUNT(*) as n FROM distillations WHERE ${hasEmbeddingSql("distillations", mode)} AND archived = 0 AND observations != \'\'`,\n+      )\n+      .get() as { n: number }\n+  ).n;\n+\n+  const parts: string[] = [];\n+  // Lead with the storage mode + native availability so silent degradation is\n+  // visible at a glance: `storage_mode=vec0 vec=off` means this DB cut over to\n+  // vec0-only storage but sqlite-vec did not load here, so vector recall is\n+  // FTS-only until reopened on a capable runtime.\n+  parts.push(`storage_mode=${mode} vec=${isVecAvailable() ? "on" : "off"}`);\n+  if (\n+    knowledgeEmbedded > 0 ||\n+    distillationEmbedded > 0 ||\n+    entityEmbedded > 0 ||\n+    temporalRechunked > 0\n+  ) {\n+    parts.push(\n+      `backfilled ${knowledgeEmbedded} knowledge + ${distillationEmbedded} distillations + ${entityEmbedded} entities + ${temporalRechunked} temporal re-chunked`,\n+    );\n+  }\n+  parts.push(\n+    `coverage: knowledge ${kWithEmb}/${kTotal}, distillations ${dWithEmb}/${dTotal}`,\n+  );\n+  log.info(`embedding startup: ${parts.join("; ")}`);\n+\n+  return {\n+    pendingKnowledge,\n+    pendingDistillations,\n+    knowledgeEmbedded,\n+    distillationEmbedded,\n+    entityEmbedded,\n+    knowledgeTotal: kTotal,\n+    knowledgeWithEmbedding: kWithEmb,\n+    distillationTotal: dTotal,\n+    distillationWithEmbedding: dWithEmb,\n+    temporalRechunked,\n+  };\n+}\n+\n+interface BackfillItem {\n+  id: string;\n+  text: string;\n+}\n+\n+async function embedBackfill(\n+  items: BackfillItem[],\n+  table: "knowledge" | "distillations" | "entities",\n+  label: string,\n+  completeLabel: string,\n+  guard?: ReturnType<typeof createEmbeddingAbortGuard>,\n+  progressEvery?: number,\n+): Promise<number> {\n+  let embedded = 0;\n+  let nextProgress = progressEvery ?? Infinity;\n+\n+  for (let i = 0; i < items.length;) {\n+    if (guard) throwIfEmbeddingAborted(guard);\n+    const batch = nextEmbeddingBatch(items, i);\n+    i += batch.length;\n+\n+    try {\n+      const work = embed(\n+        batch.map(({ text }) => text),\n+        "document",\n+      );\n+      const vectors = guard\n+        ? await awaitEmbeddingOperation(work, guard)\n+        : await work;\n+      if (guard) throwIfEmbeddingAborted(guard);\n+\n+      for (let j = 0; j < batch.length; j++) {\n+        storeEmbedding(db(), table, batch[j].id, vectors[j]);\n+        embedded++;\n+      }\n+    } catch (error) {\n+      if (error instanceof EmbeddingAbortError) throw error;\n+      if (\n+        error instanceof EmbeddingQueueCapacityError ||\n+        error instanceof LocalProviderUnavailableError\n+      ) {\n+        const reason =\n+          error instanceof EmbeddingQueueCapacityError\n+            ? "queue saturated"\n+            : "provider unavailable";\n+        log.info(`${label} backfill stopped: ${reason}`);\n+        break;\n+      }\n+      log.error(\n+        `${label} backfill batch failed (${batch.length} items):`,\n+        error,\n+      );\n+    }\n+\n+    if (embedded >= nextProgress) {\n+      log.info(`embedding ${completeLabel}: ${embedded}/${items.length}…`);\n+      nextProgress = embedded + (progressEvery ?? Infinity);\n+    }\n+  }\n+\n+  if (embedded > 0) log.info(`embedded ${embedded} ${completeLabel}`);\n+  return embedded;\n+}\n+\n+export async function backfillEmbeddings(\n+  options: EmbeddingOperationOptions = {},\n+): Promise<number> {\n+  const guard = createEmbeddingAbortGuard("knowledge-backfill", options);\n+  throwIfEmbeddingAborted(guard);\n+  checkConfigChange();\n+  throwIfEmbeddingAborted(guard);\n+  if (!getProvider()) return 0;\n+\n+  const mode = readStorageMode(db());\n+  const rows = db()\n+    .query(\n+      `SELECT id, title, content FROM knowledge_current WHERE ${missingEmbeddingSql("knowledge", mode)} AND confidence > 0.2`,\n+    )\n+    .all() as Array<{ id: string; title: string; content: string }>;\n+\n+  throwIfEmbeddingAborted(guard);\n+  return embedBackfill(\n+    rows.map(({ id, title, content }) => ({\n+      id,\n+      text: `${title}\\n${content}`,\n+    })),\n+    "knowledge",\n+    "embedding",\n+    "knowledge entries",\n+    guard,\n+  );\n+}\n+\n+export async function backfillDistillationEmbeddings(): Promise<number> {\n+  if (!getProvider()) return 0;\n+  const mode = readStorageMode(db());\n+  const rows = db()\n+    .query(\n+      `SELECT id, observations FROM distillations WHERE ${missingEmbeddingSql("distillations", mode)} AND archived = 0 AND observations != \'\'`,\n+    )\n+    .all() as Array<{ id: string; observations: string }>;\n+\n+  return embedBackfill(\n+    rows.map(({ id, observations }) => ({ id, text: observations })),\n+    "distillations",\n+    "distillation embedding",\n+    "distillations",\n+    undefined,\n+    256,\n+  );\n+}\n+\n+export async function backfillEntityEmbeddings(): Promise<number> {\n+  if (!getProvider()) return 0;\n+  const mode = readStorageMode(db());\n+  const rows = db()\n+    .query(\n+      `SELECT e.id AS id, e.canonical_name AS canonical_name,\n+              (SELECT GROUP_CONCAT(da.alias_value, \' \')\n+               FROM (SELECT DISTINCT alias_value FROM entity_aliases WHERE entity_id = e.id) da\n+              ) AS aliases\n+       FROM entities e\n+       WHERE ${missingEmbeddingSql("entities", mode, "e")}`,\n+    )\n+    .all() as Array<{\n+    id: string;\n+    canonical_name: string;\n+    aliases: string | null;\n+  }>;\n+\n+  return embedBackfill(\n+    rows.map(({ id, canonical_name, aliases }) => ({\n+      id,\n+      text: `${canonical_name} ${aliases ?? ""}`.trim(),\n+    })),\n+    "entities",\n+    "entity embedding",\n+    "entities",\n+  );\n+}\n+const TEMPORAL_RECHUNK_CURSOR_KEY = "lore:temporal_rechunk.cursor";\n+const TEMPORAL_RECHUNK_DONE_KEY = "lore:temporal_rechunk.done";\n+const TEMPORAL_RECHUNK_PAGE = 256;\n+const TEMPORAL_RECHUNK_YIELD_ROWS = 32;\n+const TEMPORAL_RECHUNK_YIELD_MS = 8;\n+const TEMPORAL_RECHUNK_ELIGIBLE_SQL = `length(CAST(content AS BLOB)) >= ${TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH}`;\n+const TEMPORAL_RECHUNK_ATTEMPTS_KEY = "lore:temporal_rechunk.attempts";\n+const TEMPORAL_RECHUNK_INFLIGHT_KEY = "lore:temporal_rechunk.inflight";\n+const TEMPORAL_RECHUNK_ROW_ATTEMPTS_KEY = "lore:temporal_rechunk.row_attempts";\n+const TEMPORAL_RECHUNK_SKIP_KEY = "lore:temporal_rechunk.skip";\n+const TEMPORAL_RECHUNK_MAX_ROWID_KEY = "lore:temporal_rechunk.max_rowid";\n+/** Fence active walks across config resets, including resets by other processes. */\n+const TEMPORAL_RECHUNK_EPOCH_KEY = "lore:temporal_rechunk.epoch";\n+const TEMPORAL_RECHUNK_PAUSE_POLL_MS = 250;\n+\n+async function awaitBackfillIdle(\n+  shouldPause: (() => boolean) | undefined,\n+  isCurrent: () => boolean,\n+): Promise<void> {\n+  if (!shouldPause) return;\n+  // Edge-triggered logging: because this call blocks until the host is idle,\n+  // one busy stretch (however many rows it spans) yields exactly one park/resume\n+  // pair — so a long park is visible in the logs instead of looking like a wedge.\n+  let parked = false;\n+  for (;;) {\n+    if (!isCurrent()) return;\n+    let paused = false;\n+    try {\n+      paused = shouldPause();\n+    } catch {\n+      break; // never let a throwing gate brick the walk\n+    }\n+    if (!paused) break;\n+    if (!parked) {\n+      parked = true;\n+      log.info("temporal re-chunk parked — deferring to live traffic");\n+    }\n+    await new Promise<void>((resolve) => {\n+      const t = setTimeout(resolve, TEMPORAL_RECHUNK_PAUSE_POLL_MS);\n+      // Don\'t let a parked walk hold the process open on its own; the host\'s\n+      // server keeps it alive, and if it doesn\'t, resuming next start is fine.\n+      (t as { unref?: () => void }).unref?.();\n+    });\n+  }\n+  if (parked) log.info("temporal re-chunk resumed");\n+}\n+\n+/** Reset durable scheduling progress so the next startup walks the corpus again. */\n+export function resetTemporalRechunkProgress(): void {\n+  withSavepoint("reset_temporal_rechunk", () => {\n+    setKV(TEMPORAL_RECHUNK_EPOCH_KEY, randomUUID());\n+    setKV(TEMPORAL_RECHUNK_DONE_KEY, "0");\n+    setKV(TEMPORAL_RECHUNK_CURSOR_KEY, "");\n+    setKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY, "0");\n+    setKV(TEMPORAL_RECHUNK_INFLIGHT_KEY, "");\n+    setKV(TEMPORAL_RECHUNK_ROW_ATTEMPTS_KEY, "0");\n+    setKV(TEMPORAL_RECHUNK_SKIP_KEY, "");\n+    setKV(TEMPORAL_RECHUNK_MAX_ROWID_KEY, "0");\n+  });\n+}\n+\n+/**\n+ * Cumulative-progress line for the temporal re-chunk walk. `done`/`total` count embeddable (>=50 char)\n+ * messages across ALL runs, so the percentage keeps climbing over restarts — unlike the per-process\n+ * counters, which reset to zero on every boot. `thisRun` is what the current invocation scheduled.\n+ */\n+export function formatTemporalRechunkProgress(\n+  done: number,\n+  total: number,\n+  thisRun: number,\n+): string {\n+  const pct =\n+    total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : 100;\n+  return `temporal re-chunk: ${pct}% complete (${done}/${total} messages) · +${thisRun} scheduled this run`;\n+}\n+\n+/** Durably schedule existing temporal messages for the multi-vector vec0 layout. */\n+export async function backfillTemporalEmbeddings(\n+  opts: { shouldPause?: () => boolean } = {},\n+): Promise<number> {\n+  // Multi-vector chunking only exists in vec0 mode. Skip WITHOUT latching done\n+  // so a later cutover to vec0 still triggers the walk.\n+  //\n+  // 🔴 Ordering invariant: this vec0-mode guard MUST come BEFORE the done-flag\n+  // check below. Because the flag can therefore only ever be latched from inside\n+  // a vec0-mode run, a blob-mode run can never set it — which is what guarantees\n+  // the first walk after a blob->vec0 cutover is always armed and re-embeds the\n+  // rows that cutover skipped. (maybeCutoverToVec0 also explicitly re-arms the\n+  // walk on cutover as belt-and-suspenders.) Do not reorder these two lines.\n+  const connection = db();\n+  const snapshot = withSavepoint("start_temporal_rechunk", () => {\n+    if (readStorageMode(connection) !== "vec0") return null;\n+    if (getKV(TEMPORAL_RECHUNK_DONE_KEY) === "1") return null;\n+    const cursor = getKV(TEMPORAL_RECHUNK_CURSOR_KEY) ?? "";\n+    const epoch = getKV(TEMPORAL_RECHUNK_EPOCH_KEY);\n+    let maxRowid = Number(getKV(TEMPORAL_RECHUNK_MAX_ROWID_KEY) ?? "0");\n+    if (!Number.isSafeInteger(maxRowid) || maxRowid <= 0) {\n+      maxRowid = (\n+        connection\n+          .query(\n+            `SELECT COALESCE(MAX(rowid), 0) AS n FROM temporal_messages WHERE ${TEMPORAL_RECHUNK_ELIGIBLE_SQL}`,\n+          )\n+          .get() as { n: number }\n+      ).n;\n+      setKV(TEMPORAL_RECHUNK_MAX_ROWID_KEY, String(maxRowid));\n+    }\n+    return { cursor, epoch, maxRowid };\n+  });\n+  if (!snapshot) return 0;\n+  let { cursor } = snapshot;\n+  const { maxRowid, epoch } = snapshot;\n+  // Identity must be checked first: getKV/db() would reopen storage after close.\n+  const isCurrent = () =>\n+    isCurrentDatabase(connection) &&\n+    getKV(TEMPORAL_RECHUNK_EPOCH_KEY) === epoch;\n+  // Core owns the shared embed-pool signal; hosts only contribute their own\n+  // pause policy. This keeps recall-priority admission true for every host.\n+  const shouldPause = () =>\n+    recallEmbedsInFlight() > 0 || opts.shouldPause?.() === true;\n+  let scheduled = 0;\n+  let scanned = 0;\n+\n+  // Up-front backlog so a long walk is explainable from the logs. The corpus is\n+  // 100k+ rows and, under embed-pool contention, converges at single-digit\n+  // rows/min — without this line a multi-hour (or, across restarts, multi-day)\n+  // walk is completely invisible. Counts rows still to scan from the resume\n+  // cursor; runs once per process (the walk is one-shot per config).\n+  const backlog = (\n+    db()\n+      .query(\n+        `SELECT COUNT(*) AS n FROM temporal_messages\n+         WHERE id > ? AND rowid <= ? AND ${TEMPORAL_RECHUNK_ELIGIBLE_SQL}`,\n+      )\n+      .get(cursor, maxRowid) as { n: number }\n+  ).n;\n+  // Denominator for cumulative progress: ALL embeddable messages, not just the\n+  // remaining backlog, so the heartbeat shows a percentage that keeps climbing\n+  // across restarts instead of the per-process tally that resets to zero on every\n+  // boot. `baseDone` is what prior runs already covered (rows at/below the resume\n+  // cursor); the walk\'s SELECT uses the same byte-length eligibility predicate,\n+  // so `scanned`\n+  // counts embeddable rows and `baseDone + scanned` reaches exactly `total` on a\n+  // clean pass (→ 100%). Gated on `backlog > 0`: when nothing remains the loop\n+  // latches done without iterating, so `total`/`baseDone` are never read — no\n+  // point paying for a second full-table COUNT on that path.\n+  let total = 0;\n+  let baseDone = 0;\n+  if (backlog > 0) {\n+    total = (\n+      db()\n+        .query(\n+          `SELECT COUNT(*) AS n FROM temporal_messages WHERE rowid <= ? AND ${TEMPORAL_RECHUNK_ELIGIBLE_SQL}`,\n+        )\n+        .get(maxRowid) as { n: number }\n+    ).n;\n+    baseDone = Math.max(0, total - backlog);\n+    const basePct = total > 0 ? Math.round((baseDone / total) * 1000) / 10 : 0;\n+    log.info(\n+      `temporal re-chunk: ${backlog} messages to scan (${baseDone}/${total} already done, ${basePct}%)${cursor ? ", resuming" : ""}`,\n+    );\n+  }\n+\n+  // Wall-clock heartbeat rather than a per-N-rows milestone: at the observed\n+  // throughput a 1000-row milestone can be hours away, so a time cadence keeps\n+  // the walk visible regardless of speed.\n+  const PROGRESS_INTERVAL_MS = 30_000;\n+  let lastProgressAt = Date.now();\n+  let sliceStarted = performance.now();\n+\n+  for (;;) {\n+    if (!isCurrent()) return scheduled;\n+    // Keep the legacy walk aligned with scheduler eligibility.\n+    const rows = db()\n+      .query(\n+        `SELECT id FROM temporal_messages\n+         WHERE id > ? AND rowid <= ? AND ${TEMPORAL_RECHUNK_ELIGIBLE_SQL}\n+         ORDER BY id ASC LIMIT ?`,\n+      )\n+      .all(cursor, maxRowid, TEMPORAL_RECHUNK_PAGE) as Array<{ id: string }>;\n+\n+    if (!rows.length) {\n+      withSavepoint("finish_temporal_rechunk", () => {\n+        if (!isCurrent()) return;\n+        setKV(TEMPORAL_RECHUNK_DONE_KEY, "1");\n+        setKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY, "0");\n+        setKV(TEMPORAL_RECHUNK_INFLIGHT_KEY, "");\n+        setKV(TEMPORAL_RECHUNK_ROW_ATTEMPTS_KEY, "0");\n+        setKV(TEMPORAL_RECHUNK_SKIP_KEY, "");\n+      });\n+      break;\n+    }\n+\n+    for (const row of rows) {\n+      await awaitBackfillIdle(shouldPause, isCurrent);\n+      if (!isCurrentDatabase(connection)) return scheduled;\n+      const admitted = withSavepoint("schedule_temporal_rechunk", () => {\n+        if (!isCurrent()) return false;\n+        const current = db()\n+          .query(\n+            "SELECT content FROM temporal_messages WHERE id = ? AND rowid <= ?",\n+          )\n+          .get(row.id, maxRowid) as { content: string } | null;\n+        if (current) {\n+          const enqueued = enqueueTemporalEmbedding(row.id, current.content);\n+          if (enqueued) {\n+            invalidateTemporalEmbedding(row.id);\n+            scheduled++;\n+          }\n+        }\n+        cursor = row.id;\n+        scanned++;\n+        setKV(TEMPORAL_RECHUNK_CURSOR_KEY, cursor);\n+        return true;\n+      });\n+      if (!admitted) return scheduled;\n+\n+      if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {\n+        log.info(\n+          formatTemporalRechunkProgress(baseDone + scanned, total, scheduled),\n+        );\n+        lastProgressAt = Date.now();\n+      }\n+\n+      // awaitBackfillIdle resolves immediately when the gate is clear. Awaiting\n+      // it only yields to microtasks, starving HTTP/timers for the entire walk.\n+      // Yield after SCANNED rows (including already-queued/deleted rows), with\n+      // every queue/vector/cursor savepoint committed before other work runs.\n+      if (\n+        scanned % TEMPORAL_RECHUNK_YIELD_ROWS === 0 ||\n+        performance.now() - sliceStarted >= TEMPORAL_RECHUNK_YIELD_MS\n+      ) {\n+        await new Promise<void>((resolve) => setImmediate(resolve));\n+        if (!isCurrent()) return scheduled;\n+        sliceStarted = performance.now();\n+      }\n+    }\n+  }\n+\n+  if (scheduled > 0) {\n+    log.info(\n+      formatTemporalRechunkProgress(baseDone + scanned, total, scheduled),\n+    );\n+  }\n+  return scheduled;\n+}';
const lockedPr1768IndexDiff =
  '@@ -12,9 +12,8 @@ import {\n // (`undefined is not an object (evaluating \'A.event\')`). See ./internal.ts.\n import {\n   applyLoreProviderConfig,\n-  EmbeddedGatewayLifecycle,\n-  type EmbeddedGatewayLease,\n   gatewayAccessHeadersForRemote,\n+  installEmbeddedGatewaySigtermHandler,\n   probeGateway,\n   shouldForwardUpstreamExtraHeader,\n   surfaceGatewayUnavailable,\n@@ -96,10 +95,11 @@ async function startInProcess(): Promise<string | null> {\n     const gw = "@loreai/gateway";\n     const { startGateway } = await import(/* webpackIgnore: true */ gw);\n     const handle = await startGateway({ quiet: true, local: true });\n-    processLifecycle.ownGateway(handle);\n     const url = `http://127.0.0.1:${handle.port}`;\n \n-    if (!handle.owned) {\n+    if (handle.owned) {\n+      installEmbeddedGatewaySigtermHandler(handle.shutdown);\n+    } else {\n       log.info(`reusing existing gateway at ${url}`);\n     }\n \n@@ -222,19 +222,6 @@ async function resolveParentSession(\n /** Memoized lore init promise — ensures concurrent plugin calls don\'t race. */\n let loreInitPromise: Promise<string | null> | null = null;\n \n-function resetProcessState(): void {\n-  processInitDone = false;\n-  processLoreActive = false;\n-  processLoreBase = "";\n-  loreInitPromise = null;\n-  lastGatewayStartError = null;\n-  currentProject = undefined;\n-  projectState.clear();\n-  sessionParent.clear();\n-}\n-\n-const processLifecycle = new EmbeddedGatewayLifecycle(resetProcessState);\n-\n /**\n  * Whether the plugin should stay inert (skip gateway probe/start and the\n  * process-wide fetch interceptor). True under test runners — `NODE_ENV=test`\n@@ -255,10 +242,7 @@ function isInertTestEnv(): boolean {\n   );\n }\n \n-async function initializeLorePlugin(\n-  ctx: PluginInput,\n-  lifecycleLease: EmbeddedGatewayLease,\n-): Promise<Hooks> {\n+export const LorePlugin: Plugin = async (ctx) => {\n   // Initialize lore — only probe/start once per process.\n   const loreDisabled =\n     process.env.LORE_DISABLED === "1" || process.env.LORE_DISABLED === "true";\n@@ -354,11 +338,7 @@ async function initializeLorePlugin(\n   currentProject = { path: thisProjectPath, gitRemote: thisGitRemote };\n \n   try {\n-    // OpenCode 1.18+ awaits this hook from its instance finalizer. Keep the\n-    // local intersection until our minimum supported plugin SDK declares it.\n-    const hooks: Hooks & { dispose: () => Promise<void> } = {\n-      dispose: lifecycleLease.release,\n-\n+    const hooks: Hooks = {\n       // Disable built-in compaction (gateway handles it), register hidden\n       // worker agents, and redirect all provider baseURLs through the gateway.\n       config: async (input) => {\n@@ -490,24 +470,22 @@ async function initializeLorePlugin(\n         // Install the fetch interceptor once per process. It transparently\n         // reroutes outgoing LLM API calls through the gateway while\n         // preserving original auth headers and URLs.\n-        processLifecycle.ownFetchInterceptor(\n-          installFetchInterceptor({\n-            gatewayBase,\n-            getHeaders: () => {\n-              const headers: Record<string, string> = {\n-                ...gatewayAccessHeadersForRemote(gatewayBase),\n-              };\n-              const cur = currentProject;\n-              if (cur?.path) {\n-                headers["x-lore-project"] = cur.path;\n-                // Only emit the remote paired with the path it was resolved FOR,\n-                // never a remote left over from a different project\'s plugin call.\n-                if (cur.gitRemote) headers["x-lore-git-remote"] = cur.gitRemote;\n-              }\n-              return headers;\n-            },\n-          }),\n-        );\n+        installFetchInterceptor({\n+          gatewayBase,\n+          getHeaders: () => {\n+            const headers: Record<string, string> = {\n+              ...gatewayAccessHeadersForRemote(gatewayBase),\n+            };\n+            const cur = currentProject;\n+            if (cur?.path) {\n+              headers["x-lore-project"] = cur.path;\n+              // Only emit the remote paired with the path it was resolved FOR,\n+              // never a remote left over from a different project\'s plugin call.\n+              if (cur.gitRemote) headers["x-lore-git-remote"] = cur.gitRemote;\n+            }\n+            return headers;\n+          },\n+        });\n         log.info(`routing through ${gatewayBase}`);\n         log.info(`dashboard: ${gatewayBase}/ui`);\n       }\n@@ -525,24 +503,6 @@ async function initializeLorePlugin(\n     log.error(`init failed: ${detail}`);\n     throw e;\n   }\n-}\n-\n-export const LorePlugin: Plugin = async (ctx) => {\n-  const lifecycleLease = await processLifecycle.acquire();\n-  try {\n-    return await initializeLorePlugin(ctx, lifecycleLease);\n-  } catch (error) {\n-    try {\n-      await lifecycleLease.release();\n-    } catch (cleanupError) {\n-      const detail =\n-        cleanupError instanceof Error\n-          ? cleanupError.stack || cleanupError.message\n-          : String(cleanupError);\n-      log.error(`cleanup after init failure failed: ${detail}`);\n-    }\n-    throw error;\n-  }\n };\n \n // WARNING: do NOT add any other export to this module. OpenCode\'s legacy';

const lockedPr1766BackfillExcerpt = (() => {
  const start = lockedPr1766BackfillDiff.indexOf(
    "+/** Durably schedule existing temporal messages for the multi-vector vec0 layout. */",
  );
  const end = lockedPr1766BackfillDiff.indexOf("+  if (scheduled > 0)", start);
  if (start < 0 || end < 0) throw new Error("locked PR #1766 diff changed");
  return lockedPr1766BackfillDiff.slice(start, end);
})();

const lockedPr1766PipelineHunk = [
  "@@ -4250,7 +4228,7 @@ async function initIfNeeded(",
  "     // embed is in flight, resume the instant the worker drains.",
  "     const startupBackfill = spanStartupBackfill(() => {",
  "       const backfill = embedding.runStartupBackfill({",
  "-        shouldPause: buildTemporalBackfillGate(),",
  "+        shouldPause: () => isBackgroundPaused(),",
  "       });",
  "       // When embeddings are available, runStartupBackfill synchronously",
  "       // reconciles config and attempts vec0 cutover before its first await.",
].join("\n");

const relocatedGateHunks: DiffHunk[] = [
  hunk("packages/core/src/embedding/backfill.ts", lockedPr1766BackfillExcerpt),
  hunk("packages/gateway/src/pipeline.ts", lockedPr1766PipelineHunk),
];

const relocatedVerifier = verifier(
  "cleared",
  "The companion core hunk reinstates the same admission rule at the shared boundary.",
  { inputTokens: 2_720, outputTokens: 132, latencyMs: 71 },
);
relocatedVerifier.response = JSON.stringify({
  evidence: [
    {
      hunkId: "hunk-0002",
      reason: relocatedVerifier.reason,
    },
  ],
  reason: relocatedVerifier.reason,
  verdict: "resolved",
});

const relocatedGateAdaptive = {
  firstPass: judge(
    "violates",
    "The gateway-side gate was removed from the changed pipeline hunk.",
    { inputTokens: 1_620, outputTokens: 88, latencyMs: 44 },
  ),
  verifier: relocatedVerifier,
};

const lifecycleHunks: DiffHunk[] = [
  hunk(
    "packages/opencode/src/index.ts",
    [
      "@@ -96,10 +95,11 @@ async function startInProcess(): Promise<string | null> {",
      '     const gw = "@loreai/gateway";',
      "     const { startGateway } = await import(/* webpackIgnore: true */ gw);",
      "     const handle = await startGateway({ quiet: true, local: true });",
      "-    processLifecycle.ownGateway(handle);",
      "     const url = `http://127.0.0.1:${handle.port}`;",
      " ",
      "-    if (!handle.owned) {",
      "+    if (handle.owned) {",
      "+      installEmbeddedGatewaySigtermHandler(handle.shutdown);",
      "+    } else {",
      "       log.info(`reusing existing gateway at ${url}`);",
    ].join("\n"),
  ),
];

const replacementHunks: DiffHunk[] = [
  hunk(
    "packages/gateway/src/requests/replacement.ts",
    "@@ -40,8 +40,4 @@ export async function replaceRequest(request)\n-  await requireAuthentication(request);\n-  return dispatchReplacement(request);\n+  return dispatchReplacement(request);",
  ),
  hunk(
    "packages/gateway/test/replacement.test.ts",
    '@@ -10,4 +10,4 @@ it("replacement is authenticated", async () => {\n-  await replaceRequest(authenticated);\n+  await replaceRequest(request);',
  ),
];

const extractionHunks: DiffHunk[] = [
  hunk(
    "packages/core/src/embedding/runtime.ts",
    "@@ -1,5 +1,8 @@\n+export async function embed(texts, inputType) {\n+  return provider.embed(texts, inputType);\n+}",
  ),
  hunk(
    "packages/core/src/embedding.ts",
    '@@ -1,4 +1,4 @@\n-export { embed } from "./embedding-legacy";\n+export { embed } from "./embedding/runtime";',
  ),
];

const largeHeldOutHunk = hunk(
  "packages/core/src/embedding/large-refactor.ts",
  `@@ -1,2 +1,2 @@\n-${"old implementation line ".repeat(2_200)}\n+${"new implementation line ".repeat(2_200)}`,
);

const heldOutTerminationHunks: DiffHunk[] = [
  hunk(
    "packages/cli/src/runtime.ts",
    "@@ -204,6 +204,7 @@ async function runWorker()\n-  await worker.start();\n+  installProcessTerminationHook(worker.stop);\n+  await worker.start();",
  ),
  hunk(
    "packages/cli/src/termination.ts",
    '@@ -1,2 +1,5 @@\n+export function installProcessTerminationHook(stop) {\n+  process.once("SIGTERM", () => void stop());\n+}',
  ),
];

const heldOutReplacementHunks: DiffHunk[] = [
  hunk(
    "packages/api/src/session-replacement.ts",
    "@@ -52,7 +52,4 @@ export async function replaceSession(request)\n-  await authorizeReplacement(request.session);\n-  return executeReplacement(request);\n+  return executeReplacement(request);",
  ),
  hunk(
    "packages/api/test/session-replacement.test.ts",
    '@@ -18,4 +18,4 @@ it("replaces an authorized session", async () => {\n-  await replaceSession(authorized);\n+  await replaceSession(request);',
  ),
];

type ReplayFixtureDefinition = Omit<SemanticLintReplayCase, "integrity">;

const FIXTURE_DEFINITIONS: readonly ReplayFixtureDefinition[] = [
  {
    id: "labeled-pr-1766-relocated-temporal-gate",
    name: "PR #1766 relocated the temporal gate into core",
    split: "labeled",
    label: "context-fp",
    revision: {
      source: "BYK/loreai#1766",
      base: "7092beefbb73c3fa0342dd34080ad405843f182a",
      head: "fe39795ab783f97beb75beea53790334e62df6ca",
      kind: "exact-diff",
      evidence: [
        {
          file: "packages/core/src/embedding/backfill.ts",
          text: lockedPr1766BackfillDiff,
        },
        {
          file: "packages/gateway/src/pipeline.ts",
          text: lockedPr1766PipelineHunk,
        },
      ],
    },
    invariant: relocatedGateInvariant,
    hunks: relocatedGateHunks,
    seedHunkIndex: 1,
    tags: ["known-fp", "relocation", "same-invariant", "connected-context"],
    recorded: {
      isolated: judge(
        "violates",
        "The old gateway gate is absent from the changed pipeline hunk.",
        { inputTokens: 1_960, outputTokens: 104, latencyMs: 52 },
      ),
      holistic: holisticJudge(
        "inv-temporal-recall-gate",
        "satisfies",
        "The complete diff shows the gate moved to the core backfill boundary.",
        { inputTokens: 5_420, outputTokens: 144, latencyMs: 78 },
      ),
      adaptive: relocatedGateAdaptive,
    },
  },
  {
    id: "labeled-pr-1768-intentional-lifecycle-change",
    name: "PR #1768 intentional lifecycle baseline change",
    split: "labeled",
    label: "true-violation",
    revision: {
      source: "BYK/loreai#1768",
      base: "11cfe10bae21371461afd14a83c86f688950caa4",
      head: "dd93fea67f3858c37c5bf710bcf6ebd52d9ad459",
      kind: "exact-diff",
      evidence: [
        { file: "packages/opencode/src/index.ts", text: lockedPr1768IndexDiff },
      ],
    },
    invariant: lifecycleInvariant,
    hunks: lifecycleHunks,
    seedHunkIndex: 0,
    tags: ["intentional-baseline-change", "lifecycle", "sigterm"],
    recorded: {
      isolated: judge(
        "violates",
        "The per-workspace lifecycle owner was removed.",
        { inputTokens: 1_740, outputTokens: 102, latencyMs: 51 },
      ),
      holistic: holisticJudge(
        "inv-embedded-gateway-lifecycle",
        "violates",
        "The new process-level SIGTERM handler does not preserve the old disposal contract.",
        { inputTokens: 4_880, outputTokens: 151, latencyMs: 73 },
      ),
      adaptive: {
        firstPass: judge(
          "violates",
          "The previous lifecycle ownership contract is intentionally changed.",
          { inputTokens: 1_680, outputTokens: 93, latencyMs: 49 },
        ),
        verifier: verifier(
          "confirmed",
          "The connected internal helper confirms the new shutdown semantics are a baseline-rule change.",
          { inputTokens: 2_540, outputTokens: 136, latencyMs: 67 },
        ),
      },
    },
  },
  {
    id: "labeled-mutant-remove-replacement-guard",
    name: "Mutant: remove the replacement authentication guard",
    split: "labeled",
    label: "true-violation",
    revision: {
      source: "controlled-mutant:replacement-guard",
      base: "fe39795ab783f97beb75beea53790334e62df6ca",
      head: "mutant-remove-replacement-guard-v1",
      kind: "synthetic",
    },
    invariant: replacementInvariant,
    hunks: replacementHunks,
    seedHunkIndex: 0,
    tags: ["controlled-mutant", "guard-removal", "security"],
    mutation: {
      id: "remove-replacement-guard",
      parentCaseId: "labeled-pr-1766-relocated-temporal-gate",
      ancestry: "derived",
      description:
        "Delete the replacement guard while retaining the dispatch call.",
    },
    recorded: {
      isolated: judge(
        "violates",
        "The replacement dispatch bypasses authentication.",
      ),
      holistic: holisticJudge(
        "inv-replacement-guard",
        "violates",
        "No connected hunk restores the removed replacement guard.",
        { inputTokens: 4_220, outputTokens: 128, latencyMs: 65 },
      ),
      adaptive: {
        firstPass: judge("violates", "The replacement call is now direct."),
        verifier: verifier(
          "confirmed",
          "Connected context contains no replacement authentication guard.",
        ),
      },
    },
  },
  {
    id: "labeled-safe-embedding-extraction",
    name: "Safe embedding extraction preserves the facade boundary",
    split: "labeled",
    label: "clean-change",
    revision: {
      source: "synthetic-replay:embedding-extraction",
      base: "fe39795ab783f97beb75beea53790334e62df6ca",
      head: "synthetic-safe-extraction-v1",
      kind: "synthetic",
    },
    invariant: extractionInvariant,
    hunks: extractionHunks,
    seedHunkIndex: 0,
    tags: ["clean", "refactor", "facade"],
    recorded: {
      isolated: judge(
        "satisfies",
        "The extracted runtime still uses the provider boundary.",
        { cacheReadTokens: 240, cacheWriteTokens: 120 },
      ),
      holistic: holisticJudge(
        "inv-embedding-facade",
        "satisfies",
        "The complete refactor preserves the public embedding facade.",
        { inputTokens: 3_820, outputTokens: 132, latencyMs: 59 },
      ),
      adaptive: {
        firstPass: judge(
          "satisfies",
          "The provider boundary is still present.",
        ),
      },
    },
  },
  {
    id: "labeled-connected-test-pair-clears-fp",
    name: "Connected test-pair context clears a moved guard false positive",
    split: "labeled",
    label: "context-fp",
    revision: {
      source: "synthetic-replay:connected-test-pair",
      base: "fe39795ab783f97beb75beea53790334e62df6ca",
      head: "synthetic-connected-test-pair-v1",
      kind: "synthetic",
    },
    invariant: replacementInvariant,
    hunks: [
      hunk(
        "packages/gateway/src/requests/replacement.ts",
        "@@ -40,5 +40,5 @@ export async function replaceRequest(request)\n-  return dispatchReplacement(request);\n+  return dispatchReplacementThroughGuard(request);",
      ),
      hunk(
        "packages/gateway/test/replacement.test.ts",
        '@@ -10,3 +10,5 @@ it("replacement is authenticated", async () => {\n+  expect(replacementGuard).toHaveBeenCalled();\n+  await replaceRequest(authenticated);',
      ),
    ],
    seedHunkIndex: 0,
    tags: ["known-fp-class", "test-pair", "connected-context"],
    recorded: {
      isolated: judge(
        "violates",
        "The seed hunk does not show the guard assertion.",
      ),
      holistic: holisticJudge(
        "inv-replacement-guard",
        "satisfies",
        "The changed test confirms the replacement guard remains active.",
        { inputTokens: 3_460, outputTokens: 126, latencyMs: 57 },
      ),
      adaptive: {
        firstPass: judge(
          "violates",
          "The seed hunk appears to bypass the guard.",
        ),
        verifier: verifier(
          "cleared",
          "The connected test pair confirms the guard is still exercised.",
        ),
      },
    },
  },
  {
    id: "heldout-relocated-sigterm-helper",
    name: "Held-out relocation of SIGTERM helper",
    split: "held-out",
    label: "context-fp",
    revision: {
      source: "synthetic-held-out:relocated-sigterm",
      base: "synthetic-worker-runtime-baseline-v1",
      head: "synthetic-heldout-sigterm-v1",
      kind: "synthetic",
    },
    invariant: heldOutTerminationInvariant,
    hunks: heldOutTerminationHunks,
    seedHunkIndex: 0,
    tags: ["held-out", "relocation", "connected-context"],
    recorded: {
      isolated: judge(
        "violates",
        "The worker is started without the process termination hook in the seed.",
      ),
      holistic: holisticJudge(
        "inv-process-worker-termination-hook",
        "satisfies",
        "The companion termination module preserves the worker shutdown hook.",
        { inputTokens: 3_980, outputTokens: 137, latencyMs: 63 },
      ),
      adaptive: {
        firstPass: judge(
          "violates",
          "The worker start path does not show the termination hook.",
        ),
        verifier: verifier(
          "cleared",
          "The connected helper installs the process-level worker stop hook.",
        ),
      },
    },
  },
  {
    id: "heldout-remove-replacement-guard",
    name: "Held-out replacement guard mutant",
    split: "held-out",
    label: "true-violation",
    revision: {
      source: "controlled-mutant:replacement-guard-held-out",
      base: "synthetic-session-replacement-baseline-v1",
      head: "mutant-remove-session-authorization-v1",
      kind: "synthetic",
    },
    invariant: heldOutReplacementInvariant,
    hunks: heldOutReplacementHunks,
    seedHunkIndex: 0,
    tags: ["held-out", "controlled-mutant", "guard-removal"],
    mutation: {
      id: "remove-session-authorization-held-out",
      parentCaseId: "synthetic-session-replacement-baseline-v1",
      ancestry: "independent",
      description:
        "Independently remove the session authorization guard before execution.",
    },
    recorded: {
      isolated: judge(
        "violates",
        "The session replacement executes without authorization.",
      ),
      holistic: holisticJudge(
        "inv-session-replacement-authorization",
        "violates",
        "The authorization guard is absent from the complete diff.",
        {
          inputTokens: 4_060,
          outputTokens: 130,
          latencyMs: 62,
        },
      ),
      adaptive: {
        firstPass: judge("violates", "The session replacement call is direct."),
        verifier: verifier(
          "confirmed",
          "No connected hunk restores session authorization.",
        ),
      },
    },
  },
  {
    id: "heldout-large-clean-refactor",
    name: "Held-out large clean refactor exceeds holistic budget",
    split: "held-out",
    label: "clean-change",
    revision: {
      source: "synthetic-held-out:large-clean-refactor",
      base: "synthetic-storage-facade-baseline-v1",
      head: "synthetic-large-clean-v1",
      kind: "synthetic",
    },
    invariant: heldOutExtractionInvariant,
    hunks: [largeHeldOutHunk],
    seedHunkIndex: 0,
    tags: ["held-out", "large-pr", "budget-boundary"],
    recorded: {
      isolated: judge(
        "satisfies",
        "The large replacement keeps the persistence provider boundary.",
        {
          inputTokens: 5_900,
          outputTokens: 110,
          latencyMs: 83,
        },
      ),
      holistic: holisticJudge(
        "inv-storage-facade",
        "satisfies",
        "The complete storage diff is clean.",
        {
          inputTokens: 21_000,
          outputTokens: 120,
          latencyMs: 110,
        },
      ),
      adaptive: {
        firstPass: judge(
          "satisfies",
          "The bounded seed remains within the persistence provider boundary.",
          {
            inputTokens: 5_800,
            outputTokens: 102,
            latencyMs: 79,
          },
        ),
      },
    },
  },
];

export const SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS = {
  "labeled-pr-1766-relocated-temporal-gate": {
    inputSha256:
      "5d45e7cb06f628d0ff94ee44c7edee238913af8367c7a93b7703d94ef5fbd5f3",
    traceSha256:
      "ae0e2ffc78bf347861d87950180759a45904a6456072b546df65ad625555ba10",
  },
  "labeled-pr-1768-intentional-lifecycle-change": {
    inputSha256:
      "8ac3f1151e37593cada1db3985f52fdde040ecb230bf3b64c5f86c027568c963",
    traceSha256:
      "4dab2ee1649e61cc5617f83d7df0316b8b37bc5cde03b30e6b8afc75647563fc",
  },
  "labeled-mutant-remove-replacement-guard": {
    inputSha256:
      "4cdc8d2ceba90a7eb869897624f1d6e81c772af5d3ed0ac2b97d6c8331224a27",
    traceSha256:
      "58812407334374356d06e1831282bdbf4ae8ea373b0d6624b595a79d4cd68348",
  },
  "labeled-safe-embedding-extraction": {
    inputSha256:
      "704885128c4f5565e0015474f4e019bf2ad2c7238c3f18d5042f7a3594e59e9d",
    traceSha256:
      "571bfedafaba4741a86de996fa7d4359b236ea26efec689911bc2b0eccd85402",
  },
  "labeled-connected-test-pair-clears-fp": {
    inputSha256:
      "b77d1e2b26e8062d32e2d3e09984631198d77c4e0072499b8c73b5b84126d52d",
    traceSha256:
      "2ad9cbae3832cbe8cd8f9485a643eb6e7003268224651c0cdf75e97212e2e856",
  },
  "heldout-relocated-sigterm-helper": {
    inputSha256:
      "e98708521ea689be5fdaba2dafccbe881f9bd56d0f88ba8dd8027ed02924d82d",
    traceSha256:
      "52f035e3d65018ebbc8f68b7c220c7450ad2dfd749473c3277363fd402a9d12e",
  },
  "heldout-remove-replacement-guard": {
    inputSha256:
      "0ce48e303e26825adbb5e595339922f1c5817615020add669675320d02daa2b0",
    traceSha256:
      "2176aa6b52cc16f8988fe09e4e195bb9b0df01b6fb784460b61dce662db27992",
  },
  "heldout-large-clean-refactor": {
    inputSha256:
      "f815e785ef5786b010b47818180ecc1940043380505a6673f9c5541328a3f393",
    traceSha256:
      "992fddbd0d0189709c3c2edfb3a097118b277ba30001a47bb0225c35b74efa11",
  },
} as const;

export const SEMANTIC_LINT_REPLAY_FIXTURES: readonly SemanticLintReplayCase[] =
  FIXTURE_DEFINITIONS.map((item) => ({
    ...item,
    integrity:
      SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS[
        item.id as keyof typeof SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS
      ],
  }));

export function getSemanticLintReplayFixtures(): readonly SemanticLintReplayCase[] {
  return SEMANTIC_LINT_REPLAY_FIXTURES;
}
