import { describe, test, expect, beforeAll } from "vitest";
import { db, ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import * as data from "../src/data";

// The /ui/costs page runs three cross-project bulk aggregates (#561):
// aggregateTokensBySessionAll, aggregateDistillationsBySessionAll and
// listAllRecentSessions. The expensive one is the "earliest assistant message
// per session" lookup inside aggregateTokensBySessionAll: a subquery that
// filters role='assistant' AND created_at>=? and groups by session_id. With
// only single-column indexes SQLite full-SCANs idx_temporal_session for it
// (~360ms at ~200K messages).
//
// v56 adds a SINGLE index for exactly that access pattern:
//   idx_temporal_role_session_created ON temporal_messages(role, session_id, created_at)
// → a covering equality seek on role='assistant' that streams the GROUP BY in
// (session_id, created_at) order. Measured ~8x faster on that query.
//
// We deliberately do NOT add a (created_at, session_id) index for the token-sum,
// distillation or recent-session aggregates: EXPLAIN QUERY PLAN (measured at both
// low and high created_at selectivity) shows the planner always prefers the
// session-ordered idx_temporal_session / idx_distillation_session scan there, so
// such an index would be pure write amplification with no read benefit. The
// "deliberately unindexed" tests below pin that decision so it isn't quietly
// reverted by a future contributor adding write-amplification-only indexes.
//
// The SQL strings asserted in the plan tests are kept byte-identical to the
// production queries (temporal.ts: aggregateTokensBySessionAll,
// data.ts: aggregateDistillationsBySessionAll). The correctness tests drive the
// real exported functions so the path under test cannot silently drift.

const PROJECT = "/test/cost-bulk-queries/project";

// --- verbatim copies of the production SQL (keep in sync) ---------------------
// temporal.ts aggregateTokensBySessionAll, step 1 (token sums per session)
const SQL_TOKEN_SUMS = `SELECT session_id, SUM(tokens) as total_tokens
   FROM temporal_messages
   WHERE created_at >= ?
   GROUP BY session_id`;
// temporal.ts aggregateTokensBySessionAll, step 2 inner subquery (earliest
// assistant message per session) — the hot path this migration targets.
const SQL_META_SUBQUERY = `SELECT session_id, MIN(created_at) AS min_at
   FROM temporal_messages
   WHERE role = 'assistant' AND created_at >= ?
   GROUP BY session_id`;
// temporal.ts aggregateTokensBySessionAll, step 2 full query.
const SQL_META_FULL = `SELECT t.session_id, t.metadata
   FROM temporal_messages t
   JOIN (
     SELECT session_id, MIN(created_at) AS min_at
     FROM temporal_messages
     WHERE role = 'assistant' AND created_at >= ?
     GROUP BY session_id
   ) m ON m.session_id = t.session_id AND t.created_at = m.min_at
   WHERE t.role = 'assistant'
   GROUP BY t.session_id`;
// data.ts aggregateDistillationsBySessionAll (full projection: call_type +
// token_count are NOT covered by any (created_at, session_id) index — this is
// why such an index is not worth adding).
const SQL_DISTILL = `SELECT
     session_id,
     COUNT(*) as total_calls,
     SUM(CASE WHEN call_type = 'batch' THEN 1 ELSE 0 END) as batch_calls,
     SUM(token_count) as total_tokens,
     SUM(CASE WHEN call_type = 'batch' THEN token_count ELSE 0 END) as batch_tokens
   FROM distillations
   WHERE created_at >= ?
   GROUP BY session_id`;

function explainPlan(sql: string, ...params: unknown[]): string {
  const rows = db()
    .query(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(" | ");
}

function listIndexNames(table: string): Set<string> {
  const rows = db()
    .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`)
    .all(table) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

const SINCE_MS = () => Date.now() - 90 * 86_400_000;

describe("cost-page bulk query indexes (migration v56)", () => {
  beforeAll(() => {
    const pid = ensureProject(PROJECT);
    const insertMsg = db().query(
      `INSERT INTO temporal_messages
         (id, project_id, session_id, role, content, tokens, distilled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    const insertDistill = db().query(
      `INSERT INTO distillations
         (id, project_id, session_id, narrative, facts, observations, source_ids,
          generation, token_count, call_type, created_at, archived)
       VALUES (?, ?, ?, '', '', ?, '[]', 0, ?, ?, ?, 0)`,
    );
    const dayMs = 86_400_000;
    const now = Date.now();
    db().exec("BEGIN");
    try {
      // 50 sessions, 200 messages each, spread across 60 days. Enough rows for
      // the optimizer to make realistic index choices once ANALYZE has run.
      for (let s = 0; s < 50; s++) {
        const sid = `cqb-sess-${s}`;
        for (let m = 0; m < 200; m++) {
          const role = m % 2 === 0 ? "user" : "assistant";
          insertMsg.run(
            `${sid}-m${m}`,
            pid,
            sid,
            role,
            `m-${m}`,
            100,
            now - ((s + m) % 60) * dayMs,
          );
        }
        for (let d = 0; d < 5; d++) {
          insertDistill.run(
            `${sid}-d${d}`,
            pid,
            sid,
            `obs-${d}`,
            1000,
            d % 2 === 0 ? "batch" : "direct",
            now - ((s + d) % 60) * dayMs,
          );
        }
      }
      db().exec("COMMIT");
    } catch (e) {
      db().exec("ROLLBACK");
      throw e;
    }
    db().exec("ANALYZE");
  });

  describe("index existence", () => {
    test("v56 added idx_temporal_role_session_created", () => {
      expect(
        listIndexNames("temporal_messages").has(
          "idx_temporal_role_session_created",
        ),
      ).toBe(true);
    });

    test("no (created_at, session_id) write-amplification index was added", () => {
      // Guards the deliberate decision documented in migration v56: these
      // indexes were measured to be unused by every costs-page query, so they
      // must NOT exist. If a future migration adds one, prove its value first.
      expect(
        listIndexNames("temporal_messages").has("idx_temporal_created_session"),
      ).toBe(false);
      expect(
        listIndexNames("distillations").has("idx_distillation_created_session"),
      ).toBe(false);
    });
  });

  describe("query plan selection", () => {
    test("metadata subquery uses idx_temporal_role_session_created as a covering seek", () => {
      // The hot subquery: role='assistant' equality seek covering the GROUP BY
      // and MIN(created_at). Must use the new index, NOT a full role scan of
      // idx_temporal_session. Dropping the index flips both assertions red.
      const plan = explainPlan(SQL_META_SUBQUERY, SINCE_MS());
      expect(plan).toContain("idx_temporal_role_session_created");
      expect(plan).not.toMatch(
        /SCAN temporal_messages USING INDEX idx_temporal_session/,
      );
    });

    test("full metadata query (aggregateTokensBySessionAll step 2) uses the new index", () => {
      const plan = explainPlan(SQL_META_FULL, SINCE_MS());
      expect(plan).toContain("idx_temporal_role_session_created");
      // The inner subquery in particular must not fall back to a full scan.
      expect(plan).not.toMatch(
        /SCAN temporal_messages USING INDEX idx_temporal_session/,
      );
    });

    test("token-sum and distillation aggregates run index-backed (no full heap scan)", () => {
      // These intentionally have no (created_at, session_id) index — the planner
      // uses the session-ordered index to stream the GROUP BY. This pins that
      // they remain index-backed rather than regressing to a brute table scan.
      const tokenPlan = explainPlan(SQL_TOKEN_SUMS, SINCE_MS());
      expect(tokenPlan).toContain("USING INDEX");
      expect(tokenPlan).not.toMatch(/SCAN temporal_messages(?! USING)/);

      const distillPlan = explainPlan(SQL_DISTILL, SINCE_MS());
      expect(distillPlan).toContain("USING INDEX");
      expect(distillPlan).not.toMatch(/SCAN distillations(?! USING)/);
    });
  });

  describe("query correctness (real exported functions)", () => {
    test("aggregateTokensBySessionAll groups token sums by session", () => {
      const result = temporal.aggregateTokensBySessionAll({
        sinceMs: SINCE_MS(),
      });
      // 200 messages × 100 tokens = 20_000 tokens per session.
      const sess0 = result.get("cqb-sess-0");
      expect(sess0).toBeDefined();
      expect(sess0?.total_tokens).toBe(200 * 100);
    });

    test("aggregateTokensBySessionAll surfaces first assistant metadata field", () => {
      const result = temporal.aggregateTokensBySessionAll({
        sinceMs: SINCE_MS(),
      });
      // Assistant messages carry no metadata in this fixture; the per-session
      // row still exists and the field is present (null).
      const sess0 = result.get("cqb-sess-0");
      expect(sess0).toBeDefined();
      expect(sess0?.first_assistant_metadata).toBeNull();
    });

    test("aggregateDistillationsBySessionAll groups calls and tokens by session", () => {
      const result = data.aggregateDistillationsBySessionAll({
        sinceMs: SINCE_MS(),
      });
      const sess0 = result.get("cqb-sess-0");
      expect(sess0).toBeDefined();
      expect(sess0?.total_calls).toBe(5);
      expect(sess0?.total_tokens).toBe(5 * 1000);
      // Distillations d0/d2/d4 are batch-type (d % 2 === 0).
      expect(sess0?.batch_calls).toBe(3);
      expect(sess0?.batch_tokens).toBe(3 * 1000);
    });
  });
});
