import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import {
  _restoreProvider,
  _saveAndClearProvider,
  backfillDistillationEmbeddings,
  backfillEmbeddings,
  checkConfigChange,
  backfillEntityEmbeddings,
  embedDistillation,
  embedEntity,
  embedKnowledgeEntry,
  EmbeddingAbortError,
  EmbeddingQueueCapacityError,
  fromBlob,
  backfillIndexRevision,
  settleDocumentEmbeds,
} from "../src/embedding";
import * as ltm from "../src/ltm";
import { storeEmbedding } from "../src/db/vec-store";
import { currentTenantId } from "../src/tenant";
import * as log from "../src/log";

const PROJECT = "/test/embedding-backfill";

function unit(v: number[]): Float32Array {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return new Float32Array(v.map((x) => x / n));
}

const VEC = unit([1, 0, 0]);

// A mock provider returning one fixed unit vector per input text. The real local
// ONNX provider isn't available in CI, so without this stub the backfill loops
// short-circuit at `getProvider()`/`embed()` and their write path —
// `storeEmbedding(db(), <table>, …)` in embedding.ts — is never exercised. This
// drives the real production backfill end-to-end and asserts the BLOB lands.
function installMockProvider(): unknown {
  const token = _saveAndClearProvider();
  _restoreProvider({
    provider: {
      maxBatchSize: 8,
      async embed(texts: string[], _inputType: "document" | "query") {
        return texts.map(() => VEC);
      },
    },
  });
  return token;
}

