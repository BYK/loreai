import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { config } from "../src/config";
import { db, ensureProject, setKV } from "../src/db";
import {
  ensureVec0Store,
  readStorageMode,
  setStorageMode,
  storeTemporalChunks,
} from "../src/db/vec-store";
import {
  _restoreProvider,
  _saveAndClearProvider,
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
} from "../src/temporal-embedding-queue";
import { MAX_TEMPORAL_CHUNKS_PER_MESSAGE } from "../src/embedding-units";
import * as log from "../src/log";

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

function insertMessage(content: string): string {
  sequence++;
  const id = `temporal-queue-${sequence}`;
  const project = ensureProject(`/test/temporal-queue/${sequence}`);
  db()
    .query(
      `INSERT INTO temporal_messages
       (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, ?, 'user', ?, 1, 0, ?, '{}')`,
    )
    .run(id, id, project, `session-${sequence}`, content, Date.now());
  enqueueTemporalEmbedding(id, content);
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
  _restoreProvider(savedProvider);
  log.registerSink(passthroughSink);
  vi.restoreAllMocks();
});

describe("durable temporal embedding scheduler", () => {
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
    );
    insertMessage(
      "second message shares the same bounded provider request safely",
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

  test("scheduler failures emit only a fixed content-free message", async () => {
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
      "temporal embedding scheduler drain failed",
    );
    const rendered = JSON.stringify(error.mock.calls);
    expect(rendered).not.toContain(content);
    expect(rendered).not.toContain(id);
    expect(rendered).not.toContain("private provider diagnostic");
    expect(queueRow(id)).not.toBeNull();
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
      ),
    );

    await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(8);

    expect(requests.flat()).toHaveLength(8);
    expect(ids.filter((id) => queueRow(id) !== null)).toHaveLength(1);
  });

  test("fetches ordinary admitted content once and never scans temporal vec0 auxiliaries", async () => {
    installProvider({
      maxBatchSize: 8,
      async embed(texts) {
        return texts.map(() => vector());
      },
    });
    Array.from({ length: 8 }, (_, index) =>
      insertMessage(
        `ordinary scheduler message ${index} stays below the byte budget`,
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
      sql.filter((statement) =>
        statement.includes("FROM temporal_messages WHERE id IN"),
      ),
    ).toHaveLength(1);
    expect(
      sql.filter((statement) =>
        statement.includes(
          "SELECT substr(CAST(content AS BLOB), ?, ?) AS value",
        ),
      ),
    ).toHaveLength(8);
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
    const shortId = insertMessage("short");
    const emptyId = insertMessage(" ".repeat(60));
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
    const shortId = insertMessage("short");
    const normalId = insertMessage(
      "normal semantic content requires provider inference in the same drain",
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
