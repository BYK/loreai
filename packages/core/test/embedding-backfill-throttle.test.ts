import { readFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config";
import * as data from "../src/data";
import {
  close,
  db,
  dbPath,
  ensureProject,
  getKV,
  mergeProjectInternal,
  setKV,
  databaseInTransaction,
} from "../src/db";
import {
  ensureVec0Store,
  setStorageMode,
  storeTemporalChunks,
} from "../src/db/vec-store";
import { enqueueTemporalEmbedding } from "../src/temporal-embedding-admission";
import * as log from "../src/log";
import { currentTenantId, withTenant } from "../src/tenant";
import { drainTemporalEmbeddingQueueOnce } from "../src/temporal-embedding-queue";
import { store as storeTemporalMessage } from "../src/temporal";
import {
  backfillTemporalEmbeddings,
  runStartupBackfill,
  resetTemporalRechunkProgress,
  _setRecallEmbedsInFlightForTest,
  _restoreProvider,
  _saveAndClearProvider,
} from "../src/embedding";

// The temporal re-chunk walk only admits durable work. CPU-intensive provider
// throttling belongs to the bounded scheduler, never this metadata walk.

const PROJECT = "/test/backfill-throttle";

function insertMsg(id: string, pid: string): void {
  const content = `temporal message ${id} with more than enough content to embed`;
  db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, 's', 'user', ?, 0, 0, 0)",
    )
    .run(id, pid, content);
}

