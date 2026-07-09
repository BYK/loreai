import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { resolveAliasUniqueConflict } from "../src/sync-data";

function insEntity(id: string) {
  db()
    .query(
      "INSERT OR IGNORE INTO entities (id, entity_type, canonical_name, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
    .run(id, "person", `n-${id}`, Date.now(), Date.now());
}
function insAlias(id: string, entityId: string, type: string, value: string) {
  db()
    .query(
      "INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, created_at) VALUES (?,?,?,?,?)",
    )
    .run(id, entityId, type, value, Date.now());
}
function remoteAlias(
  id: string,
  entityId: string,
  type: string,
  value: string,
) {
  return { id, entity_id: entityId, alias_type: type, alias_value: value };
}
function conflicts(rowId: string) {
  return db()
    .query(
      "SELECT resolution FROM sync_conflicts WHERE table_name='entity_aliases' AND row_id=?",
    )
    .all(rowId) as { resolution: string }[];
}
function aliasIds() {
  return (
    db().query("SELECT id FROM entity_aliases ORDER BY id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);
}

describe("resolveAliasUniqueConflict — alias UNIQUE convergence (#1217)", () => {
  beforeEach(() => {
    db().query("DELETE FROM entity_aliases").run();
    db().query("DELETE FROM entities").run();
    db().query("DELETE FROM sync_conflicts").run();
  });

  it("remote wins (lower id): drops local loser, runs reapply, records the discarded local", () => {
    insEntity("e-lo");
    insEntity("e-hi");
    insAlias("al-bbb", "e-hi", "name", "Onur"); // local, higher id
    let reapplied = false;
    const ok = resolveAliasUniqueConflict(
      remoteAlias("al-aaa", "e-lo", "name", "Onur"), // remote, lower id
      () => {
        reapplied = true;
        insAlias("al-aaa", "e-lo", "name", "Onur"); // simulate applyRemote of the winner
      },
    );
    expect(ok).toBe(true);
    expect(reapplied).toBe(true);
    expect(aliasIds()).toEqual(["al-aaa"]); // loser gone, winner present
    expect(conflicts("al-bbb")).toHaveLength(1);
  });

  it("local wins (lower id): keeps local, no reapply, records the discarded remote", () => {
    insEntity("e-lo");
    insAlias("al-aaa", "e-lo", "name", "Onur"); // local, lower id
    let reapplied = false;
    const ok = resolveAliasUniqueConflict(
      remoteAlias("al-bbb", "e-hi", "name", "Onur"), // remote, higher id
      () => {
        reapplied = true;
      },
    );
    expect(ok).toBe(true);
    expect(reapplied).toBe(false);
    expect(aliasIds()).toEqual(["al-aaa"]);
    expect(conflicts("al-bbb")).toHaveLength(1);
  });

  it("both pull orders converge to the same (lowest-id) winner", () => {
    // Device X: local = lower id, remote = higher id → keeps the lower.
    insEntity("e1");
    insAlias("al-1", "e1", "name", "Dup");
    resolveAliasUniqueConflict(remoteAlias("al-2", "e1", "name", "Dup"), () => {
      throw new Error("must not reapply when local wins");
    });
    expect(aliasIds()).toEqual(["al-1"]);

    // Device Y: local = higher id, remote = lower id → converges to the SAME winner.
    db().query("DELETE FROM entity_aliases").run();
    insAlias("al-2", "e1", "name", "Dup");
    resolveAliasUniqueConflict(remoteAlias("al-1", "e1", "name", "Dup"), () => {
      insAlias("al-1", "e1", "name", "Dup");
    });
    expect(aliasIds()).toEqual(["al-1"]);
  });

  it("falls through (false) when the remote alias's entity is not admitted (FK orphan)", () => {
    insEntity("e-lo");
    insAlias("al-bbb", "e-lo", "name", "Onur"); // valid local, higher id
    const ok = resolveAliasUniqueConflict(
      remoteAlias("al-aaa", "e-missing", "name", "Onur"), // lower id BUT orphan entity
      () => {
        throw new Error("must not reapply an FK-orphan remote");
      },
    );
    expect(ok).toBe(false); // → caller does the generic skip, keeping the valid local
    expect(aliasIds()).toEqual(["al-bbb"]);
  });

  it("falls through (false) when there is no local (type,value) collision", () => {
    const ok = resolveAliasUniqueConflict(
      remoteAlias("al-x", "e", "name", "Nobody"),
      () => {
        throw new Error("must not reapply");
      },
    );
    expect(ok).toBe(false);
  });
});
