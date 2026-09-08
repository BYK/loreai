import { beforeEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  db,
  ensureProject,
  saveSessionTracking,
  withSavepoint,
  mergeProjectInternal,
} from "../src/db";
import { withTenant } from "../src/tenant";
import {
  SourceWindowStore,
  SOURCE_WINDOW_MAX_BYTES,
} from "../src/source-window-store";
import { moveSessions } from "../src/data";

const scope = {
  projectPath: "/test/security-window",
  sessionID: "security-window",
  noStore: false,
};
beforeEach(() => {
  db().exec("DELETE FROM source_windows");
  db()
    .query("DELETE FROM temporal_messages WHERE session_id = ?")
    .run(scope.sessionID);
  ensureProject(scope.projectPath);
  saveSessionTracking(scope.sessionID, {
    amnesia: false,
    projectPath: scope.projectPath,
    projectPathProvisional: false,
  });
});
const commit = (store: SourceWindowStore, value: unknown) =>
  withSavepoint("probe_commit", () => store.claim() && store.publish(value));

it("rejects a small compressed decompression bomb and checksum corruption", () => {
  const owner = new SourceWindowStore(scope);
  expect(commit(owner, { private: "checkpoint" })).toBe(true);
  const bytes = deflateSync(
    JSON.stringify({ bomb: "x".repeat(SOURCE_WINDOW_MAX_BYTES + 1) }),
  );
  expect(bytes.length).toBeLessThan(4000000);
  db()
    .query("UPDATE source_windows SET payload = ?, checksum = ?")
    .run(bytes, createHash("sha256").update(bytes).digest("hex"));
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
  db().query("UPDATE source_windows SET checksum = 'wrong'").run();
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
});

it("rejects external delete and recreate before a stale request commits", () => {
  const stale = new SourceWindowStore(scope);
  const other = new DatabaseSync(process.env.LORE_DB_PATH!);
  try {
    other.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    other
      .prepare("DELETE FROM session_state WHERE session_id = ?")
      .run(scope.sessionID);
    other
      .prepare(
        "INSERT INTO session_state(session_id, updated_at) VALUES (?, ?)",
      )
      .run(scope.sessionID, Date.now());
    other.exec("COMMIT");
  } finally {
    other.close();
  }
  const current = new SourceWindowStore(scope);
  // Both old and new leases are revision zero. Only the generation protects
  // against deleted-and-recreated identity here.
  expect(commit(stale, { private: "old owner" })).toBe(false);
  expect(commit(current, { private: "new owner" })).toBe(true);
  expect(new SourceWindowStore(scope).load()).toEqual({ private: "new owner" });
});

it("rejects a captured lease after changing tenant context", () => {
  const stale = new SourceWindowStore(scope);
  withTenant("foreign-tenant", () => {
    expect(commit(stale, { private: "foreign publication" })).toBe(false);
    ensureProject(scope.projectPath);
    expect(new SourceWindowStore(scope).load()).toBeUndefined();
  });
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
});

it("invalidates a checkpoint when another connection edits a temporal source", () => {
  const pid = ensureProject(scope.projectPath);
  db()
    .query(
      "INSERT INTO temporal_messages(id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES ('external-source', ?, ?, 'user', 'before', 1, 0, 1)",
    )
    .run(pid, scope.sessionID);
  expect(commit(new SourceWindowStore(scope), { private: "before" })).toBe(
    true,
  );
  const stale = new SourceWindowStore(scope);
  const other = new DatabaseSync(process.env.LORE_DB_PATH!);
  try {
    other
      .prepare(
        "UPDATE temporal_messages SET content = 'after' WHERE id = 'external-source'",
      )
      .run();
  } finally {
    other.close();
  }
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
  expect(commit(stale, { private: "before" })).toBe(false);
});

it("invalidates source-owner checkpoints on project merge", () => {
  const source = ensureProject(scope.projectPath);
  const target = ensureProject("/test/security-window-target");
  const stale = new SourceWindowStore(scope);
  expect(commit(new SourceWindowStore(scope), { private: "source" })).toBe(
    true,
  );
  mergeProjectInternal(source, target);
  expect(
    db()
      .query("SELECT payload FROM source_windows WHERE project_id = ?")
      .get(source),
  ).toBeNull();
  expect(commit(stale, { private: "resurrection" })).toBe(false);
});

it("does not claim or publish outside a temporal transaction", () => {
  const store = new SourceWindowStore(scope);
  expect(store.claim()).toBe(false);
  expect(store.publish({ data: "uncommitted" })).toBe(false);
  withSavepoint("claim_only", () => expect(store.claim()).toBe(true));
  expect(store.publish({ data: "after transaction" })).toBe(false);
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
});

it("bounds payload publication and treats hostile IDs as data", () => {
  const hostile = { ...scope, sessionID: "'; DROP TABLE source_windows; --" };
  saveSessionTracking(hostile.sessionID, {});
  expect(commit(new SourceWindowStore(hostile), { text: "private" })).toBe(
    true,
  );
  expect(new SourceWindowStore(hostile).load()).toEqual({ text: "private" });
  expect(
    commit(new SourceWindowStore(scope), {
      tooLarge: "x".repeat(SOURCE_WINDOW_MAX_BYTES),
    }),
  ).toBe(false);
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
});

it("rejects publication into the old project when a source-only session is moved before its first response", () => {
  const source = ensureProject(scope.projectPath);
  saveSessionTracking(scope.sessionID, { projectPath: scope.projectPath });
  // Preparation creates the lease before the first response's temporal rows.
  const stale = new SourceWindowStore(scope);
  expect(
    db()
      .query("SELECT COUNT(*) AS n FROM temporal_messages WHERE session_id = ?")
      .get(scope.sessionID),
  ).toEqual({ n: 0 });
  moveSessions([scope.sessionID], source, "/test/security-moved-project");
  expect(commit(stale, { private: "obsolete project data" })).toBe(false);
});

it("does not create a new lease for an already mismatched confirmed project", () => {
  saveSessionTracking(scope.sessionID, {
    projectPath: "/test/security-moved-project",
    projectPathProvisional: false,
  });
  ensureProject("/test/security-moved-project");
  const wrongScope = new SourceWindowStore(scope);
  expect(commit(wrongScope, { private: "wrong project" })).toBe(false);
  expect(
    db()
      .query("SELECT COUNT(*) AS n FROM source_windows WHERE session_id = ?")
      .get(scope.sessionID),
  ).toEqual({ n: 0 });
});

it("invalidates both a saved checkpoint and an outstanding lease on credential rebind", () => {
  expect(
    commit(new SourceWindowStore(scope), { private: "old credentials" }),
  ).toBe(true);
  const stale = new SourceWindowStore(scope);
  saveSessionTracking(scope.sessionID, {
    credentialFingerprint: "new-credentials",
  });
  expect(commit(stale, { private: "old credentials" })).toBe(false);
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
});

it("accepts canonical and tenant-scoped alias paths for the same project", () => {
  const pid = ensureProject(scope.projectPath);
  const alias = "/test/security-window-alias";
  db()
    .query(
      "INSERT OR REPLACE INTO project_path_aliases(tenant_id, path, project_id) VALUES ('', ?, ?)",
    )
    .run(alias, pid);
  saveSessionTracking(scope.sessionID, { projectPath: alias });
  expect(commit(new SourceWindowStore(scope), { private: "same owner" })).toBe(
    true,
  );
  expect(
    new SourceWindowStore({ ...scope, projectPath: alias }).load(),
  ).toEqual({ private: "same owner" });
});