describe("backfill writes embeddings through storeEmbedding (blob layout)", () => {
  let token: unknown;
  let pid: string;

  beforeEach(() => {
    pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge").run();
    db().query("DELETE FROM distillations").run();
    db().query("DELETE FROM entities").run();
    db().query("DELETE FROM kv_meta WHERE key LIKE 'lore:%'").run();
    token = installMockProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _restoreProvider(token);
  });

  function embeddingOf(table: string, id: string): Buffer | null {
    const row = db()
      .query(`SELECT embedding FROM ${table} WHERE id = ?`)
      .get(id) as { embedding: Buffer | null } | null;
    return row?.embedding ?? null;
  }

  test("backfillEmbeddings populates knowledge.embedding", async () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES ('bk', ?, 'test', 'T', 'C', ?, ?, 'bk')",
      )
      .run(pid, now, now);
    expect(embeddingOf("knowledge", "bk")).toBeNull();

    const n = await backfillEmbeddings();

    expect(n).toBe(1);
    const blob = embeddingOf("knowledge", "bk");
    expect(blob).not.toBeNull();
    expect(Array.from(fromBlob(blob as Buffer))).toEqual(Array.from(VEC));
  });

  test("coalesces index-only selection refreshes during a document backfill", async () => {
    checkConfigChange();
    const now = Date.now();
    for (let i = 0; i < 9; i++) {
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'test', ?, 'content', ?, ?, ?)",
        )
        .run(`coalesce-${i}`, pid, `title-${i}`, now, now, `coalesce-${i}`);
    }
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES ('indexed', ?, 'test', 'indexed', 'content', ?, ?, 'indexed')",
      )
      .run(pid, now, now);
    storeEmbedding(db(), "knowledge", "indexed", VEC);
    const accepted = ltm.selectionRevision(PROJECT);
    const unrelated = `/test/unrelated-backfill-${crypto.randomUUID()}`;
    const unrelatedId = crypto.randomUUID();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'gotcha', 'Unrelated late vector', 'An independent project remains fresh', ?, ?, ?)",
      )
      .run(unrelatedId, ensureProject(unrelated), now, now, unrelatedId);
    storeEmbedding(db(), "knowledge", unrelatedId, VEC);
    const unrelatedBefore = ltm.selectionRevision(unrelated);
    let duringFirstBatch = "";
    let batches = 0;
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          const current = ltm.selectionRevision(PROJECT);
          expect(current).toBe(accepted);
          if (batches++ === 0) {
            duringFirstBatch = current;
            storeEmbedding(db(), "knowledge", unrelatedId, VEC);
            expect(ltm.selectionRevision(unrelated)).not.toBe(unrelatedBefore);
          } else {
            expect(current).toBe(duringFirstBatch);
            storeEmbedding(db(), "knowledge", "indexed", VEC);
            expect(ltm.selectionRevision(PROJECT)).not.toBe(duringFirstBatch);
          }
          return texts.map(() => VEC);
        },
      },
    });

    expect(await backfillEmbeddings()).toBe(9);
    expect(batches).toBe(2);
    expect(
      backfillIndexRevision("knowledge", `${currentTenantId()}\0${pid}`, -1, 0),
    ).toBe(-1);
    expect(ltm.selectionRevision(PROJECT)).not.toBe(duringFirstBatch);
  });

  test("backfillEmbeddings stops scheduling batches and throws a typed abort", async () => {
    const now = Date.now();
    for (let i = 0; i < 9; i++) {
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'test', ?, 'content', ?, ?, ?)",
        )
        .run(`abort-${i}`, pid, `title-${i}`, now, now, `abort-${i}`);
    }

    const controller = new AbortController();
    const batchSizes: number[] = [];
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          batchSizes.push(texts.length);
          controller.abort(new Error("lint deadline elapsed"));
          return texts.map(() => VEC);
        },
      },
    });

    const error = await backfillEmbeddings({
      signal: controller.signal,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(EmbeddingAbortError);
    expect(error).toMatchObject({
      code: "aborted",
      phase: "knowledge-backfill",
    });
    expect(batchSizes).toEqual([8]);
  });

  test("backfillDistillationEmbeddings populates distillations.embedding", async () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES ('bd', ?, 's', '', '', 'some observation text', '', 0, 0, ?, 0)",
      )
      .run(pid, now);
    expect(embeddingOf("distillations", "bd")).toBeNull();

    const n = await backfillDistillationEmbeddings();

    expect(n).toBe(1);
    const blob = embeddingOf("distillations", "bd");
    expect(blob).not.toBeNull();
    expect(Array.from(fromBlob(blob as Buffer))).toEqual(Array.from(VEC));
  });

  test("distillation backfill coalesces its own writes but exposes live vectors", async () => {
    checkConfigChange();
    const now = Date.now();
    const insert = db().query(
      "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES (?, ?, 's', '', '', 'observation', '', 0, 0, ?, 0)",
    );
    for (let i = 0; i < 9; i++) insert.run(`distill-${i}`, pid, now);
    insert.run("distill-indexed", pid, now);
    storeEmbedding(db(), "distillations", "distill-indexed", VEC);
    const revision = () => ltm.selectionRevision(PROJECT, ["distillation"]);
    const accepted = revision();
    let batches = 0;
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          expect(revision()).toBe(accepted);
          if (++batches === 2) {
            storeEmbedding(db(), "distillations", "distill-indexed", VEC);
            expect(revision()).not.toBe(accepted);
          }
          return texts.map(() => VEC);
        },
      },
    });
    expect(await backfillDistillationEmbeddings()).toBe(9);
    expect(batches).toBe(2);
    expect(revision()).not.toBe(accepted);
  });

  test("backfillEntityEmbeddings populates entities.embedding", async () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES ('be', ?, 'tool', 'Entity', 0, ?, ?)",
      )
      .run(pid, now, now);
    expect(embeddingOf("entities", "be")).toBeNull();

    const n = await backfillEntityEmbeddings();

    expect(n).toBe(1);
    const blob = embeddingOf("entities", "be");
    expect(blob).not.toBeNull();
    expect(Array.from(fromBlob(blob as Buffer))).toEqual(Array.from(VEC));
  });

  test("fire-and-forget writes suppress expected queue backpressure", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const providerEmbed = vi.fn(async () => {
      throw new EmbeddingQueueCapacityError();
    });
    _restoreProvider({
      provider: { maxBatchSize: 8, embed: providerEmbed },
    });

    embedKnowledgeEntry("capacity-k", "title", "content");
    embedDistillation("capacity-d", "observations");
    embedEntity("capacity-e", "entity", ["alias"]);
    await settleDocumentEmbeds();

    expect(providerEmbed).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
  });

  test("every sequential backfill stops at its first queue-capacity failure", async () => {
    const now = Date.now();
    for (let i = 0; i < 9; i++) {
      const longText = `${i}-${"x".repeat(9_000)}`;
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'test', ?, ?, ?, ?, ?)",
        )
        .run(
          `capacity-k-${i}`,
          pid,
          `title-${i}`,
          longText,
          now,
          now,
          `capacity-k-${i}`,
        );
      db()
        .query(
          "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES (?, ?, 's', '', '', ?, '', 0, 0, ?, 0)",
        )
        .run(`capacity-d-${i}`, pid, longText, now);
      db()
        .query(
          "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES (?, ?, 'tool', ?, 0, ?, ?)",
        )
        .run(`capacity-e-${i}`, pid, longText, now, now);
    }
    const error = vi.spyOn(log, "error").mockImplementation(() => {});

    for (const backfill of [
      backfillEmbeddings,
      backfillDistillationEmbeddings,
      backfillEntityEmbeddings,
    ]) {
      const providerEmbed = vi.fn(async () => {
        throw new EmbeddingQueueCapacityError();
      });
      _restoreProvider({
        provider: { maxBatchSize: 8, embed: providerEmbed },
      });

      await expect(backfill()).resolves.toBe(0);
      expect(providerEmbed).toHaveBeenCalledOnce();
    }
    expect(error).not.toHaveBeenCalled();
  });
});
