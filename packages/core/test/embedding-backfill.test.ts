import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { close, db, ensureProject } from "../src/db";
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
import { currentTenantId, withTenant } from "../src/tenant";
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

  test("an in-flight document backfill never opens a successor database after close", async () => {
    const originalPath = process.env.LORE_DB_PATH!;
    const successorPath = join(
      process.env.LORE_TEST_DB_ROOT!,
      `${randomUUID()}.db`,
    );
    const now = Date.now();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES ('closed-backfill', ?, 'test', 'T', 'C', ?, ?, 'closed-backfill')",
      )
      .run(pid, now, now);

    let release: (() => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        embed(texts: string[]) {
          return new Promise<Float32Array[]>((resolve) => {
            release = () => resolve(texts.map(() => VEC));
            notifyStarted!();
          });
        },
      },
    });

    const backfill = backfillEmbeddings();
    try {
      await started;
      close();
      process.env.LORE_DB_PATH = successorPath;
      release!();
      const failure = await backfill.then(
        () => null,
        (error: unknown) => error,
      );
      expect(existsSync(successorPath)).toBe(false);
      expect(failure).toBeNull();
    } finally {
      release?.();
      await backfill.catch(() => {});
      close();
      process.env.LORE_DB_PATH = originalPath;
    }
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

  test("never batches different tenants' knowledge, distillations or entities together", async () => {
    checkConfigChange();
    const calls: Array<{ tenant: string; texts: string[] }> = [];
    const sourceReadScopes: string[] = [];
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          calls.push({ tenant: currentTenantId(), texts });
          return texts.map(() => VEC);
        },
      },
    });
    const now = Date.now();
    for (const tenant of ["tenant-a", "tenant-b"]) {
      const project = withTenant(tenant, () =>
        ensureProject(`/test/backfill-${tenant}`),
      );
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, tenant_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, ?, 'test', ?, 'content', ?, ?, ?)",
        )
        .run(
          `k-${tenant}`,
          project,
          tenant,
          `private-${tenant}-knowledge`,
          now,
          now,
          `k-${tenant}`,
        );
      db()
        .query(
          "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES (?, ?, 's', '', '', ?, '', 0, 0, ?, 0)",
        )
        .run(`d-${tenant}`, project, `private-${tenant}-distillation`, now);
      db()
        .query(
          "INSERT INTO entities (id, project_id, tenant_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES (?, ?, ?, 'tool', ?, 0, ?, ?)",
        )
        .run(
          `e-${tenant}`,
          project,
          tenant,
          `private-${tenant}-entity`,
          now,
          now,
        );
    }

    log.registerSink({
      info() {},
      warn() {},
      error() {},
      captureException() {},
      withDbSpan<T>(sql: string, fn: () => T): T {
        if (
          /SELECT k\.id, k\.title, k\.content|SELECT d\.id, d\.observations|SELECT e\.id, e\.canonical_name|SELECT k\.title, k\.content|SELECT d\.observations|SELECT e\.canonical_name/s.test(
            sql,
          )
        )
          sourceReadScopes.push(currentTenantId());
        return fn();
      },
    });
    try {
      expect(await backfillEmbeddings()).toBe(2);
      expect(await backfillDistillationEmbeddings()).toBe(2);
      expect(await backfillEntityEmbeddings()).toBe(2);
    } finally {
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
      });
    }
    expect(sourceReadScopes.length).toBeGreaterThanOrEqual(6);
    expect(sourceReadScopes.every((tenant) => tenant !== "")).toBe(true);
    expect(calls).toHaveLength(6);
    for (const { tenant, texts } of calls) {
      expect(["tenant-a", "tenant-b"]).toContain(tenant);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain(`private-${tenant}-`);
    }
    for (const tenant of ["tenant-a", "tenant-b"]) {
      for (const [table, id] of [
        ["knowledge", `k-${tenant}`],
        ["distillations", `d-${tenant}`],
        ["entities", `e-${tenant}`],
      ]) {
        expect(embeddingOf(table, id)).not.toBeNull();
      }
    }
  });

  test("does not write a vector after its source moves to another tenant during inference", async () => {
    checkConfigChange();
    const ownerA = withTenant("tenant-a", () =>
      ensureProject("/test/backfill-owner-a"),
    );
    const ownerB = withTenant("tenant-b", () =>
      ensureProject("/test/backfill-owner-b"),
    );
    const now = Date.now();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, tenant_id, category, title, content, created_at, updated_at, logical_id) VALUES ('moved-during-inference', ?, 'tenant-a', 'test', 'private-a', 'content', ?, ?, 'moved-during-inference')",
      )
      .run(ownerA, now, now);
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          expect(currentTenantId()).toBe("tenant-a");
          expect(texts).toEqual(["private-a\ncontent"]);
          withTenant("tenant-b", () =>
            db()
              .query(
                "UPDATE knowledge SET project_id = ?, tenant_id = 'tenant-b' WHERE id = 'moved-during-inference'",
              )
              .run(ownerB),
          );
          return [VEC];
        },
      },
    });

    expect(await backfillEmbeddings()).toBe(0);
    expect(embeddingOf("knowledge", "moved-during-inference")).toBeNull();
  });

  test("does not submit a later page item after it changes tenants during an earlier batch", async () => {
    checkConfigChange();
    const ownerA = withTenant("tenant-a", () =>
      ensureProject("/test/backfill-submission-owner-a"),
    );
    const ownerB = withTenant("tenant-b", () =>
      ensureProject("/test/backfill-submission-owner-b"),
    );
    const now = Date.now();
    const insert = db().query(
      "INSERT INTO knowledge (id, project_id, tenant_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'tenant-a', 'test', ?, 'content', ?, ?, ?)",
    );
    for (let i = 0; i < 9; i++) {
      const id = `queued-tenant-${String(i).padStart(2, "0")}`;
      insert.run(id, ownerA, `private-a-${id}`, now, now, id);
    }
    const calls: Array<{ tenant: string; texts: string[] }> = [];
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          calls.push({ tenant: currentTenantId(), texts });
          if (calls.length === 1) {
            withTenant("tenant-b", () =>
              db()
                .query(
                  "UPDATE knowledge SET project_id = ?, tenant_id = 'tenant-b' WHERE id = 'queued-tenant-08'",
                )
                .run(ownerB),
            );
          }
          return texts.map(() => VEC);
        },
      },
    });

    expect(await backfillEmbeddings()).toBe(8);
    expect(calls).toHaveLength(1);
    expect(calls[0].tenant).toBe("tenant-a");
    expect(calls[0].texts).toHaveLength(8);
    expect(embeddingOf("knowledge", "queued-tenant-08")).toBeNull();
  });

  test.each([false, true])(
    "does not replace a live vector after source content changes (moved=%s)",
    async (moved) => {
      checkConfigChange();
      const id = `changed-while-embedding-${moved}`;
      const now = Date.now();
      const destination = ensureProject("/test/backfill-changed-destination");
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'test', 'old', 'content', ?, ?, ?)",
        )
        .run(id, pid, now, now, id);
      const live = unit([0, 1, 0]);
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            expect(texts).toEqual(["old\ncontent"]);
            db()
              .query(
                "UPDATE knowledge SET title = 'new', project_id = ? WHERE id = ?",
              )
              .run(moved ? destination : pid, id);
            storeEmbedding(db(), "knowledge", id, live);
            return [VEC];
          },
        },
      });

      expect(await backfillEmbeddings()).toBe(0);
      expect(
        Array.from(fromBlob(embeddingOf("knowledge", id) as Buffer)),
      ).toEqual(Array.from(live));
    },
  );

  test("keeps private storage failures out of logs and ignores a throwing diagnostic sink", async () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES ('private-failure', ?, 'test', 'Private title', 'Private content', ?, ?, 'private-failure')",
      )
      .run(pid, now, now);
    const privateText = "PRIVATE_BACKFILL_FAILURE_BODY";
    const seen: string[] = [];
    log.registerSink({
      info() {},
      warn() {},
      error(message) {
        seen.push(message);
        throw new Error("diagnostic sink failed");
      },
      captureException() {},
      withDbSpan(sql, fn) {
        if (sql.startsWith("UPDATE knowledge SET embedding"))
          throw new Error(privateText);
        return fn();
      },
    });
    try {
      await expect(backfillEmbeddings()).resolves.toBe(0);
      expect(seen.join(" ")).not.toContain(privateText);
      expect(embeddingOf("knowledge", "private-failure")).toBeNull();
    } finally {
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
      });
    }
  });

  test("does not fail completed document backfill when information logging throws", async () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES ('info-sink', ?, 'test', 'info', 'content', ?, ?, 'info-sink')",
      )
      .run(pid, now, now);
    log.registerSink({
      info() {
        throw new Error("information sink failed");
      },
      warn() {},
      error() {},
      captureException() {},
    });
    try {
      expect(await backfillEmbeddings()).toBe(1);
      expect(embeddingOf("knowledge", "info-sink")).not.toBeNull();
    } finally {
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
      });
    }
  });

  test("fetches large startup corpora in bounded source pages", async () => {
    checkConfigChange();
    const now = Date.now();
    const insert = db().query(
      "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'test', 'page', 'content', ?, ?, ?)",
    );
    for (let i = 0; i < 129; i++) {
      const id = `page-${String(i).padStart(3, "0")}`;
      insert.run(id, pid, now, now, id);
    }
    const pageReads: string[] = [];
    log.registerSink({
      info() {},
      warn() {},
      error() {},
      captureException() {},
      withDbSpan(sql, fn) {
        if (sql.includes("ORDER BY k.id LIMIT ?")) pageReads.push(sql);
        return fn();
      },
    });
    try {
      expect(await backfillEmbeddings()).toBe(129);
      expect(pageReads).toHaveLength(3);
      expect(embeddingOf("knowledge", "page-128")).not.toBeNull();
    } finally {
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
      });
    }
  });

  test("skips an oversized startup source and continues to the next owned row", async () => {
    const now = Date.now();
    const insert = db().query(
      "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'test', 'title', ?, ?, ?, ?)",
    );
    insert.run(
      "a-oversized-source",
      pid,
      "x".repeat(256 * 1024 + 1),
      now,
      now,
      "a-oversized-source",
    );
    insert.run(
      "b-small-source",
      pid,
      "bounded source content",
      now,
      now,
      "b-small-source",
    );

    expect(await backfillEmbeddings()).toBe(1);
    expect(embeddingOf("knowledge", "a-oversized-source")).toBeNull();
    expect(embeddingOf("knowledge", "b-small-source")).not.toBeNull();
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
