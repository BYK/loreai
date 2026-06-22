import { describe, expect, test } from "vitest";
import { db } from "../src/db";
import * as ltm from "../src/ltm";

const PROJECT = "/test/a2/versioning";

type Row = {
  id: string;
  logical_id: string;
  version: number;
  is_current: number;
  is_deleted: number;
  content: string;
  created_at: number;
  updated_at: number;
};

const COLS =
  "id, logical_id, version, is_current, is_deleted, content, created_at, updated_at";

function versions(logicalId: string): Row[] {
  return db()
    .query(
      `SELECT ${COLS} FROM knowledge WHERE logical_id = ? ORDER BY version`,
    )
    .all(logicalId) as Row[];
}
function current(logicalId: string): Row | undefined {
  return db()
    .query(`SELECT ${COLS} FROM knowledge_current WHERE logical_id = ?`)
    .get(logicalId) as Row | undefined;
}
function ftsHits(token: string): number {
  return (
    db()
      .query("SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ?")
      .all(token) as unknown[]
  ).length;
}

describe("A2 sub-PR 1: append-only knowledge scaffolding", () => {
  test("schema version is 54", () => {
    const v = db().query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(v.version).toBe(54);
  });

  test("create() defaults logical_id = id, version 1, current, not deleted", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "T1",
      content: "c1",
    });
    const v = versions(id);
    expect(v).toHaveLength(1);
    expect(v[0].logical_id).toBe(id);
    expect(v[0].version).toBe(1);
    expect(v[0].is_current).toBe(1);
    expect(v[0].is_deleted).toBe(0);
  });

  test("knowledge_current shows exactly the current live row", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "T2",
      content: "orig",
    });
    expect(current(id)?.content).toBe("orig");
  });

  test("appendVersion appends v2, demotes v1, view reflects v2", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "T3",
      content: "v1body",
    });
    const newId = ltm.appendVersion(id, { content: "v2body" });
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(id);

    const v = versions(id);
    expect(v).toHaveLength(2); // append-only: both physically present
    const v1 = v.find((x) => x.version === 1)!;
    const v2 = v.find((x) => x.version === 2)!;
    expect(v1.is_current).toBe(0); // demoted
    expect(v2.is_current).toBe(1);
    expect(v2.logical_id).toBe(id); // same logical entry
    expect(v2.content).toBe("v2body");
    expect(v2.created_at).toBe(v1.created_at); // entry creation preserved
    expect(v2.updated_at).toBeGreaterThanOrEqual(v1.updated_at);

    const c = current(id);
    expect(c?.content).toBe("v2body");
    expect(c?.version).toBe(2);
  });

  test("appendVersion(isDeleted) removes the entry from the current view", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "T4",
      content: "live",
    });
    ltm.appendVersion(id, { isDeleted: true });
    expect(current(id) ?? null).toBeNull(); // gone from current
    // but the death-certificate version is physically present (append-only)
    const v = versions(id);
    expect(v.some((x) => x.is_deleted === 1 && x.is_current === 1)).toBe(true);
  });

  test("FTS is current-aware: superseded content is not searchable; new is", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "FtsTitle",
      content: "alphauniqueword",
    });
    expect(ftsHits("alphauniqueword")).toBeGreaterThan(0);
    ltm.appendVersion(id, { content: "betauniqueword" });
    expect(ftsHits("alphauniqueword")).toBe(0); // superseded version dropped
    expect(ftsHits("betauniqueword")).toBeGreaterThan(0); // new current indexed
  });

  test("a deleted version is removed from FTS", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "DelTitle",
      content: "searchmeunique",
    });
    expect(ftsHits("searchmeunique")).toBeGreaterThan(0);
    ltm.appendVersion(id, { isDeleted: true });
    expect(ftsHits("searchmeunique")).toBe(0);
  });

  test("appendVersion returns null for an unknown logical_id", () => {
    expect(ltm.appendVersion("does-not-exist")).toBeNull();
  });

  test("update() with a content change appends an immutable new version", () => {
    // sub-PR 2b-2b rewires update() onto appendVersion: a content change appends
    // a new current version; the prior version is preserved (immutable, demoted)
    // and FTS indexes only the current content.
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "InPlace",
      content: "inplaceoldtok",
    });
    expect(ftsHits("inplaceoldtok")).toBeGreaterThan(0);
    ltm.update(id, { content: "inplacenewtok" });
    const v = versions(id);
    expect(v).toHaveLength(2); // append: a new version row
    expect(v[0].version).toBe(1);
    expect(v[0].is_current).toBe(0); // prior version demoted...
    expect(v[0].content).toBe("inplaceoldtok"); // ...but its content is immutable
    expect(v[1].version).toBe(2);
    expect(v[1].is_current).toBe(1);
    expect(current(id)?.content).toBe("inplacenewtok");
    expect(ftsHits("inplaceoldtok")).toBe(0); // superseded content not searchable
    expect(ftsHits("inplacenewtok")).toBeGreaterThan(0);
  });

  test("appendVersion after a delete revives the entry (no FTS mismatch)", () => {
    // The corruption-prone path: demoting an is_deleted=1 row must NOT issue a
    // mismatched FTS 'delete' (the death cert was never indexed).
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Revive",
      content: "beforedeltok",
    });
    ltm.appendVersion(id, { isDeleted: true });
    expect(current(id) ?? null).toBeNull();
    expect(ftsHits("beforedeltok")).toBe(0);
    const revived = ltm.appendVersion(id, { content: "revivedtok" });
    expect(revived).not.toBeNull();
    const c = current(id);
    expect(c?.content).toBe("revivedtok");
    expect(c?.version).toBe(3); // v1 live, v2 death-cert, v3 revived
    expect(ftsHits("revivedtok")).toBeGreaterThan(0);
  });

  test("multi-version chain v1->v2->v3: exactly one current, only latest searchable", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Chain",
      content: "chainonetok",
    });
    ltm.appendVersion(id, { content: "chaintwotok" });
    ltm.appendVersion(id, { content: "chainthreetok" });
    const v = versions(id);
    expect(v).toHaveLength(3);
    expect(v.filter((x) => x.is_current === 1)).toHaveLength(1);
    expect(current(id)?.version).toBe(3);
    expect(current(id)?.content).toBe("chainthreetok");
    expect(ftsHits("chainonetok")).toBe(0);
    expect(ftsHits("chaintwotok")).toBe(0);
    expect(ftsHits("chainthreetok")).toBeGreaterThan(0);
  });
});
