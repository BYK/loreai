import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { resolveRelationUniqueConflict } from "../src/sync-data";

function insEntity(id: string) {
  db()
    .query(
      "INSERT OR IGNORE INTO entities (id, entity_type, canonical_name, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
    .run(id, "person", `n-${id}`, Date.now(), Date.now());
}
function insRelation(id: string, a: string, b: string, rel: string) {
  db()
    .query(
      "INSERT INTO entity_relations (id, entity_a, entity_b, relation, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(id, a, b, rel, Date.now(), Date.now());
}
function remoteRelation(id: string, a: string, b: string, rel: string) {
  return { id, entity_a: a, entity_b: b, relation: rel };
}
function conflicts(rowId: string) {
  return db()
    .query(
      "SELECT resolution FROM sync_conflicts WHERE table_name='entity_relations' AND row_id=?",
    )
    .all(rowId) as { resolution: string }[];
}
function relationIds() {
  return (
    db().query("SELECT id FROM entity_relations ORDER BY id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);
}

describe("resolveRelationUniqueConflict — relation UNIQUE convergence (#1217)", () => {
  beforeEach(() => {
    db().query("DELETE FROM entity_relations").run();
    db().query("DELETE FROM entities").run();
    db().query("DELETE FROM sync_conflicts").run();
  });

  it("remote wins (lower id): drops local loser, runs reapply, records the discarded local", () => {
    insEntity("e1");
    insEntity("e2");
    insRelation("r-bbb", "e1", "e2", "knows"); // local, higher id
    let reapplied = false;
    const ok = resolveRelationUniqueConflict(
      remoteRelation("r-aaa", "e1", "e2", "knows"), // remote, lower id
      () => {
        reapplied = true;
        insRelation("r-aaa", "e1", "e2", "knows"); // simulate applyRemote of the winner
      },
    );
    expect(ok).toBe(true);
    expect(reapplied).toBe(true);
    expect(relationIds()).toEqual(["r-aaa"]); // loser gone, winner present
    expect(conflicts("r-bbb")).toHaveLength(1);
  });

  it("local wins (lower id): keeps local, no reapply, records the discarded remote", () => {
    insEntity("e1");
    insEntity("e2");
    insRelation("r-aaa", "e1", "e2", "knows"); // local, lower id
    let reapplied = false;
    const ok = resolveRelationUniqueConflict(
      remoteRelation("r-bbb", "e1", "e2", "knows"), // remote, higher id
      () => {
        reapplied = true;
      },
    );
    expect(ok).toBe(true);
    expect(reapplied).toBe(false);
    expect(relationIds()).toEqual(["r-aaa"]);
    expect(conflicts("r-bbb")).toHaveLength(1);
  });

  it("both pull orders converge to the same (lowest-id) winner", () => {
    insEntity("e1");
    insEntity("e2");
    // Device X: local = lower id, remote = higher id → keeps the lower.
    insRelation("r-1", "e1", "e2", "knows");
    resolveRelationUniqueConflict(
      remoteRelation("r-2", "e1", "e2", "knows"),
      () => {
        throw new Error("must not reapply when local wins");
      },
    );
    expect(relationIds()).toEqual(["r-1"]);

    // Device Y: local = higher id, remote = lower id → converges to the SAME winner.
    db().query("DELETE FROM entity_relations").run();
    insRelation("r-2", "e1", "e2", "knows");
    resolveRelationUniqueConflict(
      remoteRelation("r-1", "e1", "e2", "knows"),
      () => {
        insRelation("r-1", "e1", "e2", "knows");
      },
    );
    expect(relationIds()).toEqual(["r-1"]);
  });

  it("falls through (false) when there is no local (a,b,relation) collision", () => {
    insEntity("e1");
    insEntity("e2");
    insRelation("r-1", "e1", "e2", "knows");
    const ok = resolveRelationUniqueConflict(
      remoteRelation("r-x", "e1", "e2", "dislikes"), // same endpoints, DIFFERENT relation
      () => {
        throw new Error("must not reapply");
      },
    );
    expect(ok).toBe(false);
  });

  it("falls through (false) for the same id (an ordinary update, not a conflict)", () => {
    insEntity("e1");
    insEntity("e2");
    insRelation("r-1", "e1", "e2", "knows");
    const ok = resolveRelationUniqueConflict(
      remoteRelation("r-1", "e1", "e2", "knows"),
      () => {
        throw new Error("must not reapply on an ordinary update");
      },
    );
    expect(ok).toBe(false);
    expect(relationIds()).toEqual(["r-1"]);
  });
});
