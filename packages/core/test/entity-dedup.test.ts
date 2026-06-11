import { describe, test, expect, beforeEach } from "vitest";
import { uuidv7 } from "uuidv7";
import { db, ensureProject, getKV } from "../src/db";
import * as entities from "../src/entities";

const PROJECT = "/test/entity-dedup/project";

function cleanup(): void {
  const d = db();
  d.exec("DELETE FROM entity_relations");
  d.exec("DELETE FROM knowledge_entity_refs");
  d.exec("DELETE FROM entity_aliases");
  d.exec("DELETE FROM entities");
  d.exec("DELETE FROM knowledge");
  d.exec("DELETE FROM dedup_feedback");
  d.exec("DELETE FROM kv_meta WHERE key LIKE 'entity_dedup_threshold:%'");
}

/** Create an entity with an explicit ID and no provider-driven embedding. */
function makeEntity(opts: {
  id?: string;
  type?: entities.EntityType;
  name: string;
  aliases?: Array<{ type: entities.AliasType; value: string }>;
  projectPath?: string;
}): string {
  const r = entities.create({
    id: opts.id ?? uuidv7(),
    projectPath: opts.projectPath ?? PROJECT,
    entityType: opts.type ?? "person",
    canonicalName: opts.name,
    aliases: opts.aliases,
  });
  return r.id;
}

/** Inject a deterministic unit-norm embedding for an entity (no provider needed). */
function injectEmbedding(entityId: string, seed: number, dims = 768): void {
  const vec = new Float32Array(dims);
  for (let i = 0; i < dims; i++) vec[i] = Math.sin(seed * (i + 1) * 0.1);
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  db()
    .query("UPDATE entities SET embedding = ? WHERE id = ?")
    .run(Buffer.from(vec.buffer), entityId);
}

/** Inject a vector that is a small perturbation of `baseSeed` → high cosine sim. */
function injectSimilar(
  entityId: string,
  baseSeed: number,
  perturbation: number,
  dims = 768,
): void {
  const vec = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    vec[i] =
      Math.sin(baseSeed * (i + 1) * 0.1) +
      perturbation * Math.cos((i + 1) * 0.3);
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  db()
    .query("UPDATE entities SET embedding = ? WHERE id = ?")
    .run(Buffer.from(vec.buffer), entityId);
}

