import { beforeEach, expect, it } from "vitest";
import {
  close,
  db,
  ensureProject,
  saveSessionTracking,
  withSavepoint,
  MIGRATIONS,
} from "../src/db";
import { withTenant } from "../src/tenant";
import {
  SourceWindowStore,
  SOURCE_WINDOW_MAX_SESSIONS,
} from "../src/source-window-store";
import { clearProject } from "../src/data";

const scope = {
  projectPath: "/test/source-window",
  sessionID: "source-window",
  noStore: false,
};
beforeEach(() => {
  db().exec("DELETE FROM session_state WHERE session_id = 'source-window'");
  ensureProject(scope.projectPath);
  saveSessionTracking(scope.sessionID, {});
});
function commit(store: SourceWindowStore, value: unknown) {
  return withSavepoint("accepted_turn", () => {
    if (!store.claim()) return false;
    return store.publish(value);
  });
}
it("rehydrates an accepted checkpoint after closing the database", () => {
  const store = new SourceWindowStore(scope);
  expect(commit(store, { count: 5580, encrypted: "opaque payload" })).toBe(
    true,
  );
  close();
  expect(new SourceWindowStore(scope).load()).toEqual({
    count: 5580,
    encrypted: "opaque payload",
  });
});
it("rolls back the source frontier with a failed temporal transaction", () => {
  const store = new SourceWindowStore(scope);
  expect(() =>
    withSavepoint("failed_turn", () => {
      expect(store.claim()).toBe(true);
      expect(store.publish({ count: 5582 })).toBe(true);
      throw new Error("disk failure");
    }),
  ).toThrow("disk failure");
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
  expect(commit(store, { count: 5582 })).toBe(true);
});
it("rejects stale completion after deletion and same-session recreation", () => {
  const stale = new SourceWindowStore(scope);
  db()
    .query("DELETE FROM session_state WHERE session_id = ?")
    .run(scope.sessionID);
  saveSessionTracking(scope.sessionID, {});
  const live = new SourceWindowStore(scope);
  expect(commit(live, { count: 2 })).toBe(true);
  expect(commit(stale, { count: 9000 })).toBe(false);
  expect(new SourceWindowStore(scope).load()).toEqual({ count: 2 });
});
it("invalidates on temporal edits while allowing the owning transaction's inserts", () => {
  const pid = ensureProject(scope.projectPath);
  const store = new SourceWindowStore(scope);
  withSavepoint("accepted_turn", () => {
    expect(store.claim()).toBe(true);
    db()
      .query(
        `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES ('window-msg', ?, ?, 'user', 'original', 1, 0, 1)`,
      )
      .run(pid, scope.sessionID);
    expect(store.publish({ count: 1 })).toBe(true);
  });
  const stale = new SourceWindowStore(scope);
  db()
    .query(
      "UPDATE temporal_messages SET content = 'changed' WHERE id = 'window-msg'",
    )
    .run();
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
  expect(commit(stale, { count: 2 })).toBe(false);
  db().query("DELETE FROM temporal_messages WHERE id = 'window-msg'").run();
});
it("does not read or publish checkpoints in no-store or a different tenant", () => {
  expect(commit(new SourceWindowStore(scope), { private: "data" })).toBe(true);
  const disabled = new SourceWindowStore({ ...scope, noStore: true });
  expect(disabled.load()).toBeUndefined();
  expect(commit(disabled, { private: "replacement" })).toBe(false);
  withTenant("another-tenant", () => {
    const other = new SourceWindowStore(scope);
    expect(other.load()).toBeUndefined();
    expect(commit(other, { stolen: true })).toBe(false);
  });
  expect(new SourceWindowStore(scope).load()).toEqual({ private: "data" });
});

it("rejects a competing older completion", () => {
  const first = new SourceWindowStore(scope);
  const older = new SourceWindowStore(scope);
  expect(commit(first, { count: 5582 })).toBe(true);
  expect(commit(older, { count: 5580 })).toBe(false);
  expect(new SourceWindowStore(scope).load()).toEqual({ count: 5582 });
});
it.each(["clear", "amnesia"])(
  "discards private state and its outstanding lease on %s",
  (mode) => {
    expect(commit(new SourceWindowStore(scope), { private: "data" })).toBe(
      true,
    );
    const pending = new SourceWindowStore(scope);
    if (mode === "clear") clearProject(scope.projectPath);
    else saveSessionTracking(scope.sessionID, { amnesia: true });
    expect(new SourceWindowStore(scope).load()).toBeUndefined();
    expect(commit(pending, { private: "stale data" })).toBe(false);
  },
);
it("does not publish into a replacement connection", () => {
  const pending = new SourceWindowStore(scope);
  close();
  expect(commit(pending, { count: 100 })).toBe(false);
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
});
it("bounds abandoned checkpoint leases as well as completed windows", () => {
  for (let i = 0; i < SOURCE_WINDOW_MAX_SESSIONS + 5; i++) {
    const sessionID = `abandoned-${i}`;
    saveSessionTracking(sessionID, {});
    new SourceWindowStore({ ...scope, sessionID });
  }
  expect(db().query("SELECT COUNT(*) AS n FROM source_windows").get()).toEqual({
    n: SOURCE_WINDOW_MAX_SESSIONS,
  });
});
it("migrates and repairs the disposable table without changing temporal rows", () => {
  db().exec(
    "DROP TABLE source_windows; UPDATE schema_version SET version = 86",
  );
  close();
  expect(db().query("SELECT version FROM schema_version").get()).toEqual({
    version: MIGRATIONS.length,
  });
  expect(commit(new SourceWindowStore(scope), { count: 10 })).toBe(true);
  db().exec("DROP TABLE source_windows");
  close();
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
  expect(commit(new SourceWindowStore(scope), { count: 11 })).toBe(true);
});
