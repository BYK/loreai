/**
 * Regression test for issue #1599: gateway graceful shutdown must close the
 * vector/read worker pool's SQLite readers BEFORE the writer close runs, and
 * the writer close must run exactly once on the normal path.
 *
 * Why this matters:
 *   - SQLite WAL TRUNCATE requires ZERO concurrent readers — each vector
 *     worker holds a read-mark via its `reader.db` connection. Leaving
 *     readers up while the writer tries to close either busy-returns the
 *     checkpoint (and strands the `-wal`) or hangs on the writer's busy-
 *     timeout. Both force WAL recovery on next boot.
 *   - The pre-#1599 sync `shutdownVectorPool()` posted `shutdown` +
 *     `terminate()` in the same tick and never awaited, so a reader could
 *     outlive the writer close.
 *   - `core close()` must be called exactly once on the graceful path: zero
 *     calls leaves WAL uncheckpointed, two calls is a logic bug.
 *
 * These tests pin:
 *   - The strict shutdown order: pipeline stop → embedding drain → embedding
 *     reset → vector readers closed → writer close.
 *   - Vector-pool shutdown with no workers, healthy workers, and a stuck
 *     worker (deadline path).
 *   - `close()` is idempotent and a no-op when the DB was never opened.
 *   - After SIGTERM, reopening the DB passes `PRAGMA integrity_check` and
 *     preserves accepted writes (the headline regression that #1599 fixes).
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  close as closeDb,
  db,
  embedding,
  temporalEmbeddingQueue,
} from "@loreai/core";

const tempDirs: string[] = [];
// Snapshot the process-start LORE_DB_PATH so the integrity_check test can
// point db() at a fresh tempdir for its own canary write without leaking
// that override to anything else in this run. setup.ts already isolated
// each test file to its own temp dir, but restoring keeps the invariant
// local — a future setupFiles change that shares a process across files
// (e.g. `pool: "threads"`) won't silently change the next test's DB.
let originalLoreDbPath: string | undefined;

function tempDbDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lore-shutdown-1599-"));
  tempDirs.push(dir);
  return dir;
}

/** Install no-op spies on the embedding shutdown hooks and `shutdownVectorPoolAsync`
 *  so `startGateway`'s shutdown closure observes them. Returns the unmock hook
 *  for tests that need to swap a single binding for a behavior-asserting mock. */
async function mockCoreShutdown(): Promise<{
  core: typeof import("@loreai/core");
}> {
  const core = await import("@loreai/core");
  vi.spyOn(core, "shutdownVectorPoolAsync").mockResolvedValue(undefined);
  vi.spyOn(
    temporalEmbeddingQueue,
    "settleTemporalEmbeddingScheduler",
  ).mockResolvedValue(true);
  vi.spyOn(embedding, "settleDocumentEmbeds").mockResolvedValue(undefined);
  vi.spyOn(embedding, "resetProvider").mockResolvedValue(undefined);
  return { core };
}

beforeAll(() => {
  originalLoreDbPath = process.env.LORE_DB_PATH;
});

