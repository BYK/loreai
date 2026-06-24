import { describe, test, expect, beforeAll } from "vitest";
import { db, ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import * as data from "../src/data";

// The /ui/costs page runs three cross-project bulk aggregates (#561):
// aggregateTokensBySessionAll, aggregateDistillationsBySessionAll and
// listAllRecentSessions. Two migrations make them index-only scans:
//
// v57 — idx_temporal_role_session_created ON temporal_messages(role, session_id,
//   created_at). Targets the "earliest assistant message per session" subquery
//   inside aggregateTokensBySessionAll (role='assistant' AND created_at>=?
//   GROUP BY session_id). A covering equality seek on role='assistant' that
//   streams the GROUP BY; measured ~8x faster (~360ms -> ~42ms at ~200K rows).
//
// v58 — COVERING indexes for the other two aggregates, which still did a per-row
//   heap lookup for the aggregated/projected column:
//     idx_temporal_session_created_tokens ON (session_id, created_at, tokens)
//       — token-sum: SUM(tokens) ... WHERE created_at>=? GROUP BY session_id.
//     idx_temporal_project_session_created ON (project_id, session_id, created_at)
//       — listAllRecentSessions: COUNT/MIN/MAX(created_at) GROUP BY proj,session.
//   EXPLAIN flips from "SCAN ... USING INDEX" to "... USING COVERING INDEX"
//   (index-only, no heap reads); measured ~2-3.5x faster on token-sum and the
//   win grows as the table outgrows the page cache. These wider indexes have the
//   old narrow idx_temporal_session / idx_temporal_project_session as exact
//   left-prefixes, so v58 DROPs the narrow ones (net index count unchanged) — the
//   same prefix-cleanup pattern used in migration v6.
//
// We still deliberately do NOT add a (created_at, session_id) index (created_at-
// leading): the planner prefers the session-ordered covering scans, so it would
// be pure write amplification. The "deliberately unindexed" test below pins that.
//
// The SQL strings asserted in the plan tests are kept textually in sync with
// the production queries (temporal.ts: aggregateTokensBySessionAll, data.ts:
// listAllRecentSessions + aggregateDistillationsBySessionAll). Whitespace may
// differ — EXPLAIN QUERY PLAN ignores it — but the shape/table/clauses match.
// Each of the three aggregates also has a correctness test that drives its real
// exported function, so a production-query change that alters results (not just
// the plan) cannot silently drift past these tests.

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
// data.ts listAllRecentSessions — the recent-session aggregate. v58 covers its
// COUNT/MIN/MAX(created_at) GROUP BY (project_id, session_id) with an index-only
// scan via idx_temporal_project_session_created.
const SQL_RECENT = `SELECT
     t.project_id,
     p.path AS project_path,
     p.name AS project_name,
     t.session_id,
     COUNT(*) AS message_count,
     MIN(t.created_at) AS first_message_at,
     MAX(t.created_at) AS last_message_at
   FROM temporal_messages t
   JOIN projects p ON p.id = t.project_id
   WHERE t.created_at >= ?
   GROUP BY t.project_id, t.session_id
   ORDER BY MAX(t.created_at) DESC
   LIMIT ?`;
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

describe("cost-page bulk query indexes (migrations v57 + v58)", () => {
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
    test("v57 added idx_temporal_role_session_created", () => {
      expect(
        listIndexNames("temporal_messages").has(
          "idx_temporal_role_session_created",
        ),
      ).toBe(true);
    });

    test("v58 added the two covering indexes and dropped their narrow prefixes", () => {
      const names = listIndexNames("temporal_messages");
      // The wider covering indexes exist...
      expect(names.has("idx_temporal_session_created_tokens")).toBe(true);
      expect(names.has("idx_temporal_project_session_created")).toBe(true);
      // ...and the narrow indexes they subsume (exact left-prefixes) are gone.
      // If a future change re-adds them it is pure write amplification — the
      // covering indexes already serve every access pattern (see below).
      expect(names.has("idx_temporal_session")).toBe(false);
      expect(names.has("idx_temporal_project_session")).toBe(false);
    });

    test("no (created_at, session_id) write-amplification index was added", () => {
      // Guards a deliberate decision: a created_at-LEADING index was measured to
      // be unused by every costs-page query (the planner prefers the session-
      // ordered covering scans), so it must NOT exist. Distinct from the v58
      // session-leading covering indexes, which ARE used. Prove value first.
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

    test("token-sum aggregate runs as an index-only COVERING scan (v58)", () => {
      // SUM(tokens) ... GROUP BY session_id must stream off the v58 covering
      // index with NO per-row heap lookup. Dropping the index (or removing
      // `tokens` from it) flips this from COVERING back to a heap SCAN.
      const tokenPlan = explainPlan(SQL_TOKEN_SUMS, SINCE_MS());
      expect(tokenPlan).toContain("idx_temporal_session_created_tokens");
      expect(tokenPlan).toMatch(/USING COVERING INDEX/);
      expect(tokenPlan).not.toMatch(/SCAN temporal_messages(?! USING)/);
    });

    test("recent-session aggregate runs as an index-only COVERING scan (v58)", () => {
      // COUNT/MIN/MAX(created_at) GROUP BY (project_id, session_id) must search
      // the temporal_messages side (`t`) via the v58 covering index — never a
      // brute heap scan. The small projects side (`p`) may still be SCANned.
      const recentPlan = explainPlan(SQL_RECENT, SINCE_MS(), 50_000);
      expect(recentPlan).toContain("idx_temporal_project_session_created");
      expect(recentPlan).toMatch(/USING COVERING INDEX/);
      // Reject only a *heap* scan of `t` (no index). A full index-only walk is
      // reported as "SCAN t USING COVERING INDEX ..." on some SQLite builds and
      // is a legitimate plan — mirror the robust token-sum assertion (line ~226)
      // instead of a bare toContain("SCAN t") that would false-fail on it. The
      // `\b` stops "SCAN t" from matching inside "SCAN temporal_messages" should
      // a build ever report the full table name instead of the alias; the
      // alternation still rejects a full-name heap scan in that case.
      expect(recentPlan).not.toMatch(
        /SCAN (?:t|temporal_messages)\b(?! USING)/,
      );
    });

    test("distillation aggregate stays index-backed (no full heap scan)", () => {
      // distillations is small and its projection (call_type, token_count) is
      // intentionally NOT covered — the planner streams the GROUP BY off the
      // session-ordered index. Pin that it stays index-backed, not a brute scan.
      const distillPlan = explainPlan(SQL_DISTILL, SINCE_MS());
      expect(distillPlan).toContain("USING INDEX");
      expect(distillPlan).not.toMatch(/SCAN distillations(?! USING)/);
    });

    test("session-scoped lookups stay index-backed after the narrow indexes are dropped", () => {
      // Subsumption guard: idx_temporal_session served `WHERE session_id = ?`
      // [ORDER BY created_at]. The v58 (session_id, created_at, tokens) index has
      // session_id as its leftmost column, so it must serve these too — and the
      // ORDER BY created_at is satisfied by index order (no temp b-tree sort).
      const orderPlan = explainPlan(
        `SELECT id FROM temporal_messages WHERE session_id = ? ORDER BY created_at`,
        "cqb-sess-5",
      );
      expect(orderPlan).toContain("idx_temporal_session_created_tokens");
      expect(orderPlan).not.toMatch(/SCAN temporal_messages(?! USING)/);
      expect(orderPlan).not.toContain("USE TEMP B-TREE");

      // `WHERE session_id = ? AND distilled = 0` must also remain index-backed.
      const distilledPlan = explainPlan(
        `SELECT id FROM temporal_messages WHERE session_id = ? AND distilled = 0`,
        "cqb-sess-5",
      );
      expect(distilledPlan).not.toMatch(/SCAN temporal_messages(?! USING)/);
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

    test("listAllRecentSessions reports per-session counts and time bounds", () => {
      const rows = data.listAllRecentSessions({ sinceMs: SINCE_MS() });
      const sess0 = rows.find((r) => r.session_id === "cqb-sess-0");
      expect(sess0).toBeDefined();
      if (!sess0) return;
      // 200 messages inserted for this session, all within the 90-day window.
      expect(sess0.message_count).toBe(200);
      expect(sess0.project_path).toBe(PROJECT);
      // created_at = now - ((s + m) % 60) * day; m = 0..199 covers residues
      // 0..59, so first..last spans exactly 59 days for every session.
      expect(sess0.last_message_at - sess0.first_message_at).toBe(
        59 * 86_400_000,
      );
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