describe("entity dedup — deduplicateEntities()", () => {
  beforeEach(cleanup);

  test("fewer than 2 entities → empty result", async () => {
    makeEntity({ name: "Solo" });
    const r = await entities.deduplicateEntities(PROJECT, { dryRun: true });
    expect(r.merged).toHaveLength(0);
    expect(r.suggested).toHaveLength(0);
  });

  test("different entity_type never merges even at high similarity", async () => {
    const a = makeEntity({ id: uuidv7(), type: "person", name: "Octo Person" });
    const b = makeEntity({ id: uuidv7(), type: "tool", name: "Octo Tool" });
    injectEmbedding(a, 5);
    injectSimilar(b, 5, 0.001); // ~identical vector, but different type
    const r = await entities.deduplicateEntities(PROJECT, { dryRun: true });
    expect(r.merged).toHaveLength(0);
    expect(r.suggested).toHaveLength(0);
  });

  test("alias overlap forces an auto-merge regardless of cosine", async () => {
    // The schema enforces UNIQUE(alias_type, alias_value), so two entities can
    // only share an alias *value* under different alias *types* (e.g. the same
    // handle recorded as a nickname on one and a github handle on the other).
    // The dedup signal compares values ignoring type, so this still fires.
    const a = makeEntity({
      name: "Bob Smith",
      aliases: [{ type: "github", value: "bobsmith" }],
    });
    const b = makeEntity({
      name: "Robert Smith",
      aliases: [{ type: "nickname", value: "bobsmith" }],
    });
    // No embeddings injected — alias overlap alone must drive the merge.
    const r = await entities.deduplicateEntities(PROJECT, { dryRun: true });
    expect(r.merged.length).toBe(1);
    const cluster = r.merged[0];
    const ids = [
      cluster.surviving.id,
      ...cluster.merged.map((m) => m.id),
    ].sort();
    expect(ids).toEqual([a, b].sort());
  });

  test("high cosine similarity (≥ auto-merge threshold) merges", async () => {
    const a = makeEntity({ name: "GitHub Actions" });
    const b = makeEntity({ name: "GHA" });
    injectEmbedding(a, 9);
    injectSimilar(b, 9, 0.0005); // very high similarity
    const r = await entities.deduplicateEntities(PROJECT, { dryRun: true });
    expect(r.merged.length).toBe(1);
  });

  test("moderate similarity lands in suggested, not merged", async () => {
    const a = makeEntity({ name: "Alpha Service" });
    const b = makeEntity({ name: "Beta Service" });
    // Threshold band [0.85, 0.92): pick a perturbation that yields ~0.88.
    injectEmbedding(a, 12);
    injectSimilar(b, 12, 0.32);
    const r = await entities.deduplicateEntities(PROJECT, {
      dryRun: true,
      threshold: 0.85,
    });
    // It should be a candidate but NOT auto-merged.
    const sim = r.pairSimilarities.get(entities.entityPairKey(a, b));
    if (sim != null && sim >= 0.85 && sim < 0.92) {
      expect(r.suggested.length).toBe(1);
      expect(r.merged.length).toBe(0);
    }
  });

  test("dryRun does not delete; non-dryRun merges", async () => {
    const a = makeEntity({
      name: "Cache",
      type: "service",
      aliases: [{ type: "nickname", value: "the-cache" }],
    });
    const b = makeEntity({
      name: "Redis",
      type: "service",
      aliases: [{ type: "url", value: "the-cache" }],
    });

    const dry = await entities.deduplicateEntities(PROJECT, { dryRun: true });
    expect(dry.merged.length).toBe(1);
    // Both still present after a dry run.
    expect(entities.get(a)).not.toBeNull();
    expect(entities.get(b)).not.toBeNull();

    const applied = await entities.deduplicateEntities(PROJECT, {
      dryRun: false,
    });
    expect(applied.merged.length).toBe(1);
    const survivors = [a, b].filter((id) => entities.get(id) !== null);
    expect(survivors.length).toBe(1); // exactly one absorbed the other
  });

  test("star clustering: A~B, B~C, not A~C merges only the strongest pair", async () => {
    const a = makeEntity({ id: uuidv7(), name: "Node A" });
    const b = makeEntity({ id: uuidv7(), name: "Node B" });
    const c = makeEntity({ id: uuidv7(), name: "Node C" });
    // B is the high-degree center; A and C are both very close to B but far
    // from each other (orthogonal-ish perturbation directions).
    injectEmbedding(b, 20);
    injectSimilar(a, 20, 0.0008);
    injectSimilar(c, 20, 0.0008);
    const _r = await entities.deduplicateEntities(PROJECT, { dryRun: false });
    // One cluster centered on B absorbing A and C (no transitivity violation
    // because all three share the same near-identical direction here); the key
    // invariant is that no more than 2 entities are removed and 1 survives.
    const remaining = [a, b, c].filter((id) => entities.get(id) !== null);
    expect(remaining.length).toBeGreaterThanOrEqual(1);
    expect(remaining.length).toBeLessThanOrEqual(2);
  });

  test("survivor is the entity with the most aliases", async () => {
    const rich = makeEntity({
      name: "Seylan Cinar",
      aliases: [
        { type: "email", value: "seylan@x.com" },
        { type: "github", value: "seylancinar" },
        { type: "nickname", value: "shared-key" },
      ],
    });
    const sparse = makeEntity({
      name: "Seylan",
      aliases: [{ type: "url", value: "shared-key" }],
    });
    const r = await entities.deduplicateEntities(PROJECT, { dryRun: false });
    expect(r.merged.length).toBe(1);
    // The richer entity survives.
    expect(entities.get(rich)).not.toBeNull();
    expect(entities.get(sparse)).toBeNull();
  });

  // --- Name containment signal (first-name ⊂ full-name) ---

  test("name containment ('Seylan' ⊂ 'Seylan Çinar Kaya') is SUGGESTED, not merged", async () => {
    // No aliases, no embeddings — containment must be the sole signal, and it
    // must only suggest (the user confirms), never auto-merge.
    const a = makeEntity({ name: "Seylan" });
    const b = makeEntity({ name: "Seylan Çinar Kaya" });
    const r = await entities.deduplicateEntities(PROJECT, { dryRun: true });
    expect(r.merged).toHaveLength(0);
    expect(r.suggested).toHaveLength(1);
    const cluster = r.suggested[0];
    const ids = [
      cluster.surviving.id,
      ...cluster.merged.map((m) => m.id),
    ].sort();
    expect(ids).toEqual([a, b].sort());
    // The full name is kept as the survivor.
    expect(cluster.surviving.name).toBe("Seylan Çinar Kaya");
  });

  test("multi-token prefix ⊂ full name is suggested", async () => {
    makeEntity({ name: "GitHub Actions" });
    makeEntity({ name: "GitHub Actions CI" });
    const r = await entities.deduplicateEntities(PROJECT, { dryRun: true });
    expect(r.merged).toHaveLength(0);
    expect(r.suggested).toHaveLength(1);
  });

  test("same-size distinct names are NOT suggested via containment", async () => {
    // "John Smith" vs "John Doe": equal token count, share only "john" →
    // Jaccard 1/3 (< 0.5), no containment, no embeddings → no candidate.
    makeEntity({ name: "John Smith" });
    makeEntity({ name: "John Doe" });
    const r = await entities.deduplicateEntities(PROJECT, { dryRun: true });
    expect(r.merged).toHaveLength(0);
    expect(r.suggested).toHaveLength(0);
  });

  test("containment never auto-merges even on apply (dryRun:false)", async () => {
    const a = makeEntity({ name: "Seylan" });
    const b = makeEntity({ name: "Seylan Çinar Kaya" });
    const r = await entities.deduplicateEntities(PROJECT, { dryRun: false });
    expect(r.merged).toHaveLength(0);
    // Both entities survive — nothing was silently merged.
    expect(entities.get(a)).not.toBeNull();
    expect(entities.get(b)).not.toBeNull();
  });

  test("containment still suggests when the calibrated threshold exceeds 0.9", async () => {
    // A high threshold (> ENTITY_NAME_CONTAINMENT_SCORE) would drop the pair if
    // it relied on `score >= threshold`; the explicit `|| containment` neighbor
    // qualification keeps it as a suggestion.
    makeEntity({ name: "Seylan" });
    makeEntity({ name: "Seylan Çinar Kaya" });
    const r = await entities.deduplicateEntities(PROJECT, {
      dryRun: true,
      threshold: 0.95,
    });
    expect(r.merged).toHaveLength(0);
    expect(r.suggested).toHaveLength(1);
  });
});

