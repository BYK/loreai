import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import { ensureVec0Store, setStorageMode } from "../src/db/vec-store";
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
    _restoreProvider(providerToken);
    delete process.env.LORE_BACKFILL_CPU_DUTY;
  });

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
