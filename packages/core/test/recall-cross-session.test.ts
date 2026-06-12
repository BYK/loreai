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
  db().exec("DELETE FROM distillations");
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

function seedDistillation(
  sessionID: string,
  observations: string,
  createdAt: number,
): string {
  const pid = ensureProject(PROJECT);
  const id = uuidv7();
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      pid,
      sessionID,
      "",
      "[]",
      observations,
      "[]",
      0,
      Math.ceil(observations.length / 3),
      0,
      createdAt,
    );
  return id;
}

describe("recall — cross-session raw history demotion", () => {
  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
  });

  // Uses scope="project" deliberately: the pre-existing session-affinity boost
  // only runs under scope="all", so "project" isolates the cross-session
  // penalty as the *only* thing differentiating same- vs other-session rows.
  // This test fails if CROSS_SESSION_RAW_PENALTY is set to 1.0 (disabled).
  test("penalizes a cross-session temporal row below an equal current-session row", async () => {
    // Identical distinctive content in two sessions, the OTHER one newer so
    // recency does not favor the current session. Only the penalty can make
    // the current-session row win.
    const now = Date.now();
    const currentId = seedTemporal(
      CURRENT_SESSION,
      "xyzzy plugh frobnicate widget investigation",
      now - 10_000,
    );
    const otherId = seedTemporal(
      OTHER_SESSION,
      "xyzzy plugh frobnicate widget investigation",
      now,
    );

    const results = await searchRecall({
      query: "xyzzy plugh frobnicate widget",
      projectPath: PROJECT,
      sessionID: CURRENT_SESSION,
      scope: "project",
    });

    const temporal = results.filter((r) => r.item.source === "temporal");
    expect(temporal.length).toBe(2);

    const currentRank = temporal.findIndex(
      (r) => r.item.source === "temporal" && r.item.item.id === currentId,
    );
    const otherRank = temporal.findIndex(
      (r) => r.item.source === "temporal" && r.item.item.id === otherId,
    );
    // The current-session row must rank first purely due to the penalty.
    // (The other row is NEWER, so without the penalty recency would rank it
    // first — this assertion fails if CROSS_SESSION_RAW_PENALTY is 1.0.)
    expect(currentRank).toBe(0);
    expect(otherRank).toBe(1);

    // The other-session row is demoted: its score is meaningfully lower than
    // the current row's, consistent with the 0.5 multiplier (allow slack for
    // small RRF rank differences across recency-biased lists).
    const currentScore = temporal[currentRank].score;
    const otherScore = temporal[otherRank].score;
    expect(otherScore).toBeLessThan(currentScore * 0.6);
  });

  // Same isolation for the distillation source (the riskier session_id access).
  test("penalizes a cross-session distillation below an equal current-session one", async () => {
    const now = Date.now();
    const currentId = seedDistillation(
      CURRENT_SESSION,
      "blorptron quffle zindar marker observation",
      now - 10_000,
    );
    const otherId = seedDistillation(
      OTHER_SESSION,
      "blorptron quffle zindar marker observation",
      now,
    );

    const results = await searchRecall({
      query: "blorptron quffle zindar marker",
      projectPath: PROJECT,
      sessionID: CURRENT_SESSION,
      scope: "project",
    });

    const dist = results.filter((r) => r.item.source === "distillation");
    expect(dist.length).toBe(2);

    const currentRank = dist.findIndex(
      (r) => r.item.source === "distillation" && r.item.item.id === currentId,
    );
    const otherRank = dist.findIndex(
      (r) => r.item.source === "distillation" && r.item.item.id === otherId,
    );
    expect(currentRank).toBe(0);
    expect(otherRank).toBe(1);
    expect(dist[otherRank].score).toBeLessThan(dist[currentRank].score * 0.6);
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

  // A cross-session row is demoted but NOT removed — it still surfaces when it
  // is the only match. Guards against the penalty being mistaken for a filter.
  test("a demoted cross-session row still surfaces when it is the only match", async () => {
    const otherId = seedTemporal(
      OTHER_SESSION,
      "snarfblat wibble cromulent token",
      Date.now(),
    );

    const results = await searchRecall({
      query: "snarfblat wibble cromulent",
      projectPath: PROJECT,
      sessionID: CURRENT_SESSION,
      scope: "all",
    });

    const temporal = results.filter((r) => r.item.source === "temporal");
    expect(
      temporal.some(
        (r) => r.item.source === "temporal" && r.item.item.id === otherId,
      ),
    ).toBe(true);
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

  test("default absoluteFloor (0) is a no-op — even a cross-session match is kept", async () => {
    // Seed ONLY a cross-session row: it is penalized (score halved) but must
    // still appear under the default config, proving absoluteFloor=0 does not
    // filter anything.
    seedTemporal(
      OTHER_SESSION,
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