describe("temporal re-chunk backfill CPU throttle", () => {
  let pid: string;
  let providerToken: unknown;
  const embed = vi.fn();

  beforeEach(() => {
    pid = ensureProject(PROJECT);
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), config().search.embeddings.dimensions);
    db().query("DELETE FROM temporal_vec").run();
    db().query("DELETE FROM temporal_messages").run();
    resetTemporalRechunkProgress();
    embed.mockReset();
    providerToken = _saveAndClearProvider();
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        embed,
      },
    });
  });

  afterEach(() => {
    _setRecallEmbedsInFlightForTest(0);
    vi.restoreAllMocks();
    _restoreProvider(providerToken);
    delete process.env.LORE_BACKFILL_CPU_DUTY;
  });

  it("parks while a recall embed occupies the shared pool", async () => {
    insertMsg("recall-busy", pid);
    _setRecallEmbedsInFlightForTest(1);

    const backfill = backfillTemporalEmbeddings();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(getKV("lore:temporal_rechunk.cursor")).toBe("");

    _setRecallEmbedsInFlightForTest(0);
    await expect(backfill).resolves.toBe(1);
  });

  it("stops a parked startup walk on abort without advancing its durable cursor", async () => {
    insertMsg("shutdown-pending", pid);
    const controller = new AbortController();
    const gate = { paused: true };
    let notifyParked: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      notifyParked = resolve;
    });
    const walk = runStartupBackfill({
      signal: controller.signal,
      shouldPause: () => {
        if (gate.paused) notifyParked?.();
        return gate.paused;
      },
    });
    let settled = false;
    void walk.then(() => {
      settled = true;
    });
    try {
      await parked;
      expect(getKV("lore:temporal_rechunk.cursor")).toBe("");
      controller.abort();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 800 });
      expect((await walk).temporalRechunked).toBe(0);
      expect(getKV("lore:temporal_rechunk.cursor")).toBe("");
      expect(getKV("lore:temporal_rechunk.done")).not.toBe("1");
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'shutdown-pending'",
          )
          .get(),
      ).toBeNull();
    } finally {
      gate.paused = false;
      await walk;
    }
  });

  it("reads temporal source text only in its owner's tenant context", async () => {
    const tenant = "tenant-temporal-source";
    const project = withTenant(tenant, () =>
      ensureProject("/test/tenant-temporal-source"),
    );
    withTenant(tenant, () =>
      insertMsg("owner-scoped-temporal-source", project),
    );
    const reads: string[] = [];
    log.registerSink({
      info() {},
      warn() {},
      error() {},
      captureException() {},
      withDbSpan<T>(sql: string, fn: () => T): T {
        if (sql.includes("SELECT t.content FROM temporal_messages t")) {
          reads.push(currentTenantId());
        }
        return fn();
      },
    });
    try {
      expect(await backfillTemporalEmbeddings()).toBe(1);
      expect(reads).toEqual([tenant]);
    } finally {
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
      });
    }
  });

  it("admits temporal work when every informational diagnostic fails", async () => {
    insertMsg("info-sink-temporal", pid);
    log.registerSink({
      info() {
        throw new Error("diagnostic sink unavailable");
      },
      warn() {},
      error() {},
      captureException() {},
    });
    try {
      await expect(backfillTemporalEmbeddings()).resolves.toBe(1);
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'info-sink-temporal'",
          )
          .get(),
      ).not.toBeNull();
    } finally {
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
      });
    }
  });

  it.each([false, true])(
    "serves HTTP during admission (already queued: %s)",
    async (alreadyQueued) => {
      const count = 256;
      for (let i = 0; i < count; i++) {
        const id = `http-${String(i).padStart(5, "0")}`;
        insertMsg(id, pid);
        if (alreadyQueued)
          enqueueTemporalEmbedding(
            id,
            `temporal message ${id} with more than enough content to embed`,
          );
      }
      const server = createServer((_req, res) => {
        res.end(
          JSON.stringify({
            cursor: getKV("lore:temporal_rechunk.cursor"),
            done: getKV("lore:temporal_rechunk.done"),
            inTransaction: databaseInTransaction(db()),
          }),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing HTTP listener");
      let probe:
        | Promise<{
            cursor: string | null;
            done: string | null;
            inTransaction: boolean;
          }>
        | undefined;
      try {
        const processed = await backfillTemporalEmbeddings({
          shouldPause: () => {
            // Issue real I/O only after admission has started. A resolved Promise
            // or queueMicrotask does not allow this request's callback to run.
            probe ??= new Promise((resolve, reject) => {
              get(`http://127.0.0.1:${address.port}/health`, (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                  body += chunk;
                });
                res.on("end", () => {
                  resolve(JSON.parse(body));
                });
                res.on("error", reject);
              }).on("error", reject);
            });
            return false;
          },
        });
        const observed = await probe;
        expect(processed).toBe(alreadyQueued ? 0 : count);
        expect(observed?.cursor).toMatch(/^http-/);
        expect(observed?.inTransaction).toBe(false);
        expect(observed?.cursor).not.toBe(
          `http-${String(count - 1).padStart(5, "0")}`,
        );
        expect(observed?.done).not.toBe("1");
        expect(getKV("lore:temporal_rechunk.done")).toBe("1");
        expect(embed).not.toHaveBeenCalled();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("parks at the durable window and resumes when a committed row frees space", async () => {
    const count = 513;
    for (let i = 0; i < count; i++)
      insertMsg(`window-${String(i).padStart(5, "0")}`, pid);

    const walk = backfillTemporalEmbeddings({
      shouldPause: () => {
        throw new Error("host pause predicate unavailable");
      },
    });
    try {
      await vi.waitFor(
        () => {
          const pending = db()
            .query("SELECT COUNT(*) AS n FROM temporal_embedding_queue")
            .get() as { n: number };
          expect(pending.n).toBe(512);
        },
        { timeout: 20_000 },
      );
      expect(getKV("lore:temporal_rechunk.cursor")).toBe("window-00511");
      expect(getKV("lore:temporal_rechunk.done")).not.toBe("1");

      embed.mockImplementation(async (texts: string[]) =>
        texts.map(() => {
          const vector = new Float32Array(
            config().search.embeddings.dimensions,
          );
          vector[0] = 1;
          return vector;
        }),
      );
      // A real drain frees space. The next backfill page must admit work
      // without restarting or discarding the remaining old queue.
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(8);
      await expect(walk).resolves.toBe(count);
      const pending = db()
        .query("SELECT COUNT(*) AS n FROM temporal_embedding_queue")
        .get() as { n: number };
      expect(pending.n).toBe(505);
      expect(getKV("lore:temporal_rechunk.done")).toBe("1");
    } finally {
      db().query("DELETE FROM temporal_embedding_queue").run();
      await walk;
    }
  }, 30_000);

  it("resumes the 513th historical row when park and resume diagnostics throw", async () => {
    for (let i = 0; i < 513; i++)
      insertMsg(`diagnostic-${String(i).padStart(5, "0")}`, pid);
    const diagnostics: string[] = [];
    log.registerSink({
      info(message) {
        if (
          message.startsWith("temporal re-chunk parked") ||
          message.startsWith("temporal re-chunk resumed")
        ) {
          diagnostics.push(message);
          throw new Error("log sink unavailable");
        }
      },
      warn() {},
      error() {},
      captureException() {},
    });
    embed.mockImplementation(async (texts: string[]) =>
      texts.map(() => {
        const vector = new Float32Array(config().search.embeddings.dimensions);
        vector[0] = 1;
        return vector;
      }),
    );
    const gate = { block: true };
    const walk = backfillTemporalEmbeddings({
      shouldPause: () =>
        gate.block &&
        getKV("lore:temporal_rechunk.cursor") === "diagnostic-00511",
    });
    // Attach a rejection handler while deliberately testing a failed walk.
    void walk.catch(() => {});
    try {
      await vi.waitFor(
        () =>
          expect(
            db()
              .query("SELECT COUNT(*) AS n FROM temporal_embedding_queue")
              .get(),
          ).toEqual({ n: 512 }),
        { timeout: 8_000 },
      );
      expect(getKV("lore:temporal_rechunk.cursor")).toBe("diagnostic-00511");
      await vi.waitFor(
        () =>
          expect(
            diagnostics.some((message) => message.includes("parked")),
          ).toBe(true),
        { timeout: 8_000 },
      );
      gate.block = false;
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(8);
      await vi.waitFor(
        () =>
          expect(
            diagnostics.some((message) => message.includes("resumed")),
          ).toBe(true),
        { timeout: 8_000 },
      );
      await expect(walk).resolves.toBe(513);
      expect(getKV("lore:temporal_rechunk.done")).toBe("1");
      expect(diagnostics.some((message) => message.includes("parked"))).toBe(
        true,
      );
      expect(diagnostics.some((message) => message.includes("resumed"))).toBe(
        true,
      );
    } finally {
      gate.block = false;
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
      });
      resetTemporalRechunkProgress();
      await walk.catch(() => {});
    }
  });

  it.each(["merge", "move"] as const)(
    "does not skip an unqueued message moved below the destination's fair cursor (%s)",
    async (method) => {
      for (let i = 0; i < 512; i++)
        insertMsg(`a-move-${String(i).padStart(5, "0")}`, pid);
      // The fair rotation reaches the destination before the source, so the
      // source's unqueued row cannot be admitted by a separate fair probe.
      const firstPath = `/test/fair-move-owner-first-${method}`;
      const secondPath = `/test/fair-move-owner-second-${method}`;
      const first = ensureProject(firstPath);
      const second = ensureProject(secondPath);
      const [source, destination, destinationPath] =
        first < second
          ? [second, first, firstPath]
          : [first, second, secondPath];
      const movedId = "m-unqueued-after-fair-admission";
      const fairId = "z-destination-fair-admission";
      db()
        .query(
          "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, 'moved-session', 'user', ?, 0, 0, 0)",
        )
        .run(
          movedId,
          source,
          "this moved temporal message is long enough to embed",
        );
      insertMsg(fairId, destination);
      // A real queued row fills the 512th slot before its main-walk page is
      // complete. The walk resumes that page, then fetches m after the move.
      enqueueTemporalEmbedding(
        "a-move-00511",
        "temporal message a-move-00511 with more than enough content to embed",
        "backfill",
      );
      embed.mockImplementation(async (texts: string[]) =>
        texts.map(() => {
          const vector = new Float32Array(
            config().search.embeddings.dimensions,
          );
          vector[0] = 1;
          return vector;
        }),
      );

      const walk = backfillTemporalEmbeddings();
      try {
        await vi.waitFor(
          () => {
            expect(
              db()
                .query(
                  "SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?",
                )
                .get(fairId),
            ).not.toBeNull();
          },
          { timeout: 8_000 },
        );
        expect(getKV("lore:temporal_rechunk.cursor")).toBe("a-move-00510");
        expect(getKV(`lore:temporal_rechunk.fair:${destination}`)).toBe(fairId);
        expect(
          db()
            .query(
              "SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?",
            )
            .get(movedId),
        ).toBeNull();

        if (method === "merge") mergeProjectInternal(source, destination);
        else
          data.moveSessions(["moved-session"], source, destinationPath, {
            includeChildren: false,
          });
        expect(
          db()
            .query("SELECT project_id FROM temporal_messages WHERE id = ?")
            .get(movedId),
        ).toEqual({ project_id: destination });

        // A real drain frees the parked window. Keep the other old rows
        // deferred so the newly admitted message can be committed separately.
        db()
          .query(
            "UPDATE temporal_embedding_queue SET failures = 1, retry_at = ? WHERE message_id LIKE 'a-move-%' AND message_id != 'a-move-00000'",
          )
          .run(Date.now() + 60_000);
        await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
        await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
        const queuedMoved = () =>
          db()
            .query(
              "SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?",
            )
            .get(movedId);
        const embeddedMoved = () =>
          db()
            .query("SELECT 1 FROM temporal_vec WHERE chunk_id = ?")
            .get(`${movedId}#0`);
        await vi.waitFor(
          () => {
            expect(queuedMoved() ?? embeddedMoved()).not.toBeNull();
          },
          { timeout: 4_000 },
        );
        for (const _turn of [0, 1, 2, 3]) {
          if (embeddedMoved() && getKV("lore:temporal_rechunk.done") === "1")
            break;
          await drainTemporalEmbeddingQueueOnce();
        }
        await expect(walk).resolves.toBeGreaterThan(0);
        expect(getKV("lore:temporal_rechunk.done")).toBe("1");
        expect(embeddedMoved()).not.toBeNull();
      } finally {
        resetTemporalRechunkProgress();
        await walk;
      }
    },
  );

  it("uses the current owner after a fetched page is moved while the walk is parked", async () => {
    for (let i = 0; i < 512; i++)
      insertMsg(`a-stale-${String(i).padStart(5, "0")}`, pid);
    const source = ensureProject("/test/stale-page-source");
    const destinationPath = "/test/stale-page-destination";
    const destination = ensureProject(destinationPath);
    const movedId = "m-stale-page-moved";
    const fairId = "z-stale-page-source-fair";
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, 'stale-session', 'user', ?, 0, 0, 0)",
      )
      .run(
        movedId,
        source,
        "this moved historical message is long enough to require an embedding vector",
      );
    insertMsg(fairId, source);
    let entered = false;
    let parked = true;
    embed.mockImplementation(async (texts: string[]) =>
      texts.map(() => {
        const vector = new Float32Array(config().search.embeddings.dimensions);
        vector[0] = 1;
        return vector;
      }),
    );

    const walk = backfillTemporalEmbeddings({
      shouldPause: () => {
        if (
          parked &&
          getKV("lore:temporal_rechunk.cursor") === "a-stale-00511"
        ) {
          entered = true;
          return true;
        }
        return false;
      },
    });
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 8_000 });
      expect(getKV("lore:temporal_rechunk.cursor")).toBe("a-stale-00511");
      expect(
        db()
          .query("SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?")
          .get(movedId),
      ).toBeNull();
      data.moveSessions(["stale-session"], source, destinationPath, {
        includeChildren: false,
      });
      expect(
        db()
          .query("SELECT project_id FROM temporal_messages WHERE id = ?")
          .get(movedId),
      ).toEqual({ project_id: destination });
      const owners = [pid, source, destination].sort();
      setKV(
        "lore:temporal_rechunk.skip",
        owners[owners.indexOf(source) - 1] ?? "",
      );
      parked = false;
      await vi.waitFor(
        () =>
          expect(getKV(`lore:temporal_rechunk.fair:${source}`)).toBe(fairId),
        { timeout: 8_000 },
      );
      expect(
        db()
          .query("SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?")
          .get(movedId),
      ).toBeNull();
      db()
        .query(
          "UPDATE temporal_embedding_queue SET failures = 1, retry_at = ? WHERE message_id LIKE 'a-stale-%' AND message_id != 'a-stale-00000'",
        )
        .run(Date.now() + 60_000);
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
      await vi.waitFor(
        () =>
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?",
              )
              .get(movedId) ??
              db()
                .query("SELECT 1 FROM temporal_vec WHERE chunk_id = ?")
                .get(`${movedId}#0`),
          ).not.toBeNull(),
        { timeout: 4_000 },
      );
      for (const _turn of [0, 1, 2, 3]) {
        if (
          getKV("lore:temporal_rechunk.done") === "1" &&
          db()
            .query("SELECT 1 FROM temporal_vec WHERE chunk_id = ?")
            .get(`${movedId}#0`)
        )
          break;
        await drainTemporalEmbeddingQueueOnce();
      }
      await expect(walk).resolves.toBeGreaterThan(0);
      expect(getKV("lore:temporal_rechunk.done")).toBe("1");
      expect(
        db()
          .query("SELECT 1 FROM temporal_vec WHERE chunk_id = ?")
          .get(`${movedId}#0`),
      ).not.toBeNull();
    } finally {
      parked = false;
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("invalidates destination fair progress when ownership changes before the move transaction", async () => {
    for (let i = 0; i < 512; i++)
      insertMsg(`a-race-${String(i).padStart(5, "0")}`, pid);
    const source = ensureProject("/test/race-source");
    const destinationPath = "/test/race-destination";
    const destination = ensureProject(destinationPath);
    const origin = ensureProject("/test/race-origin");
    const movedId = "m-race-moved";
    const fairId = "z-race-fair";
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, 'race-session', 'user', ?, 0, 0, 0)",
      )
      .run(
        movedId,
        origin,
        "concurrent ownership change of a historical temporal message that needs embedding",
      );
    insertMsg(fairId, destination);
    embed.mockImplementation(async (texts: string[]) =>
      texts.map(() => {
        const vector = new Float32Array(config().search.embeddings.dimensions);
        vector[0] = 1;
        return vector;
      }),
    );
    const owners = [pid, origin, source, destination].sort();
    setKV(
      "lore:temporal_rechunk.skip",
      owners[owners.indexOf(destination) - 1] ?? "",
    );
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(
        () =>
          expect(getKV(`lore:temporal_rechunk.fair:${destination}`)).toBe(
            fairId,
          ),
        { timeout: 8_000 },
      );
      expect(
        db()
          .query("SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?")
          .get(movedId),
      ).toBeNull();
      const competitor = new DatabaseSync(dbPath());
      let competed = false;
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
        withDbSpan<T>(sql: string, fn: () => T): T {
          const result = fn();
          if (
            !competed &&
            /SELECT tenant_id FROM projects WHERE id = \?/i.test(sql)
          ) {
            competed = true;
            competitor
              .prepare(
                "UPDATE temporal_messages SET project_id = ? WHERE id = ?",
              )
              .run(source, movedId);
          }
          return result;
        },
      });
      try {
        data.moveSessions(["race-session"], source, destinationPath, {
          includeChildren: false,
        });
      } finally {
        log.registerSink({
          info() {},
          warn() {},
          error() {},
          captureException() {},
        });
        competitor.close();
      }
      expect(competed).toBe(true);
      expect(
        db()
          .query("SELECT project_id FROM temporal_messages WHERE id = ?")
          .get(movedId),
      ).toEqual({ project_id: destination });
      db()
        .query(
          "UPDATE temporal_embedding_queue SET failures = 1, retry_at = ? WHERE message_id LIKE 'a-race-%' AND message_id != 'a-race-00000'",
        )
        .run(Date.now() + 60_000);
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
      await vi.waitFor(
        () =>
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?",
              )
              .get(movedId) ??
              db()
                .query("SELECT 1 FROM temporal_vec WHERE chunk_id = ?")
                .get(`${movedId}#0`),
          ).not.toBeNull(),
        { timeout: 4_000 },
      );
      for (const _turn of [0, 1, 2, 3]) {
        if (
          getKV("lore:temporal_rechunk.done") === "1" &&
          db()
            .query("SELECT 1 FROM temporal_vec WHERE chunk_id = ?")
            .get(`${movedId}#0`)
        )
          break;
        await drainTemporalEmbeddingQueueOnce();
      }
      await expect(walk).resolves.toBeGreaterThan(0);
      expect(
        db()
          .query("SELECT 1 FROM temporal_vec WHERE chunk_id = ?")
          .get(`${movedId}#0`),
      ).not.toBeNull();
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("resumes historical admission while live arrivals keep the total queue full", async () => {
    const count = 513;
    for (let i = 0; i < count; i++)
      insertMsg(`saturated-${String(i).padStart(5, "0")}`, pid);

    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(
        () => {
          const pending = db()
            .query(
              "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE priority = 0",
            )
            .get() as { n: number };
          expect(pending.n).toBe(512);
        },
        { timeout: 5_000 },
      );
      expect(getKV("lore:temporal_rechunk.cursor")).toBe("saturated-00511");
      embed.mockImplementation(async (texts: string[]) =>
        texts.map(() => {
          const vector = new Float32Array(
            config().search.embeddings.dimensions,
          );
          vector[0] = 1;
          return vector;
        }),
      );
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(8);
      for (let i = 0; i < 8; i++) {
        const id = `new-live-${i}`;
        insertMsg(id, pid);
        enqueueTemporalEmbedding(
          id,
          `temporal message ${id} with more than enough content to embed`,
        );
      }
      const total = db()
        .query("SELECT COUNT(*) AS n FROM temporal_embedding_queue")
        .get() as { n: number };
      expect(total.n).toBe(512);
      const admissionPlan = db()
        .query(
          "EXPLAIN QUERY PLAN SELECT 1 FROM temporal_embedding_queue WHERE priority = 0 LIMIT 1 OFFSET 511",
        )
        .all() as Array<{ detail: string }>;
      expect(
        admissionPlan.some(({ detail }) =>
          detail.includes("idx_temporal_embedding_queue_priority"),
        ),
      ).toBe(true);
      await vi.waitFor(
        () => {
          expect(getKV("lore:temporal_rechunk.cursor")).toBe("saturated-00512");
        },
        { timeout: 2_000 },
      );
      await expect(walk).resolves.toBe(count);
      expect(getKV("lore:temporal_rechunk.done")).toBe("1");
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE priority = 1",
          )
          .get(),
      ).toEqual({ n: 8 });
    } finally {
      db().query("DELETE FROM temporal_embedding_queue").run();
      await walk;
    }
  });

  it("admits another project's healthy history past a full failed project", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-rejected-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    embed.mockImplementation(async (texts: string[]) => {
      if (texts.some((text) => text.includes("a-rejected-"))) {
        throw new Error("provider refuses this project's historical content");
      }
      return texts.map(() => {
        const result = new Float32Array(config().search.embeddings.dimensions);
        result[0] = 1;
        return result;
      });
    });
    for (let drain = 0; drain < 64; drain++) {
      await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
    }
    expect(
      db()
        .query(
          "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE priority = 0 AND failures > 0",
        )
        .get(),
    ).toEqual({ n: 512 });

    // The healthy owner lies beyond the bounded first page of projects.
    for (const index of Array.from({ length: 20 }, (_, i) => i)) {
      ensureProject(`/test/another-history-owner-${index}`);
    }
    const otherProject = (
      db()
        .query("SELECT id FROM projects WHERE id != ? ORDER BY id DESC LIMIT 1")
        .get(pid) as { id: string }
    ).id;
    insertMsg("z-healthy-other-project", otherProject);
    insertMsg("z-healthy-other-project-2", otherProject);
    const walk = backfillTemporalEmbeddings({
      shouldPause: () => {
        throw new Error("host idle predicate unavailable");
      },
    });
    const drainHealthy = async (messageId: string): Promise<void> => {
      // A due retry earns its own historical turn; it may fail before the
      // freshly admitted row gets a turn.
      for (const _attempt of [0, 1, 2, 3]) {
        if (
          db()
            .query(
              "SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?",
            )
            .get(messageId) === null
        )
          break;
        await drainTemporalEmbeddingQueueOnce().catch(() => 0);
      }
      expect(
        db()
          .query("SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?")
          .get(messageId),
      ).toBeNull();
    };
    try {
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-healthy-other-project'",
              )
              .get(),
          ).not.toBeNull();
        },
        { timeout: 8_000 },
      );
      await drainHealthy("z-healthy-other-project");
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_vec WHERE chunk_id = 'z-healthy-other-project#0'",
          )
          .get(),
      ).not.toBeNull();
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE failures > 0",
          )
          .get(),
      ).toEqual({ n: 512 });
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-healthy-other-project-2'",
              )
              .get(),
          ).not.toBeNull();
        },
        { timeout: 8_000 },
      );
      await drainHealthy("z-healthy-other-project-2");
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_vec WHERE chunk_id = 'z-healthy-other-project-2#0'",
          )
          .get(),
      ).not.toBeNull();
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE failures > 0",
          )
          .get(),
      ).toEqual({ n: 512 });
      expect(getKV("lore:temporal_rechunk.done")).not.toBe("1");

      // Once the failed owner leaves the corpus, the primary cursor catches up
      // without repeating the fair-ahead rows that were already embedded.
      db().query("DELETE FROM temporal_embedding_queue").run();
      db()
        .query("DELETE FROM temporal_messages WHERE id LIKE 'a-rejected-%'")
        .run();
      await expect(walk).resolves.toBe(2);
      expect(getKV("lore:temporal_rechunk.done")).toBe("1");
      expect(
        embed.mock.calls
          .flatMap(([texts]) => texts as string[])
          .filter((text) => text.includes("z-healthy-other-project")),
      ).toHaveLength(2);
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("admits the next owner's history when it sorts before the failed queue owner", async () => {
    for (const index of Array.from({ length: 512 }, (_, i) => i)) {
      const id = `a-deferred-${String(index).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    // The previous regression proves provider failures produce this durable
    // retry state; this case isolates the order in which the cursor sees owners.
    db()
      .query(
        "UPDATE temporal_embedding_queue SET failures = 1, retry_at = ? WHERE priority = 0",
      )
      .run(Date.now() + 60_000);
    embed.mockImplementation(async (texts: string[]) =>
      texts.map(() => {
        const result = new Float32Array(config().search.embeddings.dimensions);
        result[0] = 1;
        return result;
      }),
    );
    const otherProject = ensureProject("/test/earlier-healthy-owner");
    insertMsg("0-healthy-earlier-owner", otherProject);
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = '0-healthy-earlier-owner'",
              )
              .get(),
          ).not.toBeNull();
        },
        { timeout: 4_000 },
      );
      await expect(drainTemporalEmbeddingQueueOnce()).resolves.toBe(1);
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_vec WHERE chunk_id = '0-healthy-earlier-owner#0'",
          )
          .get(),
      ).not.toBeNull();
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE failures = 1",
          )
          .get(),
      ).toEqual({ n: 512 });
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("admits a healthy second row after the same owner's fair-ahead row fails", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-failed-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    db()
      .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
      .run(Date.now() + 60_000);
    const healthyOwner = ensureProject("/test/second-fair-owner");
    insertMsg("z-fair-failed", healthyOwner);
    insertMsg("z-fair-healthy", healthyOwner);
    embed.mockImplementation(async (texts: string[]) => {
      if (texts.some((text) => text.includes("z-fair-failed"))) {
        throw new Error("the first fair-ahead row is rejected");
      }
      return texts.map(
        () => new Float32Array(config().search.embeddings.dimensions),
      );
    });
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-fair-failed'",
              )
              .get(),
          ).not.toBeNull();
        },
        { timeout: 5_000 },
      );
      await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-fair-healthy'",
              )
              .get(),
          ).not.toBeNull();
        },
        { timeout: 10_000 },
      );
      // A now-due retry of the failed first row may receive a historical
      // turn before the second row; it must not block the healthy vector.
      for (const _turn of [0, 1, 2, 3]) {
        if (
          db()
            .query(
              "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-fair-healthy'",
            )
            .get() === null
        )
          break;
        await drainTemporalEmbeddingQueueOnce().catch(() => 0);
      }
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_vec WHERE chunk_id = 'z-fair-healthy#0'",
          )
          .get(),
      ).not.toBeNull();
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE message_id LIKE 'a-failed-%'",
          )
          .get(),
      ).toEqual({ n: 512 });
      const failedRow = (db()
        .query(
          "SELECT failures FROM temporal_embedding_parked WHERE message_id = 'z-fair-failed'",
        )
        .get() ??
        db()
          .query(
            "SELECT failures FROM temporal_embedding_queue WHERE message_id = 'z-fair-failed'",
          )
          .get()) as { failures: number } | null;
      expect(failedRow?.failures).toBeGreaterThan(0);
      const queuedFailures = (
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE failures > 0",
          )
          .get() as { n: number }
      ).n;
      expect(queuedFailures).toBeGreaterThanOrEqual(512);
      expect(queuedFailures).toBeLessThanOrEqual(513);
      expect(
        (
          db()
            .query(
              "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE priority = 0",
            )
            .get() as { n: number }
        ).n,
      ).toBeLessThanOrEqual(528);
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("never admits a 513th row for a full owner in a recovered mixed-owner queue", async () => {
    const otherOwner = ensureProject("/test/queued-first-owner");
    insertMsg("0-queued-other-owner", otherOwner);
    enqueueTemporalEmbedding(
      "0-queued-other-owner",
      "temporal message 0-queued-other-owner with more than enough content to embed",
      "backfill",
    );
    for (let i = 0; i < 513; i++) {
      const id = `a-cap-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      if (i < 512)
        enqueueTemporalEmbedding(
          id,
          `temporal message ${id} with more than enough content to embed`,
          "backfill",
        );
    }
    const nextOwner = ensureProject("/test/next-owner-beyond-full");
    insertMsg("z-next-owner", nextOwner);
    setKV("lore:temporal_rechunk.cursor", "a-cap-00511");
    const predecessor = db()
      .query("SELECT id FROM projects WHERE id < ? ORDER BY id DESC LIMIT 1")
      .get(pid) as { id: string } | null;
    setKV("lore:temporal_rechunk.skip", predecessor?.id ?? "");
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-next-owner'",
              )
              .get(),
          ).not.toBeNull();
        },
        { timeout: 5_000 },
      );
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue q JOIN temporal_messages t ON t.id = q.message_id WHERE t.project_id = ? AND q.priority = 0",
          )
          .get(pid),
      ).toEqual({ n: 512 });
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'a-cap-00512'",
          )
          .get(),
      ).toBeNull();
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("bounds fair-ahead admission across many projects and restart", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-bounded-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    db()
      .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
      .run(Date.now() + 60_000);
    for (let i = 0; i < 32; i++) {
      const owner = ensureProject(
        `/test/fair-budget-${String(i).padStart(2, "0")}`,
      );
      insertMsg(`z-budget-${String(i).padStart(2, "0")}`, owner);
    }
    // Make each probe eligible without a wall-clock wait; the backfill's
    // 250ms park still yields between probes.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1_001));
    const queuedCount = () =>
      (
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE priority = 0",
          )
          .get() as { n: number }
      ).n;
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(() => expect(queuedCount()).toBeGreaterThan(512), {
        timeout: 4_000,
      });
      // The main 512-row window plus a fixed 16 fair slots must never grow
      // linearly with the number of projects or with repeated probes.
      await vi
        .waitFor(() => expect(queuedCount()).toBeGreaterThan(528), {
          timeout: 7_000,
        })
        .catch(() => {});
      expect(queuedCount()).toBeLessThanOrEqual(528);

      setKV("lore:temporal_rechunk.epoch", "restart-fair-budget");
      await walk;
      const resumed = backfillTemporalEmbeddings();
      try {
        await vi
          .waitFor(() => expect(queuedCount()).toBeGreaterThan(528), {
            timeout: 2_000,
          })
          .catch(() => {});
        expect(queuedCount()).toBeLessThanOrEqual(528);
        embed.mockImplementation(async (texts: string[]) =>
          texts.map(
            () => new Float32Array(config().search.embeddings.dimensions),
          ),
        );
        await expect(
          drainTemporalEmbeddingQueueOnce(),
        ).resolves.toBeGreaterThan(0);
        await vi.waitFor(() => expect(queuedCount()).toBeGreaterThan(512), {
          timeout: 4_000,
        });
      } finally {
        resetTemporalRechunkProgress();
        await resumed;
      }
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("recycles failed fair claims so a healthy later tenant can recover", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-parked-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    db()
      .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
      .run(Date.now() + 60_000);
    const projects = Array.from({ length: 17 }, (_, index) => {
      const owner = withTenant("failing-tenant", () =>
        ensureProject(`/test/fair-exhaustion-${index}`),
      );
      return owner;
    }).sort();
    // Select the owner last in the fair rotation as the healthy tenant, so
    // all 16 earlier projects fill the active slots first.
    const healthy = projects[16];
    db()
      .query("UPDATE projects SET tenant_id = 'healthy-tenant' WHERE id = ?")
      .run(healthy);
    for (const [index, owner] of projects.entries()) {
      const id = index === 16 ? "z-healthy-later" : `z-failing-${index}`;
      insertMsg(id, owner);
    }
    setKV("lore:temporal_rechunk.cursor", "a-parked-00511");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1_001));
    embed.mockImplementation(async (texts: string[]) => {
      if (texts.some((text) => text.includes("z-failing-")))
        throw new Error("private failing provider diagnostic");
      expect(currentTenantId()).toBe("healthy-tenant");
      return texts.map(
        () => new Float32Array(config().search.embeddings.dimensions),
      );
    });
    let hostPaused = false;
    const walk = backfillTemporalEmbeddings({
      shouldPause: () => hostPaused,
    });
    try {
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE fair_ahead = 1",
              )
              .get(),
          ).toEqual({ n: 16 });
        },
        { timeout: 12_000 },
      );
      hostPaused = true;
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-healthy-later'",
          )
          .get(),
      ).toBeNull();
      for (let i = 0; i < 16; i++) {
        await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
      }
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE fair_ahead = 1",
          )
          .get(),
      ).toEqual({ n: 0 });
      hostPaused = false;
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-healthy-later'",
              )
              .get(),
          ).not.toBeNull();
        },
        { timeout: 6_000 },
      );
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE priority = 0",
          )
          .get(),
      ).toEqual({ n: 513 });
      expect(
        db().query("SELECT COUNT(*) AS n FROM temporal_embedding_parked").get(),
      ).toEqual({ n: 16 });
      expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_parked WHERE message_id LIKE 'z-failing-%' AND failures > 0",
          )
          .get(),
      ).toEqual({ n: 16 });
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE fair_ahead = 1",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_vec WHERE chunk_id = 'z-healthy-later#0'",
          )
          .get(),
      ).not.toBeNull();
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it.each([false, true])(
    "restarts a moved owner's parked fair retry without inherited debt (missing trigger: %s)",
    async (missingTrigger) => {
      for (let i = 0; i < 512; i++) {
        const id = `a-park-restart-${String(i).padStart(5, "0")}`;
        insertMsg(id, pid);
        enqueueTemporalEmbedding(
          id,
          `temporal message ${id} with more than enough content to embed`,
          "backfill",
        );
      }
      db()
        .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
        .run(Date.now() + 60_000);
      const fairOwner = ensureProject("/test/park-restart-fair-owner");
      insertMsg("z-park-restart", fairOwner);
      // Other cases retain empty project records. Begin immediately before this
      // owner so this test measures retry recovery rather than pagination time.
      const previous = db()
        .query("SELECT id FROM projects WHERE id < ? ORDER BY id DESC LIMIT 1")
        .get(fairOwner) as { id: string } | null;
      setKV("lore:temporal_rechunk.skip", previous?.id ?? "");
      embed.mockRejectedValue(new Error("failed source-backed fair work"));
      const gate = { hostPaused: false };
      const walk = backfillTemporalEmbeddings({
        shouldPause: () => gate.hostPaused,
      });
      try {
        await vi.waitFor(
          () => {
            expect(
              db()
                .query(
                  "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-park-restart'",
                )
                .get(),
            ).not.toBeNull();
          },
          { timeout: 10_000 },
        );
        gate.hostPaused = true;
        await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
        expect(
          db()
            .query(
              "SELECT failures FROM temporal_embedding_parked WHERE message_id = 'z-park-restart'",
            )
            .get(),
        ).toEqual({ failures: 1 });
        const movedProject = withTenant("tenant-park-restart", () =>
          ensureProject("/test/park-restart-moved-owner"),
        );
        if (missingTrigger) {
          db().exec("DROP TRIGGER temporal_embedding_parked_project_update");
        }
        db()
          .query(
            "UPDATE temporal_messages SET project_id = ? WHERE id = 'z-park-restart'",
          )
          .run(movedProject);
        if (!missingTrigger)
          expect(
            db()
              .query(
                "SELECT failures, retry_at FROM temporal_embedding_parked WHERE message_id = 'z-park-restart'",
              )
              .get(),
          ).toEqual({ failures: 0, retry_at: 0 });
        setKV("lore:temporal_rechunk.epoch", "restart-parked-fair-retry");
        await walk;
        if (missingTrigger) {
          close();
          expect(
            db()
              .query(
                "SELECT failures, retry_at FROM temporal_embedding_parked WHERE message_id = 'z-park-restart'",
              )
              .get(),
          ).toEqual({ failures: 0, retry_at: 0 });
        }

        const resumed = backfillTemporalEmbeddings();
        try {
          await vi.waitFor(
            () => {
              expect(
                db()
                  .query(
                    "SELECT project_id, failures, retry_at, fair_ahead FROM temporal_embedding_queue WHERE message_id = 'z-park-restart'",
                  )
                  .get(),
              ).toEqual({
                project_id: movedProject,
                failures: 0,
                retry_at: 0,
                fair_ahead: 1,
              });
            },
            { timeout: 10_000 },
          );
          expect(
            db()
              .query(
                "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE priority = 0",
              )
              .get(),
          ).toEqual({ n: 513 });
          embed.mockImplementation(async (texts: string[]) =>
            texts.map(() => {
              expect(currentTenantId()).toBe("tenant-park-restart");
              return new Float32Array(config().search.embeddings.dimensions);
            }),
          );
          expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_parked WHERE message_id = 'z-park-restart'",
              )
              .get(),
          ).toBeNull();
        } finally {
          resetTemporalRechunkProgress();
          await resumed;
        }
      } finally {
        resetTemporalRechunkProgress();
        await walk;
      }
    },
  );

  it("does not complete while a fair-ahead claim can still fail into the parked queue", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-late-fair-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    db()
      .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
      .run(Date.now() + 60_000);
    const owner = ensureProject("/test/late-fair-owner");
    const fairId = "z-late-fair";
    insertMsg(fairId, owner);
    setKV("lore:temporal_rechunk.cursor", "a-late-fair-00511");
    const previous = db()
      .query("SELECT id FROM projects WHERE id < ? ORDER BY id DESC LIMIT 1")
      .get(owner) as { id: string } | null;
    setKV("lore:temporal_rechunk.skip", previous?.id ?? "");
    const clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => (clock.now += 1_001));
    const walk = backfillTemporalEmbeddings();
    const scannedEnd = { probes: 0 };
    try {
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT fair_ahead FROM temporal_embedding_queue WHERE message_id = ?",
              )
              .get(fairId),
          ).toEqual({ fair_ahead: 1 });
        },
        { timeout: 10_000 },
      );
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
        withDbSpan<T>(sql: string, fn: () => T): T {
          if (sql.includes("SELECT 1 FROM temporal_embedding_parked LIMIT 1"))
            scannedEnd.probes++;
          return fn();
        },
      });
      // A normal source deletion cascades the full owner's queued work. The
      // already-admitted fair claim remains pending when the scan reaches EOF.
      db()
        .query("DELETE FROM temporal_messages WHERE id LIKE 'a-late-fair-%'")
        .run();
      await vi.waitFor(() => expect(scannedEnd.probes).toBeGreaterThan(0), {
        timeout: 10_000,
      });
      expect(getKV("lore:temporal_rechunk.done")).not.toBe("1");
      embed.mockRejectedValueOnce(new Error("failed late fair claim"));
      await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
      expect(
        db()
          .query(
            "SELECT failures FROM temporal_embedding_parked WHERE message_id = ?",
          )
          .get(fairId),
      ).toEqual({ failures: 1 });
      db()
        .query(
          "UPDATE temporal_embedding_parked SET retry_at = 0 WHERE message_id = ?",
        )
        .run(fairId);
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT fair_ahead FROM temporal_embedding_queue WHERE message_id = ?",
              )
              .get(fairId),
          ).toEqual({ fair_ahead: 1 });
        },
        { timeout: 10_000 },
      );
      embed.mockImplementation(async (texts: string[]) =>
        texts.map(
          () => new Float32Array(config().search.embeddings.dimensions),
        ),
      );
      expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
      await walk;
      expect(getKV("lore:temporal_rechunk.done")).toBe("1");
      expect(
        db()
          .query("SELECT 1 FROM temporal_embedding_parked WHERE message_id = ?")
          .get(fairId),
      ).toBeNull();
    } finally {
      resetTemporalRechunkProgress();
      await walk;
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
      });
    }
  });

  it("retires a parked fair retry if its source grows beyond the bounded embedding limit", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-parked-oversize-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    db()
      .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
      .run(Date.now() + 60_000);
    const owner = ensureProject("/test/parked-oversize-owner");
    const id = "z-parked-oversize";
    insertMsg(id, owner);
    setKV("lore:temporal_rechunk.cursor", "a-parked-oversize-00511");
    const previous = db()
      .query("SELECT id FROM projects WHERE id < ? ORDER BY id DESC LIMIT 1")
      .get(owner) as { id: string } | null;
    setKV("lore:temporal_rechunk.skip", previous?.id ?? "");
    const clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => (clock.now += 1_001));
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(
        () =>
          expect(
            db()
              .query(
                "SELECT fair_ahead FROM temporal_embedding_queue WHERE message_id = ?",
              )
              .get(id),
          ).toEqual({ fair_ahead: 1 }),
        { timeout: 10_000 },
      );
      embed.mockRejectedValueOnce(new Error("failed before source grew"));
      await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
      expect(
        db()
          .query(
            "SELECT failures FROM temporal_embedding_parked WHERE message_id = ?",
          )
          .get(id),
      ).toEqual({ failures: 1 });
      db()
        .query("UPDATE temporal_messages SET content = ? WHERE id = ?")
        .run(`${"x".repeat(2 * 1024 * 1024)} parkedoversizeftsmarker`, id);
      db()
        .query(
          "UPDATE temporal_embedding_parked SET retry_at = 0 WHERE message_id = ?",
        )
        .run(id);
      db()
        .query(
          "DELETE FROM temporal_messages WHERE id LIKE 'a-parked-oversize-%'",
        )
        .run();
      // Restart the walk with only the oversized parked source left. The
      // snapshot must still see its rowid so recovery can retire its park.
      resetTemporalRechunkProgress();
      await walk;
      const resumed = backfillTemporalEmbeddings();
      await vi.waitFor(
        () =>
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_parked WHERE message_id = ?",
              )
              .get(id),
          ).toBeNull(),
        { timeout: 10_000 },
      );
      await resumed;
      expect(getKV("lore:temporal_rechunk.done")).toBe("1");
      expect(
        db()
          .query("SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?")
          .get(id),
      ).toBeNull();
      expect(
        db()
          .query("SELECT rowid FROM temporal_fts WHERE temporal_fts MATCH ?")
          .get("parkedoversizeftsmarker"),
      ).not.toBeNull();
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("keeps a promoted fair-ahead job live after its provider call fails", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-fair-live-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    db()
      .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
      .run(Date.now() + 60_000);
    const owner = ensureProject("/test/fair-live-owner");
    const fairId = "z-fair-live";
    insertMsg(fairId, owner);
    setKV("lore:temporal_rechunk.cursor", "a-fair-live-00511");
    const previous = db()
      .query("SELECT id FROM projects WHERE id < ? ORDER BY id DESC LIMIT 1")
      .get(owner) as { id: string } | null;
    setKV("lore:temporal_rechunk.skip", previous?.id ?? "");
    const clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => (clock.now += 1_001));
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(
        () => {
          expect(
            db()
              .query(
                "SELECT fair_ahead FROM temporal_embedding_queue WHERE message_id = ?",
              )
              .get(fairId),
          ).toEqual({ fair_ahead: 1 });
        },
        { timeout: 10_000 },
      );
      enqueueTemporalEmbedding(
        fairId,
        `temporal message ${fairId} with more than enough content to embed`,
        "live",
      );
      embed.mockRejectedValueOnce(new Error("failed promoted live claim"));
      await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
      expect(
        db()
          .query(
            "SELECT priority, failures, fair_ahead FROM temporal_embedding_queue WHERE message_id = ?",
          )
          .get(fairId),
      ).toEqual({ priority: 1, failures: 1, fair_ahead: 0 });
      expect(
        db()
          .query("SELECT 1 FROM temporal_embedding_parked WHERE message_id = ?")
          .get(fairId),
      ).toBeNull();
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("promotes a parked fair retry when identical live content retains an old vector", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-parked-live-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    db()
      .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
      .run(Date.now() + 60_000);
    const path = "/test/parked-old-vector-live";
    const owner = ensureProject(path);
    const info = {
      id: "z-parked-old-vector-live",
      sessionID: "s",
      role: "user" as const,
      time: { created: Date.now() },
    };
    const parts = [
      {
        id: "part-parked-old-vector-live",
        messageID: info.id,
        sessionID: info.sessionID,
        type: "text" as const,
        text: "parked fair message with a valid old vector and enough content to embed",
        time: { start: Date.now(), end: Date.now() },
      },
    ];
    const id = storeTemporalMessage({ projectPath: path, info, parts });
    if (!id) throw new Error("temporal store did not save the source");
    db()
      .query("DELETE FROM temporal_embedding_queue WHERE message_id = ?")
      .run(id);
    const vector = new Float32Array(config().search.embeddings.dimensions);
    vector[0] = 1;
    storeTemporalChunks(db(), id, [vector]);
    setKV("lore:temporal_rechunk.cursor", "a-parked-live-00511");
    const previous = db()
      .query("SELECT id FROM projects WHERE id < ? ORDER BY id DESC LIMIT 1")
      .get(owner) as { id: string } | null;
    setKV("lore:temporal_rechunk.skip", previous?.id ?? "");
    const clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => (clock.now += 1_001));
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(
        () =>
          expect(
            db()
              .query(
                "SELECT fair_ahead FROM temporal_embedding_queue WHERE message_id = ?",
              )
              .get(id),
          ).toEqual({ fair_ahead: 1 }),
        { timeout: 10_000 },
      );
      embed.mockRejectedValueOnce(new Error("failed parked fair claim"));
      await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
      expect(
        db()
          .query(
            "SELECT failures FROM temporal_embedding_parked WHERE message_id = ?",
          )
          .get(id),
      ).toEqual({ failures: 1 });
      expect(
        db()
          .query("SELECT chunk_id FROM temporal_vec WHERE chunk_id = ?")
          .get(`${id}#0`),
      ).not.toBeNull();

      expect(storeTemporalMessage({ projectPath: path, info, parts })).toBe(id);
      expect(
        db()
          .query(
            "SELECT priority, failures, retry_at, fair_ahead FROM temporal_embedding_queue WHERE message_id = ?",
          )
          .get(id),
      ).toEqual({ priority: 1, failures: 0, retry_at: 0, fair_ahead: 0 });
      expect(
        db()
          .query("SELECT 1 FROM temporal_embedding_parked WHERE message_id = ?")
          .get(id),
      ).toBeNull();
      expect(
        db()
          .query("SELECT chunk_id FROM temporal_vec WHERE chunk_id = ?")
          .get(`${id}#0`),
      ).not.toBeNull();
    } finally {
      db()
        .query("DELETE FROM temporal_messages WHERE id LIKE 'a-parked-live-%'")
        .run();
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("never promotes a due parked retry into an owner's full 512-row queue", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-park-capacity-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    db()
      .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
      .run(Date.now() + 60_000);
    const owner = withTenant("park-capacity-tenant", () =>
      ensureProject("/test/park-capacity-owner"),
    );
    const fairId = "z-park-capacity-fair";
    insertMsg(fairId, owner);
    setKV("lore:temporal_rechunk.cursor", "a-park-capacity-00511");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1_001));
    const gate = { paused: false };
    const firstWalk = backfillTemporalEmbeddings({
      shouldPause: () => gate.paused,
    });
    try {
      await vi.waitFor(
        () =>
          expect(
            db()
              .query(
                "SELECT fair_ahead FROM temporal_embedding_queue WHERE message_id = ?",
              )
              .get(fairId),
          ).toEqual({ fair_ahead: 1 }),
        { timeout: 10_000 },
      );
      gate.paused = true;
      embed.mockRejectedValue(new Error("failed fair claim"));
      await expect(drainTemporalEmbeddingQueueOnce()).rejects.toThrow();
      expect(
        db()
          .query(
            "SELECT failures FROM temporal_embedding_parked WHERE message_id = ?",
          )
          .get(fairId),
      ).toEqual({ failures: 1 });
      // The normal walk can refill this owner's queue while its failed fair
      // claim remains parked outside the runnable window.
      withTenant("park-capacity-tenant", () => {
        for (let i = 0; i < 512; i++) {
          const id = `b-park-capacity-${String(i).padStart(5, "0")}`;
          insertMsg(id, owner);
          enqueueTemporalEmbedding(
            id,
            `temporal message ${id} with more than enough content to embed`,
            "backfill",
          );
        }
      });
      setKV("lore:temporal_rechunk.epoch", "park-capacity-restart");
      await firstWalk;
      db()
        .query(
          "UPDATE temporal_embedding_parked SET retry_at = 0 WHERE message_id = ?",
        )
        .run(fairId);
      setKV("lore:temporal_rechunk.park_next", "1");
      let dueProbes = 0;
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
        withDbSpan<T>(sql: string, fn: () => T): T {
          if (sql.includes("FROM temporal_embedding_parked d INDEXED BY"))
            dueProbes++;
          return fn();
        },
      });
      const resumed = backfillTemporalEmbeddings();
      try {
        await vi.waitFor(() => expect(dueProbes).toBeGreaterThan(0), {
          timeout: 10_000,
        });
        expect(
          db()
            .query(
              "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE priority = 0 AND project_id = ?",
            )
            .get(owner),
        ).toEqual({ n: 512 });
        expect(
          db()
            .query(
              "SELECT 1 FROM temporal_embedding_parked WHERE message_id = ?",
            )
            .get(fairId),
        ).not.toBeNull();
      } finally {
        resetTemporalRechunkProgress();
        await resumed;
        log.registerSink({
          info() {},
          warn() {},
          error() {},
          captureException() {},
        });
      }
    } finally {
      resetTemporalRechunkProgress();
      await firstWalk;
    }
  });

  it("bounds outstanding fair work after a larger legacy queue drains", async () => {
    for (let i = 0; i < 600; i++) {
      const id = `a-legacy-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    db()
      .query("UPDATE temporal_embedding_queue SET failures = 1, retry_at = ?")
      .run(Date.now() + 60_000);
    const fairOwner = ensureProject("/test/legacy-fair-slots");
    for (let i = 0; i < 32; i++)
      insertMsg(`z-legacy-fair-${String(i).padStart(5, "0")}`, fairOwner);
    setKV("lore:temporal_rechunk.cursor", "a-legacy-00599");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1_001));
    const fairCount = () =>
      (
        db()
          .query(
            "SELECT COUNT(*) AS n FROM temporal_embedding_queue WHERE message_id LIKE 'z-legacy-fair-%'",
          )
          .get() as { n: number }
      ).n;
    const countedQueueScans: string[] = [];
    log.registerSink({
      info() {},
      warn() {},
      error() {},
      captureException() {},
      withDbSpan<T>(sql: string, fn: () => T): T {
        if (
          /SELECT COUNT\(\*\).*FROM temporal_embedding_queue WHERE priority = 0/is.test(
            sql,
          )
        )
          countedQueueScans.push(sql);
        return fn();
      },
    });
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(() => expect(fairCount()).toBe(16), {
        // This file shares project rows across cases; fair rotation can visit
        // unrelated owners between claims under aggregate test load.
        timeout: 60_000,
      });
      db()
        .query("DELETE FROM temporal_embedding_queue WHERE message_id < ?")
        .run("a-legacy-00104");
      await vi
        .waitFor(() => expect(fairCount()).toBeGreaterThan(16), {
          timeout: 2_000,
        })
        .catch(() => {});
      expect(fairCount()).toBe(16);
      // Exact COUNT over a recovered 200k-row queue is linear even with an
      // index. Fair probes may inspect only a fixed number of outstanding rows.
      expect(countedQueueScans).toEqual([]);
    } finally {
      log.registerSink({
        info() {},
        warn() {},
        error() {},
        captureException() {},
      });
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("never admits another tenant's fair work under a tenant-bound walk", async () => {
    const tenant = "tenant-a";
    const owner = withTenant(tenant, () =>
      ensureProject("/test/tenant-a-fair-owner"),
    );
    const otherOwner = withTenant("tenant-b", () =>
      ensureProject("/test/another-tenant-fair-owner"),
    );
    for (let i = 0; i < 512; i++) {
      const id = `a-tenant-${String(i).padStart(5, "0")}`;
      withTenant(tenant, () => {
        insertMsg(id, owner);
        enqueueTemporalEmbedding(
          id,
          `temporal message ${id} with more than enough content to embed`,
          "backfill",
        );
      });
    }
    insertMsg("z-another-tenant", otherOwner);
    // Prior cases leave unrelated projects in this file's database. Place
    // the fair rotation directly before B so the tenant boundary, rather
    // than unrelated project-page order, determines this assertion.
    const predecessor = db()
      .query("SELECT id FROM projects WHERE id < ? ORDER BY id DESC LIMIT 1")
      .get(otherOwner) as { id: string } | null;
    const precedingOwner = predecessor?.id ?? "";
    setKV("lore:temporal_rechunk.skip", precedingOwner);
    const tenantAttempt = withTenant(tenant, () =>
      backfillTemporalEmbeddings(),
    );
    expect(await tenantAttempt).toBe(0);
    expect(getKV("lore:temporal_rechunk.skip")).toBe(precedingOwner);
    expect(
      db()
        .query(
          "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-another-tenant'",
        )
        .get(),
    ).toBeNull();
    const walk = withTenant("", () => backfillTemporalEmbeddings());
    try {
      await vi.waitFor(
        () =>
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-another-tenant'",
              )
              .get(),
          ).not.toBeNull(),
        { timeout: 5_000 },
      );
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("scans only a bounded ineligible project suffix per fair probe", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-scan-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    const otherOwner = ensureProject("/test/fair-negative-scan");
    for (let i = 0; i < 65; i++) {
      const id = `z-short-${String(i).padStart(5, "0")}`;
      insertMsg(id, otherOwner);
      db()
        .query("UPDATE temporal_messages SET content = 'short' WHERE id = ?")
        .run(id);
    }
    insertMsg("z-zzhealthy-after-short", otherOwner);
    const scanKey = `lore:temporal_rechunk.fair_scan:${otherOwner}`;
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(() => expect(getKV(scanKey)).toBe("z-short-00031"), {
        timeout: 12_000,
      });
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-zzhealthy-after-short'",
          )
          .get(),
      ).toBeNull();
      await vi.waitFor(() => expect(getKV(scanKey)).toBe("z-short-00063"), {
        timeout: 12_000,
      });
      await vi.waitFor(
        () =>
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-zzhealthy-after-short'",
              )
              .get(),
          ).not.toBeNull(),
        { timeout: 12_000 },
      );
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("bounds fair probes over post-snapshot rows before an eligible row", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-post-snapshot-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    const owner = ensureProject("/test/post-snapshot-fair-owner");
    insertMsg("z-zzhealthy-in-snapshot", owner);
    _setRecallEmbedsInFlightForTest(1);
    const walk = backfillTemporalEmbeddings();
    try {
      for (let i = 0; i < 64; i++) {
        const id = `z-later-${String(i).padStart(5, "0")}`;
        insertMsg(id, owner);
      }
      _setRecallEmbedsInFlightForTest(0);
      const scanKey = `lore:temporal_rechunk.fair_scan:${owner}`;
      const predecessor = db()
        .query("SELECT id FROM projects WHERE id < ? ORDER BY id DESC LIMIT 1")
        .get(owner) as { id: string } | null;
      const focusOwner = () =>
        setKV("lore:temporal_rechunk.skip", predecessor?.id ?? "");
      await vi.waitFor(() => expect(getKV(scanKey)).toBe("z-later-00031"), {
        timeout: 10_000,
      });
      expect(
        db()
          .query(
            "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-zzhealthy-in-snapshot'",
          )
          .get(),
      ).toBeNull();
      focusOwner();
      await vi.waitFor(() => expect(getKV(scanKey)).toBe("z-later-00063"), {
        timeout: 10_000,
      });
      focusOwner();
      await vi.waitFor(
        () =>
          expect(
            db()
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = 'z-zzhealthy-in-snapshot'",
              )
              .get(),
          ).not.toBeNull(),
        { timeout: 10_000 },
      );
    } finally {
      _setRecallEmbedsInFlightForTest(0);
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it("removes a deleted project's fair-ahead cursor immediately", async () => {
    for (let i = 0; i < 512; i++) {
      const id = `a-delete-${String(i).padStart(5, "0")}`;
      insertMsg(id, pid);
      enqueueTemporalEmbedding(
        id,
        `temporal message ${id} with more than enough content to embed`,
        "backfill",
      );
    }
    const deletedOwner = ensureProject("/test/deleted-fair-owner");
    insertMsg("z-deleted-fair-row", deletedOwner);
    const fairKey = `lore:temporal_rechunk.fair:${deletedOwner}`;
    // Other cases in this file create projects too. Start the indexed fair
    // rotation immediately before this owner so the assertion tests deletion,
    // not how many unrelated project pages precede it.
    const predecessor = db()
      .query("SELECT id FROM projects WHERE id < ? ORDER BY id DESC LIMIT 1")
      .get(deletedOwner) as { id: string } | null;
    setKV("lore:temporal_rechunk.skip", predecessor?.id ?? "");
    const walk = backfillTemporalEmbeddings();
    try {
      await vi.waitFor(
        () => expect(getKV(fairKey)).toBe("z-deleted-fair-row"),
        { timeout: 4_000 },
      );
      setKV("lore:temporal_rechunk.skip", deletedOwner);
      expect(data.deleteProject(deletedOwner)).not.toBeNull();
      expect(getKV(fairKey)).toBeNull();
      expect(getKV("lore:temporal_rechunk.skip")).toBe("");
      expect(
        db().query("SELECT COUNT(*) AS n FROM temporal_embedding_queue").get(),
      ).toEqual({ n: 512 });
    } finally {
      resetTemporalRechunkProgress();
      await walk;
    }
  });

  it.each(["absent", "throws"])(
    "yields to timers with a %s pause gate",
    async (gate) => {
      for (let i = 0; i < 128; i++)
        insertMsg(`timer-${String(i).padStart(5, "0")}`, pid);
      const timer = new Promise<{ cursor: string | null; done: string | null }>(
        (resolve) => {
          setTimeout(
            () =>
              resolve({
                cursor: getKV("lore:temporal_rechunk.cursor"),
                done: getKV("lore:temporal_rechunk.done"),
              }),
            0,
          );
        },
      );
      await backfillTemporalEmbeddings(
        gate === "absent"
          ? {}
          : {
              shouldPause: () => {
                throw new Error("host predicate failed");
              },
            },
      );
      const observed = await timer;
      expect(observed.cursor).toMatch(/^timer-/);
      expect(observed.cursor).not.toBe("timer-00127");
      expect(observed.done).not.toBe("1");
      expect(getKV("lore:temporal_rechunk.done")).toBe("1");
    },
  );

  it.each([0, 5])(
    "bounds admission bursts with %sms of per-row work",
    async (rowMs) => {
      for (let i = 0; i < 128; i++)
        insertMsg(`burst-${String(i).padStart(5, "0")}`, pid);
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const tick = new Promise<string | null>((resolve) => {
        setImmediate(() => resolve(getKV("lore:temporal_rechunk.cursor")));
      });
      await backfillTemporalEmbeddings({
        shouldPause: () => {
          elapsed += rowMs;
          return false;
        },
      });
      const cursor = await tick;
      expect(cursor).toMatch(/^burst-/);
      // Cheap rows must still yield; expensive rows must yield before 32 rows.
      const scannedAtTick = Number(cursor!.slice("burst-".length)) + 1;
      if (rowMs === 0) expect(scannedAtTick).toBeLessThanOrEqual(32);
      else expect(scannedAtTick).toBeLessThan(32);
      expect(getKV("lore:temporal_rechunk.done")).toBe("1");
    },
  );

  it("does not invoke providers or inference-duty sleeps", async () => {
    process.env.LORE_BACKFILL_CPU_DUTY = "0.5";
    insertMsg("t1", pid);
    insertMsg("t2", pid);

    const processed = await backfillTemporalEmbeddings();

    expect(processed).toBe(2);
    expect(embed).not.toHaveBeenCalled();
  });

  it("does not throttle at full duty (1.0)", async () => {
    process.env.LORE_BACKFILL_CPU_DUTY = "1";
    insertMsg("t1", pid);
    insertMsg("t2", pid);

    const processed = await backfillTemporalEmbeddings();

    expect(processed).toBe(2);
    expect(embed).not.toHaveBeenCalled();
  });

  it("documents the retained CPU-duty setting as legacy everywhere", () => {
    const rows = [
      readFileSync(
        "packages/website/src/content/docs/docs/configuration.md",
        "utf8",
      )
        .split("\n")
        .find((line) => line.includes("`backfillCpuDuty`")),
      readFileSync(
        "packages/website/src/content/docs/docs/environment.md",
        "utf8",
      )
        .split("\n")
        .find((line) => line.includes("`LORE_BACKFILL_CPU_DUTY`")),
    ];

    expect(rows).not.toContain(undefined);
    rows.forEach((row) => {
      expect(row).toContain("Legacy temporal backfill duty setting");
      expect(row).not.toMatch(/sleep|throttl|auto-scal|CPU count/i);
    });
  });
});
