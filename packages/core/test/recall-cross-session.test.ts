import { uuidv7 } from "uuidv7";
import { beforeEach, describe, expect, test } from "vitest";
import { LoreConfig } from "../src/config";
import { db, ensureProject } from "../src/db";
import { runRecall, searchRecall } from "../src/recall";

const PROJECT = "/test/recall-cross-session/project";
const CURRENT_SESSION = "current-session";
const OTHER_SESSION = "other-session";

function cleanup() {
  db().exec("DELETE FROM temporal_messages");
}

function seedTemporal(
  sessionID: string,
  content: string,
  createdAt: number,
): string {
  const pid = ensureProject(PROJECT);
  const id = uuidv7();
  db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
    )
    .run(id, pid, sessionID, "user", content, 20, createdAt);
  return id;
}

describe("recall — cross-session raw history demotion", () => {
  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
  });

  test("same-session raw history outranks an equally-matching other-session row", async () => {
    // Identical distinctive content in two different sessions. Without the
    // cross-session penalty their fused scores would tie (or the older/other
    // one could win on recency); with the penalty the current session wins.
    const now = Date.now();
    const otherId = seedTemporal(
      OTHER_SESSION,
      "xyzzy plugh frobnicate widget investigation",
      now - 10_000,
    );
    const currentId = seedTemporal(
      CURRENT_SESSION,
      "xyzzy plugh frobnicate widget investigation",
      now,
    );

    const results = await searchRecall({
      query: "xyzzy plugh frobnicate widget",
      projectPath: PROJECT,
      sessionID: CURRENT_SESSION,
      scope: "all",
    });

    const temporal = results.filter((r) => r.item.source === "temporal");
    expect(temporal.length).toBeGreaterThanOrEqual(2);

    const currentRank = temporal.findIndex(
      (r) => r.item.source === "temporal" && r.item.item.id === currentId,
    );
    const otherRank = temporal.findIndex(
      (r) => r.item.source === "temporal" && r.item.item.id === otherId,
    );
    expect(currentRank).toBeGreaterThanOrEqual(0);
    expect(otherRank).toBeGreaterThanOrEqual(0);
    // Current-session result must come first.
    expect(currentRank).toBeLessThan(otherRank);

    // The other-session row's fused score must be strictly lower (penalized).
    const currentScore = temporal[currentRank].score;
    const otherScore = temporal[otherRank].score;
    expect(otherScore).toBeLessThan(currentScore);
  });

  test("cross-session penalty is NOT applied under session scope", async () => {
    // Under scope="session" only the current session is searched, so the other
    // session's row should not appear at all and no penalty math runs.
    const now = Date.now();
    seedTemporal(OTHER_SESSION, "quux garply zorch token", now - 5_000);
    const currentId = seedTemporal(
      CURRENT_SESSION,
      "quux garply zorch token",
      now,
    );

    const results = await searchRecall({
      query: "quux garply zorch token",
      projectPath: PROJECT,
      sessionID: CURRENT_SESSION,
      scope: "session",
    });

    const temporal = results.filter((r) => r.item.source === "temporal");
    expect(temporal.length).toBe(1);
    expect(
      temporal[0].item.source === "temporal" && temporal[0].item.item.id,
    ).toBe(currentId);
  });
});

describe("recall — absolute relevance floor", () => {
  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
  });

  test("a high absoluteFloor drops weak matches even via the keep-3 backfill", async () => {
    seedTemporal(
      OTHER_SESSION,
      "thaumaturgy obscure tangential remark",
      Date.now(),
    );

    const search = LoreConfig.parse({}).search;
    // An impossibly high absolute floor: every real RRF score is < 1, so all
    // results must be dropped — including the keep-3 backfill, which now also
    // respects the absolute floor.
    search.recall.absoluteFloor = 1_000_000;

    const md = await runRecall({
      query: "thaumaturgy obscure tangential",
      projectPath: PROJECT,
      sessionID: CURRENT_SESSION,
      scope: "all",
      searchConfig: search,
    });

    expect(md).toContain("No results found");
  });

  test("default absoluteFloor (0) keeps matching results", async () => {
    seedTemporal(
      CURRENT_SESSION,
      "thaumaturgy obscure tangential remark",
      Date.now(),
    );

    const md = await runRecall({
      query: "thaumaturgy obscure tangential",
      projectPath: PROJECT,
      sessionID: CURRENT_SESSION,
      scope: "all",
    });

    expect(md).toContain("Recall Results");
    expect(md).not.toContain("No results found");
  });
});
