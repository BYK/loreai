import { expect, it } from "vitest";
import {
  db,
  ensureProject,
  saveSessionTracking,
  withSavepoint,
} from "../src/db";
import { moveSessions } from "../src/data";
import { SourceWindowStore } from "../src/source-window-store";

it("rejects an existing private checkpoint moved under the old trigger set", () => {
  const scope = {
    projectPath: "/test/read-binding-source",
    sessionID: "read-binding-probe",
    noStore: false,
  };
  const pid = ensureProject(scope.projectPath);
  saveSessionTracking(scope.sessionID, { projectPath: scope.projectPath });
  const store = new SourceWindowStore(scope);
  withSavepoint("save_before_move", () => {
    expect(store.claim()).toBe(true);
    expect(store.publish({ private: "old project" })).toBe(true);
  });
  // Reproduce the prior source-only move defect through the real move API.
  const row = db()
    .query(
      "SELECT sql FROM sqlite_master WHERE name = 'source_windows_session_rebind'",
    )
    .get() as { sql: string };
  db().exec("DROP TRIGGER source_windows_session_rebind");
  try {
    moveSessions([scope.sessionID], pid, "/test/read-binding-destination");
  } finally {
    db().exec(row.sql);
  }
  expect(
    db()
      .query(
        "SELECT payload IS NOT NULL AS present FROM source_windows WHERE project_id = ? AND session_id = ?",
      )
      .get(pid, scope.sessionID),
  ).toEqual({ present: 1 });
  expect(new SourceWindowStore(scope).load()).toBeUndefined();
});
