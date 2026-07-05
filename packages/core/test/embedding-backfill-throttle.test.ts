import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, ensureProject } from "../src/db";
import { ensureVec0Store, setStorageMode } from "../src/db/vec-store";
import {
  backfillTemporalEmbeddings,
  resetTemporalRechunkProgress,
  _restoreProvider,
  _saveAndClearProvider,
  _setBackfillSleepForTest,
} from "../src/embedding";

// The temporal re-chunk backfill sleeps a fraction of each embed's duration so a
// one-time background migration doesn't peg a core on a weak host. These tests
// drive the loop through an injectable sleep seam so the wiring is asserted
// without wall-clock flakiness.

const PROJECT = "/test/backfill-throttle";
const DIM = 4;

function vec(): Float32Array {
  const a = new Float32Array(DIM);
  a[0] = 1;
  return a;
}

/** Real timer (the seam replaces only the throttle sleep, not this). */
function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const sleeps: number[] = [];

  beforeEach(() => {
    pid = ensureProject(PROJECT);
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    db().query("DELETE FROM temporal_vec").run();
    db().query("DELETE FROM temporal_messages").run();
    resetTemporalRechunkProgress();
    sleeps.length = 0;
    _setBackfillSleepForTest((ms) => {
      sleeps.push(ms);
      return Promise.resolve(); // record + skip the real timer
    });
    providerToken = _saveAndClearProvider();
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        async embed(texts: string[]) {
          // A measurable embed duration so the duty-cycle sleep is non-zero.
          await realDelay(15);
          return texts.map(() => vec());
        },
      },
    });
  });

  afterEach(() => {
    _restoreProvider(providerToken);
    _setBackfillSleepForTest(null);
    delete process.env.LORE_BACKFILL_CPU_DUTY;
  });

  it("throttles between rows when the duty cycle is below 1", async () => {
    process.env.LORE_BACKFILL_CPU_DUTY = "0.5";
    insertMsg("t1", pid);
    insertMsg("t2", pid);

    const processed = await backfillTemporalEmbeddings();

    expect(processed).toBe(2);
    // One throttle sleep per embedded row, each strictly positive (elapsed·1).
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("does not throttle at full duty (1.0)", async () => {
    process.env.LORE_BACKFILL_CPU_DUTY = "1";
    insertMsg("t1", pid);
    insertMsg("t2", pid);

    const processed = await backfillTemporalEmbeddings();

    expect(processed).toBe(2);
    expect(sleeps).toHaveLength(0);
  });
});
