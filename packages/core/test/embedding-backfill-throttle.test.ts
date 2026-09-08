import { readFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, ensureProject, getKV, databaseInTransaction } from "../src/db";
import { ensureVec0Store, setStorageMode } from "../src/db/vec-store";
import { enqueueTemporalEmbedding } from "../src/temporal-embedding-admission";
import {
  backfillTemporalEmbeddings,
  resetTemporalRechunkProgress,
  _restoreProvider,
  _saveAndClearProvider,
} from "../src/embedding";

// The temporal re-chunk walk only admits durable work. CPU-intensive provider
// throttling belongs to the bounded scheduler, never this metadata walk.

const PROJECT = "/test/backfill-throttle";
const DIM = 4;

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
    ensureVec0Store(db(), DIM);
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
    vi.restoreAllMocks();
    _restoreProvider(providerToken);
    delete process.env.LORE_BACKFILL_CPU_DUTY;
  });

  it.each([false, true])(
    "serves HTTP during admission (already queued: %s)",
    async (alreadyQueued) => {
      const count = 1_024;
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
        expect(observed?.cursor).not.toBe("http-01023");
        expect(observed?.done).not.toBe("1");
        expect(getKV("lore:temporal_rechunk.done")).toBe("1");
        expect(embed).not.toHaveBeenCalled();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

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
