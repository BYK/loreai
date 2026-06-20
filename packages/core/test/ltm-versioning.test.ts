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
  test("schema version is 50", () => {
    const v = db().query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(v.version).toBe(50);
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
});
