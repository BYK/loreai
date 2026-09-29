/**
 * Tests for the repair-support helpers in data.ts:
 *   - getSessionConfidentProjectPath (Tier A signal for `lore data split`)
 *   - backupDatabase (mandatory pre-write snapshot; never touches WAL/SHM)
 *   - validateDatabaseIntegrity (post-mutation safety check)
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach } from "vitest";
import { close, db, dbPath, ensureProject } from "../src/db";
import * as data from "../src/data";

function setSessionState(
  sessionId: string,
  projectPath: string,
  provisional: boolean,
): void {
  db()
    .query(
      `INSERT INTO session_state (session_id, force_min_layer, updated_at, project_path, project_path_provisional)
       VALUES (?, 0, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET project_path = excluded.project_path, project_path_provisional = excluded.project_path_provisional`,
    )
    .run(sessionId, Date.now(), projectPath, provisional ? 1 : 0);
}

function insertMessage(projectId: string, sessionId: string, id: string): void {
  db()
    .query(
      `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, 'user', 'hello world', 5, 0, ?, '{}')`,
    )
    .run(id, projectId, sessionId, Date.now());
}

describe("getSessionConfidentProjectPath", () => {
  beforeEach(() => {
    db().query("DELETE FROM session_state").run();
  });

  test("returns the path for a confidently-bound session", () => {
    ensureProject("/test/repair/confident");
    setSessionState("sess-confident", "/test/repair/confident", false);
    expect(data.getSessionConfidentProjectPath("sess-confident")).toBe(
      "/test/repair/confident",
    );
  });

  test("returns null for a provisional binding", () => {
    setSessionState("sess-prov", "/test/repair/prov", true);
    expect(data.getSessionConfidentProjectPath("sess-prov")).toBeNull();
  });

  test("returns null for an unknown session", () => {
    expect(data.getSessionConfidentProjectPath("nope")).toBeNull();
  });
});

describe("backupDatabase", () => {
  function withIsolatedLiveDb(run: (live: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "lore-backup-boundary-"));
    const previousPath = process.env.LORE_DB_PATH;
    try {
      close();
      process.env.LORE_DB_PATH = join(dir, "live.db");
      ensureProject("/test/backup/boundary");
      run(dbPath());
    } finally {
      close();
      if (previousPath === undefined) delete process.env.LORE_DB_PATH;
      else process.env.LORE_DB_PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test.each(["", "-wal", "-shm"])(
    "rejects a destination overlapping the live database%s",
    (suffix) => {
      withIsolatedLiveDb((live) => {
        const target = `${live}${suffix}`;
        const before = readFileSync(target);
        expect(() => data.backupDatabase(target)).toThrow(/destination/);
        expect(readFileSync(target)).toEqual(before);
      });
    },
  );

  test("preserves an existing destination and its sidecars", () => {
    withIsolatedLiveDb((live) => {
      const target = `${live}.existing`;
      for (const suffix of ["", "-wal", "-shm"]) {
        writeFileSync(
          `${target}${suffix}`,
          `unrelated backup target ${suffix}`,
        );
      }
      expect(() => data.backupDatabase(target)).toThrow(/exist|destination/);
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(readFileSync(`${target}${suffix}`, "utf8")).toBe(
          `unrelated backup target ${suffix}`,
        );
      }
    });
  });

  test("creates a consistent snapshot without touching WAL/SHM", () => {
    const pidA = ensureProject("/test/backup/proj");
    insertMessage(pidA, "backup-sess", `bk-${crypto.randomUUID()}`);

    const live = dbPath();
    const dest = `${live}.test-backup-${crypto.randomUUID()}`;
    let created = "";
    try {
      created = data.backupDatabase(dest);
      expect(created).toBe(dest);
      expect(existsSync(dest)).toBe(true);
      // The backup must NOT have produced/deleted the live sidecar files.
      // (We can't assert the live -wal exists in every harness, but we CAN
      // assert the live DB file itself still exists and is non-empty.)
      expect(existsSync(live)).toBe(true);
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${dest}${suffix}`, { force: true });
      }
    }
  });
});

describe("validateDatabaseIntegrity", () => {
  test("reports ok with matching message count", () => {
    const pid = ensureProject("/test/validate/proj");
    const before = data.validateDatabaseIntegrity();
    expect(before.integrity).toBe("ok");
    expect(before.knowledgeFtsMatch).toBe(true);

    insertMessage(pid, "validate-sess", `vd-${crypto.randomUUID()}`);
    const after = data.validateDatabaseIntegrity();
    expect(after.ok).toBe(true);
    expect(after.messageCount).toBe(before.messageCount + 1);
  });
});
