import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { config } from "../src/config";
import { close, db, dbPath, ensureProject, setKV } from "../src/db";
import {
  ensureVec0Store,
  readStorageMode,
  setStorageMode,
  storeTemporalChunks,
} from "../src/db/vec-store";
import {
  _restoreProvider,
  _saveAndClearProvider,
  EmbeddingQueueCapacityError,
  LocalProviderUnavailableError,
  toBlob,
  type EmbeddingProvider,
} from "../src/embedding";
import {
  _resetTemporalEmbeddingSchedulerForTest,
  _setTemporalEmbeddingRequestTimeoutForTest,
  drainTemporalEmbeddingQueueOnce,
  enqueueTemporalEmbedding,
  settleTemporalEmbeddingScheduler,
  startTemporalEmbeddingScheduler,
  stopTemporalEmbeddingScheduler,
  temporalContentHash,
  temporalEmbeddingFingerprint,
} from "../src/temporal-embedding-queue";
import { MAX_TEMPORAL_CHUNKS_PER_MESSAGE } from "../src/embedding-units";
import * as log from "../src/log";
import * as embedding from "../src/embedding";
import { currentTenantId, withTenant } from "../src/tenant";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let savedProvider: unknown;
let sequence = 0;
const passthroughSink: Parameters<typeof log.registerSink>[0] = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

function vector(value = 1): Float32Array {
  const out = new Float32Array(config().search.embeddings.dimensions);
  out[0] = value;
  return out;
}

function installProvider(provider: EmbeddingProvider): void {
  _restoreProvider({ provider });
}

function insertMessage(
  content: string,
  source: "live" | "backfill" = "live",
  projectPath?: string,
): string {
  sequence++;
  const id = `temporal-queue-${sequence}`;
  const project = ensureProject(
    projectPath ?? `/test/temporal-queue/${sequence}`,
  );
  db()
    .query(
      `INSERT INTO temporal_messages
       (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, ?, 'user', ?, 1, 0, ?, '{}')`,
    )
    .run(id, id, project, `session-${sequence}`, content, Date.now());
  enqueueTemporalEmbedding(id, content, source);
  return id;
}

function queueRow(id: string): { content_hash: string } | null {
  return db()
    .query(
      "SELECT content_hash FROM temporal_embedding_queue WHERE message_id = ?",
    )
    .get(id) as { content_hash: string } | null;
}

beforeEach(() => {
  _resetTemporalEmbeddingSchedulerForTest();
  savedProvider = _saveAndClearProvider();
  db().query("DELETE FROM temporal_embedding_queue").run();
  db()
    .query("DELETE FROM temporal_messages WHERE id LIKE 'temporal-queue-%'")
    .run();
});

afterEach(async () => {
  stopTemporalEmbeddingScheduler();
  await settleTemporalEmbeddingScheduler();
  vi.useRealTimers();
  _restoreProvider(savedProvider);
  log.registerSink(passthroughSink);
  vi.restoreAllMocks();
});

