import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, ensureProject, getKV, setKV } from "../src/db";
import { ensureVec0Store, setStorageMode } from "../src/db/vec-store";
import {
  backfillTemporalEmbeddings,
  resetTemporalRechunkProgress,
  _restoreProvider,
  _saveAndClearProvider,
} from "../src/embedding";
import * as log from "../src/log";

// Regression suite for the temporal re-chunk backfill livelock: a single row
// whose embed reliably OOM-SIGKILLs the whole gateway (native ONNX OOM is
// uncatchable, so the ×0.7 backoff never fires) would be retried on every
// restart forever, because the per-row cursor checkpoint only advances AFTER a
// successful embed. An in-flight marker + bounded per-row crash counter lets the
// walk detect such a row across restarts and skip past it (keeping its legacy
// vector + FTS) so it makes progress.

const PROJECT = "/test/poison-row";
const DIM = 4;

const CURSOR = "lore:temporal_rechunk.cursor";
const INFLIGHT = "lore:temporal_rechunk.inflight";
const ROW_ATTEMPTS = "lore:temporal_rechunk.row_attempts";
const SKIP = "lore:temporal_rechunk.skip";

function vec(): Float32Array {
  const a = new Float32Array(DIM);
  a[0] = 1;
  return a;
}

function insertMsg(id: string, pid: string): void {
  // >= 50 chars so the walk's `length(content) >= 50` filter embeds it.
  const content = `temporal message ${id} with more than enough content to embed`;
  expect(content.length).toBeGreaterThanOrEqual(50);
  db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, 's', 'user', ?, 0, 0, 0)",
    )
    .run(id, pid, content);
}

function embeddedIds(): string[] {
  return (
    db()
      .query("SELECT DISTINCT message_id FROM temporal_vec ORDER BY message_id")
      .all() as { message_id: string }[]
  ).map((r) => r.message_id);
}