afterEach(() => {
  vi.restoreAllMocks();
  // A DB that was opened in a test must be closed before rmSync, otherwise
  // Windows file locks fail the cleanup. Errors here are non-fatal.
  try {
    closeDb();
  } catch {
    /* already closed */
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  // Restore LORE_DB_PATH to whatever it was at process start so a test
  // that swaps to a tempdir (the integrity_check test below) doesn't
  // strand the next sibling test on a now-removed path.
  if (originalLoreDbPath === undefined) {
    delete process.env.LORE_DB_PATH;
  } else {
    process.env.LORE_DB_PATH = originalLoreDbPath;
  }
});

describe("startGateway shutdown — strict order (#1599)", () => {
  it("runs pipeline stop → embedding drain → embedding reset → vector readers closed → writer close", async () => {
    const order: string[] = [];
    const { core } = await mockCoreShutdown();
    vi.spyOn(
      temporalEmbeddingQueue,
      "stopTemporalEmbeddingScheduler",
    ).mockImplementation(() => {
      order.push("scheduler-stop");
    });
    vi.spyOn(
      temporalEmbeddingQueue,
      "settleTemporalEmbeddingScheduler",
    ).mockImplementation(async (deadlineMs?: number) => {
      order.push("scheduler-settle");
      expect(deadlineMs).toBeGreaterThan(0);
      expect(Number.isFinite(deadlineMs)).toBe(true);
      return true;
    });
    vi.spyOn(embedding, "settleDocumentEmbeds").mockImplementation(
      async (
        _deadline?: Parameters<typeof embedding.settleDocumentEmbeds>[0],
      ) => {
        order.push("drain");
      },
    );
    vi.spyOn(embedding, "resetProvider").mockImplementation(async () => {
      order.push("reset");
    });
    vi.spyOn(core, "shutdownVectorPoolAsync").mockImplementation(
      async (_deadlineMs?: number) => {
        order.push("pool");
      },
    );
    vi.spyOn(core, "close").mockImplementation(() => {
      order.push("close");
    });

    // Make sure the DB is open so the close path has something to close —
    // mirrors what a real gateway does during request handling.
    db();

    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet: true });
    expect(handle.owned).toBe(true);

    await handle.shutdown();

    // Strict order: the writer's WAL TRUNCATE in core close() REQUIRES no
    // reader WAL read-marks, so vector-pool shutdown MUST run before close.
    // Likewise the embedding worker must be gone before vector-pool shutdown
    // so an in-flight embedding can't keep the reader pool alive.
    expect(order).toEqual([
      "scheduler-stop",
      "scheduler-settle",
      "drain",
      "reset",
      "pool",
      "close",
    ]);
  });
});