describe("durable temporal embedding scheduler", () => {
  test("leaves oversized live sources in FTS without admitting a provider job", async () => {
    const content = `${"x".repeat(2 * 1024 * 1024)} oversizeftsmarker`;
    const id = insertMessage(content);
    expect(queueRow(id)).toBeNull();
    expect(
      db()
        .query("SELECT rowid FROM temporal_fts WHERE temporal_fts MATCH ?")
        .get("oversizeftsmarker"),
    ).not.toBeNull();
    const embed = vi.fn(async () => [vector()]);
    installProvider({ maxBatchSize: 8, embed });
    expect(await drainTemporalEmbeddingQueueOnce()).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });

  test("retires an oversized legacy queue row without synchronous full-source hashing", async () => {
    const id = insertMessage(
      "a pending row that predates the source-size admission limit",
    );
    const content = `${"x".repeat(2 * 1024 * 1024)} oversizelegacyftsmarker`;
    db()
      .query("UPDATE temporal_messages SET content = ? WHERE id = ?")
      .run(content, id);
    const embed = vi.fn(async () => [vector()]);
    installProvider({ maxBatchSize: 8, embed });
    const hashQueries = { count: 0 };
    log.registerSink({
      ...passthroughSink,
      withDbSpan<T>(sql: string, fn: () => T): T {
        if (sql.includes("substr(CAST(t.content AS BLOB)")) hashQueries.count++;
        return fn();
      },
    });

    expect(await drainTemporalEmbeddingQueueOnce()).toBe(0);
    expect(queueRow(id)).toBeNull();
    expect(hashQueries.count).toBeLessThanOrEqual(32);
    expect(embed).not.toHaveBeenCalled();
    expect(
      db()
        .query("SELECT rowid FROM temporal_fts WHERE temporal_fts MATCH ?")
        .get("oversizelegacyftsmarker"),
    ).not.toBeNull();
  });

  test("invalidates an old vector when its source becomes oversized", () => {
    expect(readStorageMode(db())).toBe("blob");
    const id = insertMessage("a previously indexed source with enough content");
    const content = `${"x".repeat(2 * 1024 * 1024)} oversizedreplacement`;
    db()
      .query("UPDATE temporal_messages SET content = ? WHERE id = ?")
      .run(content, id);
    // Legacy data can already carry a vector for a source above the new cap.
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id = ?")
      .run(toBlob(vector()), id);

    expect(enqueueTemporalEmbedding(id, content)).toBe(false);
    expect(queueRow(id)).toBeNull();
    expect(
      db()
        .query("SELECT embedding FROM temporal_messages WHERE id = ?")
        .get(id),
    ).toEqual({ embedding: null });
  });

  test("repairs a queued owner's retry debt after a move without its update trigger", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed() {
        throw new Error("source owner's provider failed");
      },
    });
    const fromPath = "/test/temporal-queue/stale-owner-source";
    const id = insertMessage(
      "queued message must survive a project move during partial trigger recovery",
      "backfill",
      fromPath,
    );
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    const connection = db();
    const before = connection
      .query(
        "SELECT failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(id) as { failures: number; retry_at: number };
    expect(before.failures).toBe(1);
    expect(before.retry_at).toBeGreaterThan(Date.now());
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        return texts.map(() => vector());
      },
    });
    const from = ensureProject(fromPath);
    const to = ensureProject("/test/temporal-queue/stale-owner-destination");
    connection.exec("DROP TRIGGER temporal_embedding_queue_project_update");
    connection
      .query("UPDATE temporal_messages SET project_id = ? WHERE id = ?")
      .run(to, id);
    expect(
      connection
        .query(
          "SELECT project_id FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id),
    ).toEqual({ project_id: from });
    close();

    const recovered = db();
    expect(
      recovered
        .query(
          "SELECT project_id, failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id),
    ).toEqual({ project_id: to, failures: 0, retry_at: 0 });
    expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
    expect(queueRow(id)).toBeNull();
  });

  test("recovers legacy backlog while admitting live work without starving old rows", async () => {
    const served: string[] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        served.push(...texts);
        return texts.map(() => vector());
      },
    });
    const old = Array.from({ length: 3 }, (_, index) =>
      insertMessage(
        `legacy backlog message ${index} needs its durable vector before recovery`,
        "backfill",
      ),
    );
    const live = insertMessage(
      "new conversation work needs its vector promptly and reliably",
    );

    await drainTemporalEmbeddingQueueOnce();
    expect(served[0]).toContain("new conversation");
    expect(queueRow(live)).toBeNull();
    expect(old.some((id) => queueRow(id) !== null)).toBe(true);

    for (let attempt = 0; attempt < 4; attempt++) {
      await drainTemporalEmbeddingQueueOnce();
    }
    expect(old.every((id) => queueRow(id) === null)).toBe(true);
  });

  test("gives historical work a share even under a sustained live flood", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        return texts.map(() => vector());
      },
    });
    const old = insertMessage(
      "historical work must not starve during ongoing live turns",
      "backfill",
    );
    const live = Array.from({ length: 25 }, (_, index) =>
      insertMessage(
        `current turn ${index} has enough context to require an embedding promptly`,
      ),
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      await drainTemporalEmbeddingQueueOnce();
      expect(queueRow(old)).not.toBeNull();
    }
    await drainTemporalEmbeddingQueueOnce();
    expect(queueRow(old)).toBeNull();
    expect(live.some((id) => queueRow(id) !== null)).toBe(true);
  });

  test("a due poisoned historical retry cannot take every historical turn", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        if (texts.some((text) => text.includes("poisoned historical"))) {
          throw new Error("provider rejected the poisoned historical row");
        }
        return texts.map(() => vector());
      },
    });
    const poison = insertMessage(
      "poisoned historical message fails every durable retry",
      "backfill",
    );
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    const healthy = insertMessage(
      "healthy historical message must make progress despite the due retry",
      "backfill",
    );

    for (let turn = 0; turn < 3; turn++) {
      insertMessage(`live work ${turn} takes a foreground scheduling turn`);
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    }
    // The original row has become eligible again by the time the historical
    // share arrives. Fresh historical work still needs its own share.
    db()
      .query(
        "UPDATE temporal_embedding_queue SET retry_at = 0 WHERE message_id = ?",
      )
      .run(poison);
    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    expect(queueRow(healthy)).toBeNull();
    expect(queueRow(poison)).not.toBeNull();
  });

  test("same-content live promotion clears the historical retry deadline", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed() {
        throw new Error("provider rejection");
      },
    });
    const content =
      "historical queued work must run immediately when it becomes a live turn";
    const id = insertMessage(content, "backfill");
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    const before = db()
      .query(
        "SELECT priority, enqueued_at, retry_at, failures FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(id) as {
      priority: number;
      enqueued_at: number;
      retry_at: number;
      failures: number;
    };
    expect(before.failures).toBe(1);

    expect(enqueueTemporalEmbedding(id, content)).toBe(true);
    expect(
      db()
        .query(
          "SELECT priority, enqueued_at, retry_at, failures FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id),
    ).toEqual({
      priority: 1,
      enqueued_at: expect.any(Number),
      retry_at: 0,
      failures: 0,
    });

    // An unchanged repeat live admission does not bypass a *live* failure's
    // retry deadline; only the historical-to-live transition is fresh work.
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    const liveRetry = db()
      .query(
        "SELECT retry_at, failures FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(id) as { retry_at: number; failures: number };
    expect(liveRetry.failures).toBe(1);
    expect(liveRetry.retry_at).toBeGreaterThan(Date.now());
    expect(enqueueTemporalEmbedding(id, content)).toBe(false);
    expect(
      db()
        .query(
          "SELECT retry_at, failures FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id),
    ).toEqual(liveRetry);

    const changed = `${content} changed`;
    db()
      .query("UPDATE temporal_messages SET content = ? WHERE id = ?")
      .run(changed, id);
    expect(enqueueTemporalEmbedding(id, changed)).toBe(true);
    const after = db()
      .query(
        "SELECT priority, retry_at, failures FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(id);
    expect(after).toEqual({ priority: 1, retry_at: 0, failures: 0 });
  });

  test("a failed oldest row is deferred durably while healthy work progresses", async () => {
    let poisoned = true;
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        if (poisoned && texts.some((text) => text.includes("poison"))) {
          throw new Error("private provider error");
        }
        return texts.map(() => vector());
      },
    });
    const poison = insertMessage(
      "poison row blocks the old oldest-first scheduler indefinitely",
    );
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    const deferred = db()
      .query(
        "SELECT failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(poison) as { failures: number; retry_at: number };
    expect(deferred.failures).toBe(1);
    expect(deferred.retry_at).toBeGreaterThan(Date.now());
    const healthy = insertMessage(
      "healthy work must run while the failed oldest row cools down safely",
    );

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    expect(queueRow(healthy)).toBeNull();
    expect(queueRow(poison)).not.toBeNull();

    // The retry timestamp and failure count live in SQLite, not scheduler memory.
    const retry = db()
      .query(
        "SELECT failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(poison) as { failures: number; retry_at: number };
    expect(retry.failures).toBe(1);
    expect(retry.retry_at).toBeGreaterThan(Date.now());
    poisoned = false;
    db()
      .query(
        "UPDATE temporal_embedding_queue SET retry_at = 0 WHERE message_id = ?",
      )
      .run(poison);
    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    expect(queueRow(poison)).toBeNull();
  });

  test("a poisoned owner's batch never assigns retry debt to a healthy owner", async () => {
    const requests: string[][] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        requests.push(texts);
        if (texts.some((text) => text.includes("rejected owner"))) {
          throw new Error("private rejection of one owner");
        }
        return texts.map(() => vector());
      },
    });
    const failing = Array.from({ length: 7 }, (_, index) =>
      insertMessage(
        `rejected owner message ${index} contains enough text to embed`,
        "backfill",
        "/test/mixed-batch-rejected-owner",
      ),
    );
    const healthy = insertMessage(
      "healthy owner has independent work in the first durable batch",
      "backfill",
      "/test/mixed-batch-healthy-owner",
    );

    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    expect(requests[0]).toHaveLength(7);
    expect(
      db()
        .query(
          "SELECT failures FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(healthy),
    ).toEqual({ failures: 0 });
    expect(
      db()
        .query(
          "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE message_id IN (?, ?, ?, ?, ?, ?, ?) AND failures = 1",
        )
        .get(...failing),
    ).toEqual({ n: 7 });
    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    expect(queueRow(healthy)).toBeNull();
  });

  test("a shared scheduler embeds a different tenant only under that tenant", async () => {
    const seen: string[] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        seen.push(currentTenantId());
        return texts.map(() => vector());
      },
    });
    const other = withTenant("tenant-b", () =>
      insertMessage(
        "tenant b owns this content and must own its provider request",
        "backfill",
        "/test/tenant-b-temporal-queue",
      ),
    );
    await withTenant("tenant-a", () => drainTemporalEmbeddingQueueOnce());
    expect(seen).toEqual(["tenant-b"]);
    expect(queueRow(other)).toBeNull();
  });

  test("never reads or submits a row moved between candidate selection and content retrieval", async () => {
    const seen: string[] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        seen.push(currentTenantId());
        return texts.map(() => vector());
      },
    });
    const id = withTenant("tenant-a", () =>
      insertMessage(
        "private source changes tenants before the text read",
        "live",
      ),
    );
    const destination = withTenant("tenant-b", () =>
      ensureProject("/test/temporal-queue/transferred-tenant"),
    );
    const competitor = new DatabaseSync(dbPath());
    let moved = false;
    const unscopedSourceReads: string[] = [];
    log.registerSink({
      ...passthroughSink,
      withDbSpan<T>(sql: string, fn: () => T): T {
        if (
          sql.includes("length(CAST(t.content AS BLOB))") &&
          currentTenantId() === ""
        )
          unscopedSourceReads.push(sql);
        const value = fn();
        if (
          !moved &&
          sql.includes(
            "WHERE q.priority = ? AND q.project_id = ? AND q.failures = 0",
          )
        ) {
          moved = true;
          competitor
            .prepare("UPDATE temporal_messages SET project_id = ? WHERE id = ?")
            .run(destination, id);
        }
        return value;
      },
    });
    try {
      expect(await drainTemporalEmbeddingQueueOnce()).toBe(0);
      expect(moved).toBe(true);
      expect(unscopedSourceReads).toEqual([]);
      expect(seen).toEqual([]);
      expect(queueRow(id)).not.toBeNull();
    } finally {
      log.registerSink(passthroughSink);
      competitor.close();
    }
    expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
    expect(seen).toEqual(["tenant-b"]);
  });

  test("rechecks ownership before each provider sub-batch after a tenant transfer", async () => {
    const originalMode = readStorageMode(db());
    ensureVec0Store(db(), config().search.embeddings.dimensions);
    setStorageMode(db(), "vec0");
    try {
      const id = withTenant("tenant-a", () =>
        insertMessage(
          Array.from(
            { length: 12 },
            (_, i) => `private-unit-${i}-content`,
          ).join("\n\x1f"),
          "live",
        ),
      );
      const destination = withTenant("tenant-b", () =>
        ensureProject("/test/temporal-queue/transferred-sub-batches"),
      );
      const competitor = new DatabaseSync(dbPath());
      const seen: Array<{ tenant: string; texts: string[] }> = [];
      try {
        installProvider({
          maxBatchSize: 8,
          async embed(texts) {
            seen.push({ tenant: currentTenantId(), texts: [...texts] });
            if (seen.length === 1)
              competitor
                .prepare(
                  "UPDATE temporal_messages SET project_id = ? WHERE id = ?",
                )
                .run(destination, id);
            return texts.map(() => vector());
          },
        });
        expect(await drainTemporalEmbeddingQueueOnce()).toBe(0);
        expect(seen).toHaveLength(1);
        expect(seen[0].tenant).toBe("tenant-a");
        expect(queueRow(id)).not.toBeNull();
        expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
        expect(seen.slice(1).every(({ tenant }) => tenant === "tenant-b")).toBe(
          true,
        );
        expect(queueRow(id)).toBeNull();
      } finally {
        competitor.close();
      }
    } finally {
      setStorageMode(db(), originalMode);
    }
  });

  test("does not charge a moved owner for the former owner's failed inference", async () => {
    const id = withTenant("tenant-a", () =>
      insertMessage(
        "an existing historical row can move during inference",
        "backfill",
      ),
    );
    // The row was admitted as fair-ahead work before the provider call.
    db()
      .query(
        "UPDATE temporal_embedding_queue SET fair_ahead = 1 WHERE message_id = ?",
      )
      .run(id);
    const destination = withTenant("tenant-b", () =>
      ensureProject("/test/temporal-queue/failed-transfer-destination"),
    );
    const competitor = new DatabaseSync(dbPath());
    const owners: string[] = [];
    try {
      installProvider({
        maxBatchSize: 8,
        async embed(texts) {
          owners.push(currentTenantId());
          if (owners.length === 1) {
            competitor
              .prepare(
                "UPDATE temporal_messages SET project_id = ? WHERE id = ?",
              )
              .run(destination, id);
            throw new Error("the old owner's provider rejected the request");
          }
          return texts.map(() => vector());
        },
      });
      await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow(
        "Embedding provider failed",
      );
      expect(
        db()
          .query(
            "SELECT q.project_id, q.failures, q.retry_at, q.fair_ahead FROM temporal_embedding_queue q WHERE q.message_id = ?",
          )
          .get(id),
      ).toEqual({
        project_id: destination,
        failures: 0,
        retry_at: 0,
        fair_ahead: 1,
      });
      expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
      expect(owners).toEqual(["tenant-a", "tenant-b"]);
      expect(queueRow(id)).toBeNull();
    } finally {
      competitor.close();
    }
  });

  test("a previously failed queued row runs fresh after its owner changes", async () => {
    const id = withTenant("tenant-a", () =>
      insertMessage(
        "historical inference failed before this source changed owner",
        "backfill",
      ),
    );
    installProvider({
      maxBatchSize: 8,
      async embed() {
        throw new Error("old tenant provider failure");
      },
    });
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    const retry = db()
      .query(
        "SELECT failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(id) as { failures: number; retry_at: number };
    expect(retry.failures).toBe(1);
    expect(retry.retry_at).toBeGreaterThan(Date.now());

    const destination = withTenant("tenant-b", () =>
      ensureProject("/test/temporal-queue/failed-before-transfer"),
    );
    db()
      .query("UPDATE temporal_messages SET project_id = ? WHERE id = ?")
      .run(destination, id);
    expect(
      db()
        .query(
          "SELECT project_id, failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id),
    ).toEqual({ project_id: destination, failures: 0, retry_at: 0 });
    const owners: string[] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        owners.push(currentTenantId());
        return texts.map(() => vector());
      },
    });
    expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
    expect(owners).toEqual(["tenant-b"]);
    expect(queueRow(id)).toBeNull();
  });

  test("an orphaned first project cannot hide a healthy queued message", async () => {
    const content = "a damaged orphan cannot block healthy fresh work";
    const orphan = "temporal-queue-0-orphan";
    const connection = db();
    connection.exec("PRAGMA foreign_keys = OFF");
    try {
      connection
        .query(
          `INSERT INTO temporal_messages
           (id, project_id, session_id, role, content, tokens, distilled, created_at)
           VALUES (?, 'missing-project', 'orphan-session', 'user', ?, 1, 0, 1)`,
        )
        .run(orphan, content);
      connection
        .query(
          `INSERT INTO temporal_embedding_queue
           (message_id, project_id, content_hash, fingerprint, enqueued_at, priority)
           VALUES (?, 'missing-project', ?, ?, 0, 1)`,
        )
        .run(
          orphan,
          temporalContentHash(content),
          temporalEmbeddingFingerprint(),
        );
    } finally {
      connection.exec("PRAGMA foreign_keys = ON");
    }
    const healthy = insertMessage(
      "another project's valid message must keep making progress",
    );
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        return texts.map(() => vector());
      },
    });

    expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
    expect(queueRow(healthy)).toBeNull();
    expect(queueRow(orphan)).not.toBeNull();
  });

  test("another tenant cannot admit a message by knowing its ID", () => {
    const id = withTenant("tenant-b", () => {
      const messageId = insertMessage(
        "tenant b owns the only authorized embedding of this message",
        "backfill",
        "/test/tenant-b-admission",
      );
      db()
        .query("DELETE FROM temporal_embedding_queue WHERE message_id = ?")
        .run(messageId);
      return messageId;
    });
    expect(
      withTenant("tenant-a", () =>
        enqueueTemporalEmbedding(id, "forged tenant a embedding content"),
      ),
    ).toBe(false);
    expect(queueRow(id)).toBeNull();
  });

  test("a throwing diagnostic sink cannot cancel durable scheduler retries", async () => {
    vi.useFakeTimers();
    const embed = vi.fn(async () => {
      throw new Error("private provider error");
    });
    installProvider({ maxBatchSize: 8, embed });
    log.registerSink({
      info() {},
      warn() {},
      error() {
        throw new Error("diagnostic sink failed");
      },
      captureException() {},
    });
    const id = insertMessage(
      "a failed diagnostic sink cannot strand the durable retry",
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(embed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(queueRow(id)).not.toBeNull();
  });

  test("resumes a deferred legacy row at its durable retry time after scheduler reset", async () => {
    let available = false;
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        if (!available) throw new Error("temporary provider failure");
        return texts.map(() => vector());
      },
    });
    const id = insertMessage(
      "legacy work must survive provider failure and scheduler restart",
      "backfill",
    );
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    const retry = db()
      .query(
        "SELECT retry_at, failures, priority FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(id) as { retry_at: number; failures: number; priority: number };
    expect(retry).toMatchObject({ failures: 1, priority: 0 });
    expect(retry.retry_at).toBeGreaterThan(Date.now());

    _resetTemporalEmbeddingSchedulerForTest();
    available = true;
    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(0);
    vi.spyOn(Date, "now").mockReturnValue(retry.retry_at);
    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    expect(queueRow(id)).toBeNull();
  });

  test("flattens multiple messages into one provider request", async () => {
    const requests: string[][] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        requests.push(texts);
        return texts.map((_, index) => vector(index + 1));
      },
    });
    insertMessage(
      "first message has enough semantic content to be embedded once",
      "live",
      "/test/shared-provider-request",
    );
    insertMessage(
      "second message shares the same bounded provider request safely",
      "live",
      "/test/shared-provider-request",
    );

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(2);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveLength(2);
  });

  test("shares one active drain and never starts duplicate inference", async () => {
    const gate = deferred<Float32Array[]>();
    const started = deferred<void>();
    let active = 0;
    let maxActive = 0;
    installProvider({
      maxBatchSize: 8,
      embed() {
        active++;
        maxActive = Math.max(maxActive, active);
        started.resolve();
        return gate.promise.finally(() => active--);
      },
    });
    insertMessage(
      "one pending message holds the normal scheduler inference slot",
    );

    const first = drainTemporalEmbeddingQueueOnce();
    const second = drainTemporalEmbeddingQueueOnce();
    expect(second).toBe(first);
    await started.promise;
    expect(maxActive).toBe(1);
    gate.resolve([vector()]);
    await expect(first).resolves.toBe(1);
  });

  test("an older completion cannot overwrite content or delete newer work", async () => {
    const firstRequest = deferred<Float32Array[]>();
    const started = deferred<void>();
    let calls = 0;
    installProvider({
      maxBatchSize: 8,
      embed() {
        calls++;
        if (calls === 1) {
          started.resolve();
          return firstRequest.promise;
        }
        return Promise.resolve([vector(2)]);
      },
    });
    const original =
      "version A is long enough to start asynchronous embedding work";
    const id = insertMessage(original);
    const drainA = drainTemporalEmbeddingQueueOnce();
    await started.promise;

    const latest =
      "version B replaces A while its provider request remains active";
    db()
      .query("UPDATE temporal_messages SET content = ? WHERE id = ?")
      .run(latest, id);
    enqueueTemporalEmbedding(id, latest);
    firstRequest.resolve([vector(1)]);
    await expect(drainA).resolves.toBe(0);

    expect(queueRow(id)).toEqual({ content_hash: temporalContentHash(latest) });
    const beforeB = db()
      .query("SELECT embedding FROM temporal_messages WHERE id = ?")
      .get(id) as { embedding: Uint8Array | null };
    expect(beforeB.embedding).toBeNull();

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    expect(queueRow(id)).toBeNull();
  });

  test("provider failure preserves every admitted queue row", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed() {
        throw new Error("private provider diagnostic");
      },
    });
    const id = insertMessage(
      "provider failure must leave this durable work available for retry",
    );

    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    expect(queueRow(id)).not.toBeNull();
  });

  test("a request deadline aborts active work, preserves it durably, and permits retry", async () => {
    const aborted = deferred<void>();
    let calls = 0;
    installProvider({
      maxBatchSize: 8,
      embed(texts, _inputType, signal) {
        calls++;
        if (calls > 1) return Promise.resolve(texts.map(() => vector(2)));
        return new Promise<Float32Array[]>((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new Error("request aborted"));
            },
            { once: true },
          );
        });
      },
    });
    _setTemporalEmbeddingRequestTimeoutForTest(10);
    const id = insertMessage(
      "a wedged provider request must remain durable after its deadline",
    );

    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    await aborted.promise;
    expect(queueRow(id)).not.toBeNull();

    _setTemporalEmbeddingRequestTimeoutForTest(null);
    db()
      .query(
        "UPDATE temporal_embedding_queue SET retry_at = 0 WHERE message_id = ?",
      )
      .run(id);
    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    expect(queueRow(id)).toBeNull();
    expect(calls).toBe(2);
  });

  test("late results from an abort-ignoring provider never commit", async () => {
    const gate = deferred<Float32Array[]>();
    const started = deferred<void>();
    installProvider({
      maxBatchSize: 8,
      embed() {
        started.resolve();
        return gate.promise;
      },
    });
    const id = insertMessage(
      "late provider output after shutdown must remain uncommitted",
    );
    const drain = drainTemporalEmbeddingQueueOnce();
    await started.promise;

    stopTemporalEmbeddingScheduler();
    await expect(settleTemporalEmbeddingScheduler(1)).resolves.toBe(false);
    gate.resolve([vector()]);
    await expect(drain).rejects.toBeInstanceOf(Error);

    expect(queueRow(id)).not.toBeNull();
    const row = db()
      .query("SELECT embedding FROM temporal_messages WHERE id = ?")
      .get(id) as { embedding: Uint8Array | null };
    expect(row.embedding).toBeNull();
  });

  test("scheduler failures identify the stage without exposing private diagnostics", async () => {
    const logged = deferred<void>();
    const error = vi.spyOn(log, "error").mockImplementation(() => {
      logged.resolve();
    });
    installProvider({
      maxBatchSize: 8,
      async embed() {
        throw new Error("private provider diagnostic");
      },
    });
    const content =
      "private temporal content must never appear in scheduler logs";
    const id = insertMessage(content);

    startTemporalEmbeddingScheduler();
    await logged.promise;
    stopTemporalEmbeddingScheduler();
    await settleTemporalEmbeddingScheduler();

    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^temporal embedding scheduler drain failed: reason=operation-failed stage=embed elapsed_ms=\d+ messages=1 input_bytes=\d+ units=1 failures=1 retry_ms=1000$/,
      ),
    );
    expect(error).toHaveBeenCalledOnce();
    expect(
      error.mock.calls.flat().every((argument) => typeof argument === "string"),
    ).toBe(true);
    // Match the logger's coercion: JSON.stringify(Error) would hide its message.
    const rendered = error.mock.calls.flat().map(String).join("\n");
    expect(rendered).not.toContain(content);
    expect(rendered).not.toContain(id);
    expect(rendered).not.toContain("private provider diagnostic");
    expect(queueRow(id)).not.toBeNull();
  });

  test("persistent failures back off exponentially, cap retries, and recover once after durable progress", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    let failing = true;
    const embed = vi.fn(async (texts: string[]) => {
      if (failing) throw new Error("private retry diagnostic");
      return texts.map(() => vector());
    });
    installProvider({ maxBatchSize: 8, embed });
    const id = insertMessage(
      "durable retries must survive each failed provider attempt",
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(embed).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ].entries()) {
      expect(error.mock.calls.at(-1)?.[0]).toContain(`retry_ms=${delay}`);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(embed).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(embed).toHaveBeenCalledTimes(index + 2);
      expect(queueRow(id)).not.toBeNull();
    }
    failing = false;
    await vi.advanceTimersByTimeAsync(30000);
    expect(queueRow(id)).toBeNull();
    const recoveries = () =>
      info.mock.calls.filter(([message]) =>
        String(message).startsWith("temporal embedding scheduler recovered:"),
      );
    expect(recoveries()).toHaveLength(1);
    expect(recoveries()[0]?.[0]).toContain("failures=8");
    await vi.advanceTimersByTimeAsync(1000);
    expect(recoveries()).toHaveLength(1);
    failing = true;
    insertMessage(
      "new work starts a fresh failure streak after a real recovery",
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(error.mock.calls.at(-1)?.[0]).toContain("failures=1 retry_ms=1000");
  });

  test("a new live admission wakes a scheduler cooling down on a deferred row", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some((text) => text.includes("poisoned historical"))) {
        throw new Error("private rejection of an old message");
      }
      return texts.map(() => vector());
    });
    installProvider({ maxBatchSize: 8, embed });
    const poison = insertMessage(
      "poisoned historical work remains queued through every retry",
      "backfill",
    );
    startTemporalEmbeddingScheduler();
    for (const delay of [0, 1000, 2000, 4000, 8000, 16000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(error.mock.calls.at(-1)?.[0]).toContain("retry_ms=30000");
    const before = embed.mock.calls.length;
    const live = insertMessage(
      "fresh conversation work must bypass the stale global cooldown",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(embed).toHaveBeenCalledTimes(before + 1);
    expect(queueRow(live)).toBeNull();
    expect(queueRow(poison)).not.toBeNull();
  });

  test("sustained fresh admissions from a failing owner cannot defeat provider backoff", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const embed = vi.fn(async () => {
      throw new Error("private upstream rejection");
    });
    installProvider({ maxBatchSize: 8, embed });
    const owner = "/test/failing-embedding-owner";
    insertMessage(
      "first failing owner message with enough historical content",
      "live",
      owner,
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(embed).toHaveBeenCalledOnce();

    insertMessage(
      "another failing owner message 0 with enough content for inference",
      "live",
      owner,
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(embed).toHaveBeenCalledOnce();
    for (let i = 1; i < 12; i++) {
      insertMessage(
        `another failing owner message ${i} with enough content`,
        "live",
        owner,
      );
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(embed.mock.calls.length).toBeLessThanOrEqual(3);
    expect(error.mock.calls.length).toBe(embed.mock.calls.length);
    expect(
      db().query("SELECT COUNT(*) AS n FROM temporal_embedding_queue").get(),
    ).toEqual({ n: 13 });
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "private upstream rejection",
    );
  });

  test("a healthy owner can recover during another owner's failure backoff", async () => {
    vi.useFakeTimers();
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some((text) => text.includes("unhealthy owner"))) {
        throw new Error("unhealthy upstream content");
      }
      return texts.map(() => vector());
    });
    installProvider({ maxBatchSize: 8, embed });
    const failingOwner = "/test/unhealthy-embedding-owner";
    const first = insertMessage(
      "unhealthy owner first message requires retry and contains sufficient detail",
      "live",
      failingOwner,
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(embed).toHaveBeenCalledOnce();
    expect(queueRow(first)).not.toBeNull();
    for (let i = 0; i < 8; i++) {
      insertMessage(
        `unhealthy owner new message ${i} is still failing with ample content`,
        "live",
        failingOwner,
      );
    }
    const healthy = insertMessage(
      "healthy different owner must progress despite the failed queue",
      "live",
      "/test/healthy-embedding-owner",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queueRow(healthy)).toBeNull();
    expect(
      db().query("SELECT COUNT(*) AS n FROM temporal_embedding_queue").get(),
    ).toEqual({ n: 9 });
  });

  test("reaches a healthy owner past two poisoned fresh backlogs with bounded fast probes", async () => {
    vi.useFakeTimers();
    const owners = [
      "/test/failed-owner-one",
      "/test/failed-owner-two",
      "/test/healthy-owner-three",
    ]
      .map((path) => ({ path, id: ensureProject(path) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some((text) => text.includes("poisoned owner"))) {
        throw new Error("private provider rejection");
      }
      return texts.map(() => vector());
    });
    installProvider({ maxBatchSize: 8, embed });
    for (const [ownerIndex, owner] of owners.entries()) {
      for (let i = 0; i < (ownerIndex < 2 ? 24 : 1); i++) {
        const id = insertMessage(
          ownerIndex < 2
            ? `poisoned owner ${ownerIndex} message ${i} requires isolated retries`
            : "healthy owner third must progress beyond both poisoned backlogs",
          "live",
          owner.path,
        );
        db()
          .query(
            "UPDATE temporal_embedding_queue SET enqueued_at = ? WHERE message_id = ?",
          )
          .run(100 + ownerIndex * 100 + i, id);
        if (ownerIndex === 2) {
          expect(queueRow(id)).not.toBeNull();
        }
      }
    }
    const healthyId = db()
      .query(
        "SELECT message_id FROM temporal_embedding_queue WHERE project_id = ?",
      )
      .get(owners[2].id) as { message_id: string };

    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]?.[0].join(" ")).toContain("poisoned owner 0");
    await vi.advanceTimersByTimeAsync(250);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[1]?.[0].join(" ")).toContain("poisoned owner 1");
    await vi.advanceTimersByTimeAsync(250);
    expect(embed).toHaveBeenCalledTimes(3);
    expect(embed.mock.calls[2]?.[0].join(" ")).toContain("healthy owner third");
    expect(queueRow(healthyId.message_id)).toBeNull();
    expect(
      db()
        .query(
          "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE failures > 0",
        )
        .get(),
    ).toEqual({ n: 9 });
  });

  test("bounds provider calls when successive cross-owner probes all fail", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const embed = vi.fn(async (_texts: string[]) => {
      throw new Error("private provider outage");
    });
    installProvider({ maxBatchSize: 8, embed });
    const owners = Array.from({ length: 4 }, (_, index) => ({
      path: `/test/outage-owner-${index}`,
    }))
      .map((owner) => ({ ...owner, id: ensureProject(owner.path) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const [index, owner] of owners.entries()) {
      const id = insertMessage(
        `outage owner ${index} message needs durable retry and bounded provider calls`,
        "live",
        owner.path,
      );
      db()
        .query(
          "UPDATE temporal_embedding_queue SET enqueued_at = ? WHERE message_id = ?",
        )
        .run(100 + index, id);
    }
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(500);
    expect(embed).toHaveBeenCalledTimes(3);
    expect(error.mock.calls.at(-1)?.[0]).toContain("retry_ms=4000");
    await vi.advanceTimersByTimeAsync(3_999);
    expect(embed).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(embed).toHaveBeenCalledTimes(4);
    expect(embed.mock.calls[3]?.[0].join(" ")).toContain("outage owner 3");
    expect(
      db().query("SELECT COUNT(*) AS n FROM temporal_embedding_queue").get(),
    ).toEqual({ n: 4 });
  });

  test("selects an already-queued healthy owner past a failing owner's fresh backlog", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some((text) => text.includes("rejected owner's content"))) {
        throw new Error("private rejection of one owner's messages");
      }
      return texts.map(() => vector());
    });
    installProvider({ maxBatchSize: 8, embed });
    for (let i = 0; i < 32; i++) {
      const id = insertMessage(
        `rejected owner's content message ${i} with substantial context for embedding`,
        "live",
        "/test/queued-rejected-owner",
      );
      db()
        .query(
          "UPDATE temporal_embedding_queue SET enqueued_at = ? WHERE message_id = ?",
        )
        .run(100 + i, id);
    }
    const healthy = insertMessage(
      "already queued healthy owner's content must get a bounded recovery probe",
      "live",
      "/test/queued-healthy-owner",
    );
    db()
      .query(
        "UPDATE temporal_embedding_queue SET enqueued_at = ? WHERE message_id = ?",
      )
      .run(1_000, healthy);
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(embed).toHaveBeenCalledOnce();
    expect(error.mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[1]?.[0].join(" ")).toContain(
      "already queued healthy owner",
    );
    expect(queueRow(healthy)).toBeNull();
    expect(
      db().query("SELECT COUNT(*) AS n FROM temporal_embedding_queue").get(),
    ).toEqual({ n: 32 });
    const plan = db()
      .query(
        "EXPLAIN QUERY PLAN SELECT message_id FROM temporal_embedding_queue INDEXED BY idx_temporal_embedding_queue_fresh_owner WHERE priority = 1 AND project_id > ? AND failures = 0 ORDER BY project_id, enqueued_at, message_id LIMIT 1",
      )
      .all("/test/queued-rejected-owner") as Array<{ detail: string }>;
    expect(
      plan.some(({ detail }) =>
        detail.includes("idx_temporal_embedding_queue_fresh_owner"),
      ),
    ).toBe(true);
  });

  test("empty embedding work cannot reset a failed provider's recovery budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(log, "error").mockImplementation(() => {});
    const embed = vi.fn(async () => {
      throw new Error("private provider failure");
    });
    installProvider({ maxBatchSize: 8, embed });
    insertMessage(
      "failed owner work with enough content to require inference before retry",
      "live",
      "/test/empty-probe-failed-owner",
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(embed).toHaveBeenCalledOnce();

    const empty = insertMessage(
      "short",
      "live",
      "/test/empty-probe-other-owner",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(queueRow(empty)).toBeNull();
    insertMessage(
      "third owner's new message cannot re-probe an unavailable provider yet",
      "live",
      "/test/empty-probe-third-owner",
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(embed).toHaveBeenCalledOnce();
  });

  test("an empty poll does not claim recovery or reset the failure streak", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    installProvider({
      maxBatchSize: 8,
      async embed() {
        throw new Error("private");
      },
    });
    const id = insertMessage(
      "another connection may remove failed work before the retry",
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    db()
      .query("DELETE FROM temporal_embedding_queue WHERE message_id = ?")
      .run(id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      info.mock.calls.some(([message]) =>
        String(message).includes("scheduler recovered"),
      ),
    ).toBe(false);
    insertMessage(
      "later work still inherits the provider failure backoff streak",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(error.mock.calls.at(-1)?.[0]).toContain("failures=2 retry_ms=2000");
  });

  test("deadline failures identify the scheduler deadline, not the provider's private abort error", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    installProvider({
      maxBatchSize: 8,
      embed(_texts, _inputType, signal) {
        return new Promise((_, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new Error("private deadline payload")),
            { once: true },
          ),
        );
      },
    });
    const id = insertMessage(
      "a timed out provider request must not lose its durable job",
    );
    _setTemporalEmbeddingRequestTimeoutForTest(10);
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(10);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain(
      "reason=deadline stage=embed elapsed_ms=10",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "private deadline payload",
    );
    expect(queueRow(id)).not.toBeNull();
  });

  test("provider unavailability preserves the slow retry cadence without logging its cause", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const embed = vi.fn(async () => {
      throw new LocalProviderUnavailableError(new Error("secret model path"));
    });
    installProvider({ maxBatchSize: 8, embed });
    insertMessage(
      "provider availability errors must use the slower polling cadence",
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(error.mock.calls[0]?.[0]).toContain(
      "reason=provider-unavailable stage=embed",
    );
    expect(error.mock.calls[0]?.[0]).toContain("retry_ms=30000");
    await vi.advanceTimersByTimeAsync(29999);
    expect(embed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret model path");
  });

  test("queue saturation uses transient backpressure retry without exposing content", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const embed = vi.fn(async () => {
      throw new EmbeddingQueueCapacityError();
    });
    installProvider({ maxBatchSize: 8, embed });
    const content = "private queued input must not appear in capacity logs";
    insertMessage(content);

    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(error.mock.calls[0]?.[0]).toContain(
      "reason=queue-capacity stage=embed",
    );
    expect(error.mock.calls[0]?.[0]).toContain("retry_ms=1000");
    expect(JSON.stringify(error.mock.calls)).not.toContain(content);
    await vi.advanceTimersByTimeAsync(999);
    expect(embed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  test("shutdown cancellation stays quiet and restart waits for the old provider slot", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const gate = deferred<Float32Array[]>();
    const fresh = deferred<Float32Array[]>();
    const embed = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(() => fresh.promise);
    installProvider({ maxBatchSize: 8, embed });
    const id = insertMessage(
      "a restarted scheduler must wait for abort-ignoring inference to settle",
    );
    try {
      startTemporalEmbeddingScheduler();
      await vi.advanceTimersByTimeAsync(0);
      stopTemporalEmbeddingScheduler();
      startTemporalEmbeddingScheduler();
      await vi.advanceTimersByTimeAsync(1000);
      expect(embed).toHaveBeenCalledOnce();
      gate.resolve([vector()]);
      await vi.advanceTimersByTimeAsync(0);
      expect(error).not.toHaveBeenCalled();
      expect(queueRow(id)).not.toBeNull();
      expect(embed).toHaveBeenCalledTimes(2);
      fresh.resolve([vector(2)]);
      await vi.advanceTimersByTimeAsync(0);
      expect(queueRow(id)).toBeNull();
    } finally {
      gate.resolve([vector()]);
      fresh.resolve([vector(2)]);
    }
  });

  test("settlement after stop never probes or recreates the provider", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const available = vi.spyOn(embedding, "isAvailable");
    installProvider({
      maxBatchSize: 8,
      embed(_texts, _inputType, signal) {
        return new Promise((_, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new Error("private shutdown")),
            { once: true },
          ),
        );
      },
    });
    insertMessage(
      "shutdown must not call the provider after releasing runtime ownership",
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(available).toHaveBeenCalledOnce();
    stopTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(60000);
    expect(available).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  test("a deadline preceding stop and restart is reported once by the current scheduler", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const gate = deferred<Float32Array[]>();
    const embed = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(async (texts: string[]) =>
        texts.map(() => vector(2)),
      );
    installProvider({ maxBatchSize: 8, embed });
    const id = insertMessage(
      "deadline ownership must survive restarting while old inference is pending",
    );
    _setTemporalEmbeddingRequestTimeoutForTest(10);
    try {
      startTemporalEmbeddingScheduler();
      await vi.advanceTimersByTimeAsync(10);
      stopTemporalEmbeddingScheduler();
      startTemporalEmbeddingScheduler();
      await vi.advanceTimersByTimeAsync(0);
      expect(embed).toHaveBeenCalledOnce();
      gate.resolve([vector()]);
      await vi.advanceTimersByTimeAsync(0);
      expect(queueRow(id)).not.toBeNull();
      expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls[0]?.[0]).toContain("reason=deadline stage=embed");
      expect(error.mock.calls[0]?.[0]).toContain("failures=1 retry_ms=1000");
      await vi.advanceTimersByTimeAsync(999);
      expect(embed).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(embed).toHaveBeenCalledTimes(2);
      expect(queueRow(id)).toBeNull();
    } finally {
      gate.resolve([vector()]);
    }
  });

  test("malformed vectors identify validation failures and preserve queued work", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    installProvider({
      maxBatchSize: 8,
      async embed() {
        return [new Float32Array(1)];
      },
    });
    const id = insertMessage(
      "the scheduler must reject incomplete vectors before any commit",
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(error.mock.calls[0]?.[0]).toContain(
      "reason=invalid-output stage=validate",
    );
    expect(queueRow(id)).not.toBeNull();
  });

  test("commit failures roll back vectors and classify storage without exposing its exception", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        return texts.map(() => vector());
      },
    });
    const id = insertMessage(
      "queue deletion must commit atomically with its generated embedding",
    );
    db().exec(
      "CREATE TEMP TRIGGER fail_temporal_queue_delete BEFORE DELETE ON temporal_embedding_queue BEGIN SELECT RAISE(ABORT, 'private storage payload'); END",
    );
    try {
      startTemporalEmbeddingScheduler();
      await vi.advanceTimersByTimeAsync(0);
      expect(error.mock.calls[0]?.[0]).toContain(
        "reason=operation-failed stage=commit",
      );
      expect(queueRow(id)).not.toBeNull();
      expect(
        db()
          .query("SELECT embedding FROM temporal_messages WHERE id = ?")
          .get(id),
      ).toEqual({ embedding: null });
      expect(JSON.stringify(error.mock.calls)).not.toContain(
        "private storage payload",
      );
    } finally {
      db().exec("DROP TRIGGER fail_temporal_queue_delete");
    }
  });

  test("a row-specific commit failure defers its owner so another owner completes", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        return texts.map(() => vector());
      },
    });
    const failed = insertMessage(
      "this owner's vector write fails after inference completes",
      "backfill",
      "/test/temporal-queue/commit-failed-owner",
    );
    const healthy = insertMessage(
      "another owner must commit despite the first owner's broken storage row",
      "backfill",
      "/test/temporal-queue/commit-healthy-owner",
    );
    db().exec(
      `CREATE TEMP TRIGGER fail_one_queue_delete
       BEFORE DELETE ON temporal_embedding_queue
       WHEN OLD.message_id = '${failed}'
       BEGIN SELECT RAISE(ABORT, 'private row-specific storage payload'); END`,
    );
    try {
      await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
      expect(
        db()
          .query(
            "SELECT failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
          )
          .get(failed),
      ).toEqual({ failures: 1, retry_at: expect.any(Number) });
      expect(
        db()
          .query("SELECT embedding FROM temporal_messages WHERE id = ?")
          .get(failed),
      ).toEqual({ embedding: null });
      expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
      expect(queueRow(healthy)).toBeNull();
      expect(queueRow(failed)).not.toBeNull();
    } finally {
      db().exec("DROP TRIGGER fail_one_queue_delete");
    }
  });

  test("a live update supersedes a parked historical retry for the same source", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed() {
        throw new Error("the historical provider failed");
      },
    });
    const content =
      "a live turn must replace this source's parked historical failure";
    const id = insertMessage(content, "backfill");
    db()
      .query(
        "UPDATE temporal_embedding_queue SET fair_ahead = 1 WHERE message_id = ?",
      )
      .run(id);
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    expect(
      db()
        .query(
          "SELECT failures FROM temporal_embedding_parked WHERE message_id = ?",
        )
        .get(id),
    ).toEqual({ failures: 1 });

    enqueueTemporalEmbedding(id, content, "live");
    expect(
      db()
        .query("SELECT 1 FROM temporal_embedding_parked WHERE message_id = ?")
        .get(id),
    ).toBeNull();
    expect(
      db()
        .query(
          "SELECT priority, failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id),
    ).toEqual({ priority: 1, failures: 0, retry_at: 0 });
  });

  test("a backfill re-admission keeps the parked retry for unchanged content", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed() {
        throw new Error("a historical retry must survive a fresh source walk");
      },
    });
    const content = "unchanged historical content retains its retry deadline";
    const id = insertMessage(content, "backfill");
    db()
      .query(
        "UPDATE temporal_embedding_queue SET fair_ahead = 1 WHERE message_id = ?",
      )
      .run(id);
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    const parked = db()
      .query(
        "SELECT failures, retry_at FROM temporal_embedding_parked WHERE message_id = ?",
      )
      .get(id);
    expect(parked).not.toBeNull();

    enqueueTemporalEmbedding(id, content, "backfill");
    expect(
      db()
        .query(
          "SELECT failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id),
    ).toEqual(parked);
    expect(
      db()
        .query("SELECT 1 FROM temporal_embedding_parked WHERE message_id = ?")
        .get(id),
    ).toBeNull();
  });

  test("a changed source invalidates its parked retry before a backfill re-admission", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed() {
        throw new Error("historical content failed before changing");
      },
    });
    const id = insertMessage(
      "the original historical source with failed vector work",
      "backfill",
    );
    db()
      .query(
        "UPDATE temporal_embedding_queue SET fair_ahead = 1 WHERE message_id = ?",
      )
      .run(id);
    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    const changed = "the same source has new content and must start fresh";
    db()
      .query("UPDATE temporal_messages SET content = ? WHERE id = ?")
      .run(changed, id);

    enqueueTemporalEmbedding(id, changed, "backfill");
    expect(
      db()
        .query("SELECT 1 FROM temporal_embedding_parked WHERE message_id = ?")
        .get(id),
    ).toBeNull();
    expect(
      db()
        .query(
          "SELECT failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id),
    ).toEqual({ failures: 0, retry_at: 0 });
  });

  test("hostile thrown values cannot inject diagnostics or prevent subsequent retries", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("private getter");
        },
        getPrototypeOf() {
          throw new Error("private prototype");
        },
      },
    );
    const embed = vi.fn(async () => {
      throw hostile;
    });
    installProvider({ maxBatchSize: 8, embed });
    insertMessage(
      "untrusted failures must not break the retry reporting machinery",
    );
    startTemporalEmbeddingScheduler();
    await vi.advanceTimersByTimeAsync(1000);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).not.toMatch(
      /private|prototype|getter/,
    );
    expect(error.mock.calls[0]?.[0]).toContain(
      "reason=operation-failed stage=embed",
    );
  });

  test("refreshes stale admission metadata without sending stale content", async () => {
    const embed = vi.fn(async () => [vector()]);
    installProvider({ maxBatchSize: 8, embed });
    const current =
      "the joined base row is authoritative when queue metadata is stale";
    const id = insertMessage(current);
    db()
      .query(
        "UPDATE temporal_embedding_queue SET content_hash = 'stale', fingerprint = 'stale' WHERE message_id = ?",
      )
      .run(id);

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(0);

    expect(embed).not.toHaveBeenCalled();
    expect(queueRow(id)).toEqual({
      content_hash: temporalContentHash(current),
    });
    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
  });

  test("cannot refresh another tenant's queue row after a concurrent transfer", async () => {
    const servedBy: string[] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        servedBy.push(currentTenantId());
        return texts.map(() => vector());
      },
    });
    const id = withTenant("tenant-a", () =>
      insertMessage(
        "stale source metadata must not be rewritten by its former owner",
        "backfill",
      ),
    );
    db()
      .query(
        "UPDATE temporal_embedding_queue SET content_hash = 'stale', fingerprint = 'stale', failures = 1, retry_at = 0 WHERE message_id = ?",
      )
      .run(id);
    const destination = withTenant("tenant-b", () =>
      ensureProject("/test/temporal-queue/refresh-transfer-destination"),
    );
    // A partial upgrade can lose the project-move trigger before this drain.
    db().exec("DROP TRIGGER temporal_embedding_queue_project_update");
    const competitor = new DatabaseSync(dbPath());
    const queueState = () =>
      db()
        .query(
          "SELECT project_id, content_hash, fingerprint, failures, retry_at FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id);
    const transfer: {
      moved: boolean;
      stateAfter: ReturnType<typeof queueState> | null;
    } = {
      moved: false,
      stateAfter: null,
    };
    log.registerSink({
      ...passthroughSink,
      withDbSpan<T>(sql: string, fn: () => T): T {
        if (
          !transfer.moved &&
          sql.includes("SET content_hash = ?, fingerprint = ?")
        ) {
          transfer.moved = true;
          competitor
            .prepare("UPDATE temporal_messages SET project_id = ? WHERE id = ?")
            .run(destination, id);
          transfer.stateAfter = queueState();
        }
        return fn();
      },
    });
    try {
      expect(await drainTemporalEmbeddingQueueOnce()).toBe(0);
      expect(transfer.moved).toBe(true);
      expect(transfer.stateAfter).not.toBeNull();
      expect(queueState()).toEqual(transfer.stateAfter);
      expect(servedBy).toEqual([]);
    } finally {
      log.registerSink(passthroughSink);
      competitor.close();
    }
    close();
    expect(await drainTemporalEmbeddingQueueOnce()).toBe(0);
    expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
    expect(servedBy).toEqual(["tenant-b"]);
  });

  test("admits at most eight distinct message rows per drain", async () => {
    const requests: string[][] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        requests.push(texts);
        return texts.map(() => vector());
      },
    });
    const ids = Array.from({ length: 9 }, (_, index) =>
      insertMessage(
        `bounded scheduler admission message ${index} has semantic content`,
        "live",
        "/test/bounded-drain-owner",
      ),
    );

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(8);

    expect(requests.flat()).toHaveLength(8);
    expect(ids.filter((id) => queueRow(id) !== null)).toHaveLength(1);
  });

  test("reads admitted text under its owner and never scans temporal vec0 auxiliaries", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        return texts.map(() => vector());
      },
    });
    Array.from({ length: 8 }, (_, index) =>
      insertMessage(
        `ordinary scheduler message ${index} stays below the byte budget`,
        "live",
        "/test/ordinary-drain-owner",
      ),
    );
    const sql: string[] = [];
    log.registerSink({
      ...passthroughSink,
      withDbSpan<T>(statement: string, fn: () => T): T {
        sql.push(statement);
        return fn();
      },
    });

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(8);

    expect(
      sql.filter(
        (statement) =>
          statement.includes("END AS content_bytes") &&
          statement.includes("JOIN temporal_embedding_queue q") &&
          statement.includes("p.tenant_id = ?"),
      ),
    ).toHaveLength(8);
    expect(
      sql.filter((statement) =>
        statement.includes(
          "SELECT substr(CAST(t.content AS BLOB), ?, ?) AS value",
        ),
      ).length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      sql.some(
        (statement) =>
          statement.includes("temporal_vec") &&
          statement.includes("message_id"),
      ),
    ).toBe(false);
  });

  test("bounds admitted content bytes without evicting the durable backlog", async () => {
    const requests: string[][] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        requests.push([...texts]);
        return texts.map(() => vector());
      },
    });
    const first = insertMessage("a".repeat(200 * 1024));
    const second = insertMessage("b".repeat(100 * 1024));

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);

    expect(requests).toHaveLength(1);
    expect(requests[0][0]).toContain("a");
    expect(queueRow(first)).toBeNull();
    expect(queueRow(second)).not.toBeNull();
  });

  test("bounds one oversized multibyte row while hashing its full content", async () => {
    let projected = "";
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        projected = texts.join("");
        return texts.map(() => vector());
      },
    });
    const content = "界".repeat(100_000);
    const id = insertMessage(content);
    expect(queueRow(id)?.content_hash).toBe(
      createHash("sha256").update(content).digest("hex"),
    );

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);

    expect(Buffer.byteLength(projected, "utf8")).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(projected.length).toBeLessThan(content.length);
    expect(queueRow(id)).toBeNull();
  });

  test("hashes and projects oversized content past embedded NUL", async () => {
    const requests: string[][] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        requests.push([...texts]);
        return texts.map(() => vector());
      },
    });
    const marker = "marker-after-nul";
    const content = `prefix\0${marker}${"界".repeat(100_000)}`;
    const expectedHash = createHash("sha256").update(content).digest("hex");
    const id = insertMessage(content);
    expect(queueRow(id)?.content_hash).toBe(expectedHash);

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);

    expect(requests).toHaveLength(1);
    const projected = requests[0].join("");
    expect(projected).toContain(marker);
    expect(Buffer.byteLength(projected, "utf8")).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(queueRow(id)).toBeNull();
    expect(
      db()
        .query(
          "SELECT content_hash FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(id),
    ).toBeNull();
  });

  test("short and unit-empty updates clear prior blob vectors after CAS", async () => {
    installProvider({
      maxBatchSize: 8,
      embed: vi.fn(async () => {
        throw new Error("empty jobs must not call the provider");
      }),
    });
    const shortId = insertMessage("short", "live", "/test/empty-drain-owner");
    const emptyId = insertMessage(
      " ".repeat(60),
      "live",
      "/test/empty-drain-owner",
    );
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id IN (?, ?)")
      .run(vector().buffer, shortId, emptyId);

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(2);

    const rows = db()
      .query(
        "SELECT id, embedding FROM temporal_messages WHERE id IN (?, ?) ORDER BY id",
      )
      .all(shortId, emptyId) as unknown as Array<{
      id: string;
      embedding: Uint8Array | null;
    }>;
    expect(rows.map((row) => row.embedding)).toEqual([null, null]);
    expect(queueRow(shortId)).toBeNull();
    expect(queueRow(emptyId)).toBeNull();
  });

  test("drains after restart even when the old rechunk done flag is set", async () => {
    const called = deferred<void>();
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        called.resolve();
        return texts.map(() => vector());
      },
    });
    const id = insertMessage(
      "restart recovery is independent of the legacy rechunk completion flag",
    );
    setKV("lore:temporal_rechunk.done", "1");

    startTemporalEmbeddingScheduler();
    startTemporalEmbeddingScheduler();
    await called.promise;
    await expect(settleTemporalEmbeddingScheduler()).resolves.toBe(true);
    stopTemporalEmbeddingScheduler();
    stopTemporalEmbeddingScheduler();
    expect(queueRow(id)).toBeNull();
  });

  test("stores one blob vector and a complete vec0 unit set", async () => {
    const originalMode = readStorageMode(db());
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        return texts.map((_, index) => vector(index + 1));
      },
    });
    const blobId = insertMessage(
      "blob mode joins all part-aware units into one compatible stored vector",
    );
    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    const blob = db()
      .query("SELECT embedding FROM temporal_messages WHERE id = ?")
      .get(blobId) as { embedding: Uint8Array | null };
    expect(blob.embedding?.byteLength).toBe(vector().byteLength);

    ensureVec0Store(db(), config().search.embeddings.dimensions);
    setStorageMode(db(), "vec0");
    const vecId = insertMessage(
      `first independent semantic unit\n\x1fsecond independent semantic unit`,
    );
    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    const chunks = db()
      .query(
        "SELECT chunk_id FROM temporal_vec WHERE message_id = ? ORDER BY chunk_id",
      )
      .all(vecId) as unknown as Array<{ chunk_id: string }>;
    expect(chunks.map((row) => row.chunk_id)).toEqual([
      `${vecId}#0`,
      `${vecId}#1`,
    ]);

    setStorageMode(db(), originalMode);
  });

  test("bounds each durable drain by units while committing complete messages", async () => {
    const originalMode = readStorageMode(db());
    const requests: number[] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        requests.push(texts.length);
        return texts.map(() => vector());
      },
    });
    try {
      ensureVec0Store(db(), config().search.embeddings.dimensions);
      setStorageMode(db(), "vec0");
      const content = Array.from(
        { length: 13 },
        (_, index) =>
          `semantic part ${index} with enough context for one vector`,
      ).join("\n\x1f");
      const first = insertMessage(content);
      const second = insertMessage(content);

      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
      expect(requests.reduce((sum, count) => sum + count, 0)).toBe(13);
      expect(queueRow(first)).toBeNull();
      expect(queueRow(second)).not.toBeNull();
      const stored = db()
        .query("SELECT COUNT(*) AS n FROM temporal_vec WHERE message_id = ?")
        .get(first) as { n: number };
      expect(stored.n).toBe(13);
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
      expect(queueRow(second)).toBeNull();
    } finally {
      setStorageMode(db(), originalMode);
    }
  });

  test.each(
    (["blob", "vec0"] as const).flatMap((mode) => [
      {
        mode,
        defect: "wrong dimension",
        invalidVector: () =>
          new Float32Array(config().search.embeddings.dimensions - 1),
      },
      {
        mode,
        defect: "NaN component",
        invalidVector: () => {
          const value = vector();
          value[0] = Number.NaN;
          return value;
        },
      },
      {
        mode,
        defect: "infinite component",
        invalidVector: () => {
          const value = vector();
          value[0] = Number.POSITIVE_INFINITY;
          return value;
        },
      },
    ]),
  )(
    "$mode rejects a provider vector with $defect before retiring durable work",
    async ({ mode, invalidVector }) => {
      const originalMode = readStorageMode(db());
      if (mode === "vec0") {
        ensureVec0Store(db(), config().search.embeddings.dimensions);
      }
      setStorageMode(db(), mode);
      const id = insertMessage(
        `malformed ${mode} provider output must preserve durable work and stored vectors`,
      );
      const originalVector = vector(7);
      if (mode === "vec0") {
        storeTemporalChunks(db(), id, [originalVector]);
      } else {
        db()
          .query("UPDATE temporal_messages SET embedding = ? WHERE id = ?")
          .run(new Uint8Array(originalVector.buffer), id);
      }
      const storedBytes = (): number[] => {
        const row =
          mode === "vec0"
            ? (db()
                .query("SELECT embedding FROM temporal_vec WHERE chunk_id = ?")
                .get(`${id}#0`) as {
                embedding: ArrayBuffer | Uint8Array;
              } | null)
            : (db()
                .query("SELECT embedding FROM temporal_messages WHERE id = ?")
                .get(id) as {
                embedding: ArrayBuffer | Uint8Array | null;
              } | null);
        const embedding = row?.embedding;
        if (!embedding) return [];
        return Array.from(
          embedding instanceof Uint8Array
            ? embedding
            : new Uint8Array(embedding),
        );
      };
      const originalBytes = storedBytes();
      expect(originalBytes).toEqual(
        Array.from(new Uint8Array(originalVector.buffer)),
      );
      installProvider({
        maxBatchSize: 8,
        async embed(texts) {
          return texts.map(() => invalidVector());
        },
      });

      let error: unknown;
      try {
        await drainTemporalEmbeddingQueueOnce();
      } catch (cause) {
        error = cause;
      }

      expect.soft(error).toEqual(expect.any(Error));
      expect.soft(queueRow(id)).not.toBeNull();
      expect.soft(storedBytes()).toEqual(originalBytes);
      setStorageMode(db(), originalMode);
    },
  );

  test("malformed provider output preserves every job in a mixed drain", async () => {
    const shortId = insertMessage("short", "live", "/test/malformed-owner");
    const normalId = insertMessage(
      "normal semantic content requires provider inference in the same drain",
      "live",
      "/test/malformed-owner",
    );
    const shortVector = vector(3);
    const normalVector = vector(7);
    const storedBytes = (id: string): number[] => {
      const row = db()
        .query("SELECT embedding FROM temporal_messages WHERE id = ?")
        .get(id) as {
        embedding: ArrayBuffer | Uint8Array | null;
      } | null;
      const value = row?.embedding;
      if (!value) return [];
      return Array.from(
        value instanceof Uint8Array ? value : new Uint8Array(value),
      );
    };
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id = ?")
      .run(new Uint8Array(shortVector.buffer), shortId);
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id = ?")
      .run(new Uint8Array(normalVector.buffer), normalId);
    const shortBytes = storedBytes(shortId);
    const normalBytes = storedBytes(normalId);
    expect(shortBytes).toEqual(Array.from(new Uint8Array(shortVector.buffer)));
    expect(normalBytes).toEqual(
      Array.from(new Uint8Array(normalVector.buffer)),
    );
    installProvider({
      maxBatchSize: 8,
      async embed() {
        return [new Float32Array(config().search.embeddings.dimensions - 1)];
      },
    });

    await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow(
      "temporal embedding produced an invalid vector",
    );

    expect(queueRow(shortId)).not.toBeNull();
    expect(queueRow(normalId)).not.toBeNull();
    expect(storedBytes(shortId)).toEqual(shortBytes);
    expect(storedBytes(normalId)).toEqual(normalBytes);
  });

  test("stores reduced part-aware vec0 units and drops empty units", async () => {
    const originalMode = readStorageMode(db());
    ensureVec0Store(db(), config().search.embeddings.dimensions);
    setStorageMode(db(), "vec0");
    const requests: string[][] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        requests.push([...texts]);
        return texts.map(() => vector());
      },
    });
    const id = insertMessage(
      `   \n\x1fInvestigating the parser regression in detail.\n\x1f[reasoning] Likely the tokenizer boundary.\n\x1f[tool:read] src/parse.ts\n${"BODY ".repeat(1000)}`,
    );

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);

    expect(requests.flat()).toEqual([
      "Investigating the parser regression in detail.",
      "[reasoning] Likely the tokenizer boundary.",
      "[tool:read] src/parse.ts",
    ]);
    const chunks = db()
      .query(
        "SELECT chunk_id FROM temporal_vec WHERE message_id = ? ORDER BY chunk_id",
      )
      .all(id) as unknown as Array<{ chunk_id: string }>;
    expect(chunks).toHaveLength(3);
    setStorageMode(db(), originalMode);
  });

  test("sub-batches many units and folds overflow into the final bounded chunk", async () => {
    const originalMode = readStorageMode(db());
    ensureVec0Store(db(), config().search.embeddings.dimensions);
    setStorageMode(db(), "vec0");
    const requests: string[][] = [];
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        requests.push([...texts]);
        return texts.map(() => vector());
      },
    });
    const units = Array.from(
      { length: MAX_TEMPORAL_CHUNKS_PER_MESSAGE + 1 },
      (_, index) => `unit-${index}-distinct-payload`,
    );
    const id = insertMessage(units.join("\n\x1f"));

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flat()).toHaveLength(MAX_TEMPORAL_CHUNKS_PER_MESSAGE);
    const last = requests.flat().at(-1);
    expect(last).toContain(`unit-${MAX_TEMPORAL_CHUNKS_PER_MESSAGE - 1}-`);
    expect(last).toContain(`unit-${MAX_TEMPORAL_CHUNKS_PER_MESSAGE}-`);
    const count = db()
      .query("SELECT COUNT(*) AS n FROM temporal_vec WHERE message_id = ?")
      .get(id) as { n: number };
    expect(count.n).toBe(MAX_TEMPORAL_CHUNKS_PER_MESSAGE);
    setStorageMode(db(), originalMode);
  });

  test("clears a stale vec0 set when updated content becomes short", async () => {
    const originalMode = readStorageMode(db());
    ensureVec0Store(db(), config().search.embeddings.dimensions);
    setStorageMode(db(), "vec0");
    const id = insertMessage("tiny");
    storeTemporalChunks(db(), id, [vector(), vector(2)]);

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
    const count = db()
      .query("SELECT COUNT(*) AS n FROM temporal_vec WHERE message_id = ?")
      .get(id) as { n: number };
    expect(count.n).toBe(0);
    setStorageMode(db(), originalMode);
  });
});