describe("temporal re-chunk poison-row liveness", () => {
  let pid: string;
  let providerToken: unknown;

  beforeEach(() => {
    pid = ensureProject(PROJECT);
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    db().query("DELETE FROM temporal_vec").run();
    db().query("DELETE FROM temporal_messages").run();
    resetTemporalRechunkProgress(); // done=0, cursor="", inflight="", attempts reset
    providerToken = _saveAndClearProvider();
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          return texts.map(() => vec());
        },
      },
    });
  });

  afterEach(() => {
    _restoreProvider(providerToken);
    vi.restoreAllMocks();
  });

  it("skips a row that has repeatedly crashed the process, and keeps walking", async () => {
    insertMsg("t1", pid);
    insertMsg("t2", pid);
    insertMsg("t3", pid);
    // Simulate a prior uncatchable crash mid-embed on t2: the in-flight marker
    // survived, the cursor still sits at t2's predecessor, and t2 has already
    // taken the process down once — so this run's detection reaches the cap.
    setKV(CURSOR, "t1");
    setKV(INFLIGHT, "t2");
    setKV(ROW_ATTEMPTS, "1");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    const processed = await backfillTemporalEmbeddings();

    const ids = embeddedIds();
    expect(ids).not.toContain("t2"); // poison row skipped
    expect(ids).toContain("t3"); // walk continued past it
    expect(processed).toBe(1); // only t3 re-chunked
    expect(getKV(INFLIGHT)).toBe(""); // marker cleared
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("t2"));
  });

  it("gives a row still below the crash threshold another chance instead of skipping", async () => {
    insertMsg("t1", pid);
    insertMsg("t2", pid);
    insertMsg("t3", pid);
    // In-flight marker present but the row has only crashed zero times so far:
    // detection lifts it to 1 (< 2), so t2 must be retried, not skipped.
    setKV(CURSOR, "t1");
    setKV(INFLIGHT, "t2");
    setKV(ROW_ATTEMPTS, "0");

    const processed = await backfillTemporalEmbeddings();

    const ids = embeddedIds();
    expect(ids).toContain("t2"); // retried and succeeded
    expect(ids).toContain("t3");
    expect(processed).toBe(2);
    expect(getKV(ROW_ATTEMPTS)).toBe("0"); // reset once t2 completed cleanly
    expect(getKV(INFLIGHT)).toBe("");
  });

  it("marks the row in-flight during its embed and clears it once the row settles", async () => {
    insertMsg("t1", pid);
    const seenDuringEmbed: string[] = [];
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          // The marker must be live exactly while this row is being embedded —
          // that's the whole crash-detection signal.
          seenDuringEmbed.push(getKV(INFLIGHT) ?? "");
          return texts.map(() => vec());
        },
      },
    });

    const processed = await backfillTemporalEmbeddings();

    expect(processed).toBe(1);
    expect(seenDuringEmbed).toContain("t1"); // set before the embed ran
    expect(getKV(INFLIGHT)).toBe(""); // cleared after it settled
  });

  it("skips only the poison row, still embedding earlier rows the cursor is pinned behind", async () => {
    // The persisted cursor can sit earlier than the poison row (e.g. pinned at a
    // transient failure's predecessor). Skipping must step over ONLY the poison
    // row, not everything between the pin and it — otherwise a transient hiccup
    // plus a later crash would silently abandon the rows in between.
    insertMsg("t1", pid);
    insertMsg("t2", pid);
    insertMsg("t3", pid);
    setKV(CURSOR, "t1"); // resume point is behind t2
    setKV(INFLIGHT, "t3"); // ...but the poison row is t3, two rows ahead
    setKV(ROW_ATTEMPTS, "1");

    const processed = await backfillTemporalEmbeddings();

    const ids = embeddedIds();
    expect(ids).toContain("t2"); // the in-between row is still embedded
    expect(ids).not.toContain("t3"); // only the poison row is skipped
    expect(processed).toBe(1);
  });

  it("treats a stale marker at/behind the cursor as resolved, without counting a crash", async () => {
    // Only t1 exists and the cursor is already past it, so the walk fetches
    // nothing and no later clean row can reset the counter for us — the final
    // counter value is exactly what the entry-detection decided.
    insertMsg("t1", pid);
    setKV(CURSOR, "t5"); // resume point already past the marker
    setKV(INFLIGHT, "t2"); // stale marker BEHIND the cursor
    setKV(ROW_ATTEMPTS, "0");

    const processed = await backfillTemporalEmbeddings();

    // A stale-behind marker is not a live crash: the counter must stay 0, not be
    // bumped to 1. (Dropping the `crashedRow > cursor` guard counts it as a
    // crash and this becomes "1".)
    expect(processed).toBe(0);
    expect(getKV(ROW_ATTEMPTS)).toBe("0");
    expect(getKV(INFLIGHT)).toBe("");
  });

  it("never rewinds the cursor when a stale in-flight marker points at or behind it", async () => {
    insertMsg("t1", pid);
    insertMsg("t2", pid);
    // A stale marker at t1 while the cursor has already advanced to t2 must not
    // move the cursor backwards (the `crashedRow > cursor` guard).
    setKV(CURSOR, "t2");
    setKV(INFLIGHT, "t1");
    setKV(ROW_ATTEMPTS, "1");

    const processed = await backfillTemporalEmbeddings();

    // Cursor stays at/after t2 → t1 is NOT revisited; nothing past t2 remains.
    const ids = embeddedIds();
    expect(ids).not.toContain("t1");
    expect(processed).toBe(0);
    expect(getKV(INFLIGHT)).toBe("");
  });

  it("re-arms a durable skip on restart even with no in-flight crash this run", async () => {
    // The skip decision from a prior crash is persisted (SKIP), so it survives a
    // restart where the in-flight marker is empty and the cursor is pinned behind
    // the poison row — the row must still be stepped over, not re-embedded.
    insertMsg("t1", pid);
    insertMsg("t2", pid);
    insertMsg("t3", pid);
    setKV(SKIP, "t2"); // recorded on a prior crash
    setKV(CURSOR, "t1"); // pinned behind the poison row
    setKV(INFLIGHT, ""); // no crash this run

    const processed = await backfillTemporalEmbeddings();

    const ids = embeddedIds();
    expect(ids).not.toContain("t2"); // durable skip honored
    expect(ids).toContain("t3");
    expect(processed).toBe(1);
  });

  it("keeps the durable skip when a transient failure pins the cursor behind the poison row", async () => {
    // The exact crash-loop scenario: a transient failure on an earlier row pins
    // the persisted cursor behind the poison row. The poison skip must be
    // recorded DURABLY so the next restart steps over the row instead of
    // re-embedding (and re-crashing on) it.
    insertMsg("t0", pid);
    insertMsg("t1", pid); // transient-fails → pins retryFrom at t0
    insertMsg("t2", pid); // poison row, crash-armed this run
    insertMsg("t3", pid);
    setKV(CURSOR, ""); // walk from the start
    setKV(INFLIGHT, "t2"); // crashed mid-embed on t2 last time
    setKV(ROW_ATTEMPTS, "1"); // this run's detection reaches the skip threshold
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          if (texts.some((t) => t.includes("message t1 "))) {
            throw new Error("transient embed failure");
          }
          return texts.map(() => vec());
        },
      },
    });

    const processed = await backfillTemporalEmbeddings();

    const ids = embeddedIds();
    expect(ids).not.toContain("t2"); // poison row skipped
    expect(ids).not.toContain("t1"); // transient row failed this pass
    expect(ids).toContain("t0");
    expect(ids).toContain("t3");
    expect(processed).toBe(2); // t0 + t3
    // The cursor is pinned behind t2 by the transient retryFrom...
    expect(getKV(CURSOR)).toBe("t0");
    // ...so the skip MUST persist durably, or the next restart re-crashes on t2.
    expect(getKV(SKIP)).toBe("t2");
  });
});