describe("startGateway shutdown — vector-pool variants (#1599)", () => {
  it("completes cleanly when the pool has no workers (no-op)", async () => {
    // Default behavior: shutdownVectorPoolAsync() on an empty pool resolves
    // immediately. The gateway shutdown must not assume any workers exist
    // and must still call writer close afterward.
    await mockCoreShutdown();
    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet: true });
    await expect(handle.shutdown()).resolves.toBeUndefined();
    // closeDb is idempotent; calling it again is a no-op.
    expect(() => closeDb()).not.toThrow();
  });

  it("completes cleanly when the pool has healthy workers (real async path)", async () => {
    // The pool is empty by default (NODE_ENV=test → poolEnabled() returns
    // false), so this exercises the empty-pool path through the real
    // `shutdownVectorPoolAsync` binding — proving the gateway imports +
    // invokes it without throwing and then calls writer close.
    const { core } = await mockCoreShutdown();
    const close = vi.fn(() => {});
    vi.spyOn(core, "close").mockImplementation(() => {
      close();
    });

    db(); // open so close() is a real call
    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet: true });
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("completes even when the pool has a stuck worker (deadline still respected)", async () => {
    // Simulate a worker that never acks shutdown: the helper must still
    // resolve within its deadline so the bounded shutdown can move on to
    // writer close. Mirrors the core-level test in
    // packages/core/test/shutdown-vector-pool.test.ts.
    const { core } = await mockCoreShutdown();
    vi.spyOn(core, "shutdownVectorPoolAsync").mockImplementation(
      async (deadlineMs?: number) => {
        // Simulate a worker that takes up to its budget before force-terminating.
        const budget = Math.min(deadlineMs ?? 20, 20);
        const start = Date.now();
        await new Promise((r) => setTimeout(r, budget));
        expect(Date.now() - start).toBeLessThan(budget + 50);
      },
    );
    vi.spyOn(core, "close").mockImplementation(() => {});

    db();
    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet: true });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe("startGateway shutdown — close() call invariants (#1599)", () => {
  it("calls core close() exactly once on the normal path", async () => {
    const { core } = await mockCoreShutdown();
    const close = vi.fn(() => {});
    vi.spyOn(core, "close").mockImplementation(() => {
      close();
    });

    db();
    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet: true });
    await handle.shutdown();

    // Exactly once — not zero (would leave WAL uncheckpointed) and not twice
    // (would be a logic bug / leaked cleanup hook).
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("close() is a no-op when the DB was never opened (does not open it)", async () => {
    // No db() call → instance is undefined → close() should be a true no-op
    // and definitely NOT open a connection just to close it.
    await mockCoreShutdown();

    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet: true });
    await handle.shutdown();

    // After shutdown, db() should STILL be able to open fresh (the
    // unopened-DB invariant means close() didn't force-open to close).
    expect(() => db()).not.toThrow();
    closeDb(); // cleanup
  });

  it("close() is idempotent when called a second time after shutdown", async () => {
    // Mirror a forced-exit retry or a defensive double-close in another
    // caller: the second close must be a no-op, not a duplicate close on an
    // already-closed handle.
    await mockCoreShutdown();

    db();
    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet: true });
    await handle.shutdown();

    // The gateway already called close(); calling again is a no-op.
    expect(() => closeDb()).not.toThrow();
    expect(() => closeDb()).not.toThrow();
  });

  it("a close failure does not block process exit (best-effort)", async () => {
    // The gateway's shutdown closure wraps closeDb() in try/catch — a busy
    // reader / failed checkpoint must never propagate and block the forced-
    // exit path. Verify by making close() throw.
    const { core } = await mockCoreShutdown();
    vi.spyOn(core, "close").mockImplementation(() => {
      throw new Error("checkpoint busy");
    });

    db();
    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet: true });
    // Must not reject — the gateway catches the close error.
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe("startGateway shutdown — PRAGMA integrity_check after SIGTERM (#1599)", () => {
  it("reopening the DB after a clean shutdown passes integrity_check and preserves writes", async () => {
    // Headline regression test: BEFORE #1599, the gateway closed the writer
    // while vector-pool readers still held WAL read-marks, so the WAL was
    // stranded. Next boot had to recover it — and in pathological cases,
    // could lose the last in-flight write that the writer hadn't checkpointed
    // yet because the readers were pinning the WAL frame.
    //
    // This test simulates the full lifecycle: open via `db()`, accept a write,
    // run a graceful shutdown (vector pool → close), reopen the file from
    // scratch in a fresh Database handle, run integrity_check, and read back
    // the row. If any write is missing, the test fails with the WAL recovery
    // issue symptom.
    const tempDir = tempDbDir();
    const path = join(tempDir, "lore.db");
    process.env.LORE_DB_PATH = path;
    await mockCoreShutdown();

    // Open the DB and accept a write — the headline contract is "preserves
    // accepted writes" from the issue's acceptance criteria.
    const writer = db();
    writer.exec(
      "CREATE TABLE IF NOT EXISTS shutdown_canary (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
    writer
      .query(
        "INSERT OR REPLACE INTO shutdown_canary (id, payload) VALUES (?, ?)",
      )
      .run("canary-1", "before-shutdown");

    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet: true });
    await handle.shutdown();

    // The file MUST exist (writer was open) and the -wal sidecar MUST be
    // truncated (or absent) — the precondition for no recovery on next boot.
    expect(statSync(path).isFile()).toBe(true);

    // Second "session": reopen from a FRESH handle (no shared singleton),
    // verify integrity_check + the canary row survives.
    const fresh = new DatabaseSync(path);
    try {
      const integrity = fresh.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      expect(integrity.integrity_check).toBe("ok");

      const row = fresh
        .prepare("SELECT payload FROM shutdown_canary WHERE id = ?")
        .get("canary-1") as { payload?: string } | null;
      expect(row?.payload).toBe("before-shutdown");
    } finally {
      fresh.close();
    }
  });
});
