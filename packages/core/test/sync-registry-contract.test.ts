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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { db, deleteTeamConfig } from "../src/db";
import {
  assertSyncInvariants,
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

afterEach(() => assertSyncInvariants()); // #834 — continuous invariant guard

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

describe("SYNCED_TABLES local-only secondary UNIQUE → convergence handling (#1217)", () => {
  // A UNIQUE the FK-less remote doesn't enforce (keyed differently from the remote's
  // upsert conflict target) means a pulled row can collide with a local row → without
  // deterministic resolution it silently regresses to divergent-on-skip (#1215/#1217).
  // This maps each such table to how it converges. A NEW table with such a UNIQUE fails
  // here until it gets a resolver + routing in handlePulledRowConstraint (or is otherwise
  // documented as handled) — the same fan-out hazard this battery exists to catch.
  const HANDLED: Record<string, string> = {
    entity_aliases: "resolveAliasUniqueConflict (#1234)",
    entity_relations: "resolveRelationUniqueConflict (#1217)",
    knowledge: "version-aware apply demotes is_current before insert (#897)",
  };

  const indexCols = (name: string) =>
    (
      db().query(`PRAGMA index_info("${name}")`).all() as { name: string }[]
    ).map((r) => r.name);
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length &&
    [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

  for (const m of SYNCED_TABLES.basic) {
    test(`${m.table}: any local-only secondary UNIQUE has convergence handling`, () => {
      const indexes = db().query(`PRAGMA index_list("${m.table}")`).all() as {
        name: string;
        unique: number;
        origin: string;
      }[];
      // origin 'pk' is the remote's key too (ON CONFLICT handles it); a UNIQUE whose
      // columns == idColumns is likewise the remote conflict target — neither diverges.
      const localOnly = indexes.filter(
        (i) =>
          i.unique === 1 &&
          i.origin !== "pk" &&
          !sameSet(indexCols(i.name), m.idColumns),
      );
      if (localOnly.length > 0)
        expect(
          HANDLED[m.table],
          `${m.table} has a local-only secondary UNIQUE (${localOnly
            .map((i) => i.name)
            .join(
              ", ",
            )}) with no convergence handling: a pulled collision would be skipped and leave devices divergent. Add a resolver + route it in handlePulledRowConstraint, then register it in HANDLED.`,
        ).toBeDefined();
    });
  }
});