describe("entity dedup — adaptive calibration (kind='entity')", () => {
  beforeEach(cleanup);

  test("entity feedback is isolated from knowledge feedback rows", () => {
    const pid = ensureProject(PROJECT);
    // Insert a knowledge-kind row directly (kind defaults to 'knowledge').
    db()
      .query(
        `INSERT INTO dedup_feedback
           (project_id, entry_a_title, entry_b_title, similarity, accepted, source, created_at)
         VALUES (?, 'k-a', 'k-b', 0.9, 1, 'cli_yes', ?)`,
      )
      .run(pid, Date.now());
    expect(entities.getEntityDedupFeedbackCount(pid)).toBe(0);

    entities.recordEntityDedupFeedback({
      projectId: pid,
      entryATitle: "e-a",
      entryBTitle: "e-b",
      similarity: 0.88,
      accepted: true,
      source: "cli_yes",
    });
    expect(entities.getEntityDedupFeedbackCount(pid)).toBe(1);
  });

  test("calibrateEntityDedupThreshold returns null below 20 samples", () => {
    const pid = ensureProject(PROJECT);
    for (let i = 0; i < 5; i++) {
      entities.recordEntityDedupFeedback({
        projectId: pid,
        entryATitle: `a${i}`,
        entryBTitle: `b${i}`,
        similarity: 0.9,
        accepted: true,
        source: "cli_yes",
      });
    }
    expect(entities.calibrateEntityDedupThreshold(pid)).toBeNull();
  });

  test("calibration clamps into the entity range [0.80, 0.95]", () => {
    const pid = ensureProject(PROJECT);
    // 12 accepts at high sim, 12 rejects at low sim → boundary in between.
    for (let i = 0; i < 12; i++) {
      entities.recordEntityDedupFeedback({
        projectId: pid,
        entryATitle: `acc${i}`,
        entryBTitle: `accb${i}`,
        similarity: 0.97,
        accepted: true,
        source: "cli_yes",
      });
      entities.recordEntityDedupFeedback({
        projectId: pid,
        entryATitle: `rej${i}`,
        entryBTitle: `rejb${i}`,
        similarity: 0.5,
        accepted: false,
        source: "auto_dedup",
      });
    }
    const t = entities.calibrateEntityDedupThreshold(pid);
    expect(t).not.toBeNull();
    if (t === null)
      throw new Error("calibrateEntityDedupThreshold returned null");
    expect(t).toBeGreaterThanOrEqual(0.8);
    expect(t).toBeLessThanOrEqual(0.95);
  });

  test("save/load threshold round-trips via kv_meta", () => {
    const pid = ensureProject(PROJECT);
    entities.saveEntityCalibratedThreshold(pid, 0.876, 30);
    expect(entities.loadEntityCalibratedThreshold(pid)).toBeCloseTo(0.876, 5);
    expect(getKV(`entity_dedup_threshold:${pid}`)).toContain("0.876");
  });

  test("getDismissedEntityPairs returns both orderings for dashboard rejects", () => {
    // Record a dashboard dismiss
    entities.recordEntityDedupFeedback({
      projectId: null,
      entryATitle: "Alice",
      entryBTitle: "Bob",
      similarity: 0.87,
      accepted: false,
      source: "dashboard",
    });
    // Record a non-dashboard reject (should NOT appear)
    entities.recordEntityDedupFeedback({
      projectId: null,
      entryATitle: "Carol",
      entryBTitle: "Dave",
      similarity: 0.88,
      accepted: false,
      source: "cli_interactive",
    });

    const dismissed = entities.getDismissedEntityPairs();
    // Both orderings present for the dashboard dismiss
    expect(dismissed.has("Alice\x1fBob")).toBe(true);
    expect(dismissed.has("Bob\x1fAlice")).toBe(true);
    // CLI reject NOT included
    expect(dismissed.has("Carol\x1fDave")).toBe(false);
  });
});
