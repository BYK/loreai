/**
 * Registry contract battery for SYNCED_TABLES.
 *
 * The two #828 sync bugs (prune-floor wedge, cross-account tier residue) shared
 * a root cause that example-based tests miss: adding a row to the SYNCED_TABLES
 * fan-out has ripple effects (capture triggers, seedOutbox, reconcile, push
 * skip, prune floor) that no single feature test enforces as a contract. This
 * battery loops EVERY registered table and asserts the cross-cutting invariants
 * each flag (`pullOnly`, `versioned`) implies — so a future table (a team scope,
 * a Pro table in #826/D) automatically inherits the checks and cannot silently
 * violate them on a path nobody re-examined.
 *
 * Core-level invariants live here (triggers + seedOutbox/reconcile). The
 * engine-level pull-only invariants (pushOnce skips it; it never wedges the
 * prune floor) are asserted in packages/gateway/test/sync.test.ts against the
 * real push path.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { db, deleteTeamConfig } from "../src/db";
import {
  enableSync,
  readOutbox,
  SYNCED_TABLES,
  seedOutbox,
} from "../src/sync-data";

const now = () => Date.now();

/**
 * Live-row factories used by the BEHAVIORAL pull-only checks. EVERY pull-only
 * table MUST register one here — the completeness test below fails otherwise, so
 * a new pull-only table can't quietly skip the prune-floor-wedge guard.
 */
const SAMPLE_ROW: Record<string, () => void> = {
  profiles: () =>
    db()
      .query(
        "INSERT INTO profiles (id, tier, created_at, updated_at) VALUES ('rc-sample', 'pro', ?, ?)",
      )
      .run(now(), now()),
};

function tempTriggers(): string[] {
  return (
    db()
      .query("SELECT name FROM sqlite_temp_master WHERE type='trigger'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function outboxFor(table: string) {
  return readOutbox(0).filter((e) => e.table_name === table);
}

beforeEach(() => {
  deleteTeamConfig("sync.enabled");
  db().exec("DELETE FROM temp._sync_applying");
  db().exec("DELETE FROM sync_outbox");
  db().exec("DELETE FROM sync_state");
  for (const m of SYNCED_TABLES.basic) {
    db().exec(`DELETE FROM ${m.table}`);
  }
});

describe("SYNCED_TABLES registry contract", () => {
  for (const m of SYNCED_TABLES.basic) {
    describe(`${m.table}${m.pullOnly ? " (pull-only)" : ""}`, () => {
      test("idColumns are non-empty and a subset of syncColumns", () => {
        // rowIdOf()/getRowById() read the id columns out of a syncColumns-only
        // projection, so the PK must be carried in syncColumns.
        expect(m.idColumns.length).toBeGreaterThan(0);
        for (const c of m.idColumns) expect(m.syncColumns).toContain(c);
      });

      test("has a change-capture trigger IFF it is not pull-only", () => {
        // Pull-only tables are server-authoritative; capturing local writes
        // would enqueue an entry that can never be pushed.
        const captured = tempTriggers().some((n) =>
          n.startsWith(`${m.table}_outbox_`),
        );
        expect(captured).toBe(!m.pullOnly);
      });

      if (m.pullOnly) {
        test("registers a SAMPLE_ROW (contract completeness)", () => {
          expect(SAMPLE_ROW[m.table]).toBeDefined();
        });

        test("seedOutbox NEVER enqueues it, even with a live row", () => {
          SAMPLE_ROW[m.table]?.();
          seedOutbox();
          expect(outboxFor(m.table)).toHaveLength(0);
        });

        test("reconcile/enableSync NEVER enqueues it, even with a live row", () => {
          // The disable→enable path the capture-trigger exclusion does NOT cover:
          // a populated mirror at enable time must not be seeded (else its
          // never-advancing push cursor pins the prune floor at 0 for ALL tables).
          SAMPLE_ROW[m.table]?.();
          enableSync();
          expect(outboxFor(m.table)).toHaveLength(0);
        });
      }
    });
  }
});
