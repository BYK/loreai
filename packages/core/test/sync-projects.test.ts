/**
 * #1246 — cross-device project-identity sync. project_id is a random per-device UUID;
 * git_remote is the stable cross-device key. These cover the client half (P1): the
 * applyRemoteProject pull-seed (synthetic-path FK parent) / identity backfill, the
 * deterministic convergeProjectsByRemote merge, and the git_remote capture/seed gate.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  convergeProjectsByRemote,
  db,
  deleteTeamConfig,
  reinstallSyncCapture,
} from "../src/db";
import {
  applyRemoteProject,
  assertSyncInvariants,
  enableSync,
  readOutbox,
  reconcile,
  reseedProjectContent,
  setSyncState,
} from "../src/sync-data";

const now = () => Date.now();

// Direct inserts bypass ensureProject's git-detection + test-path guard so we control
// git_remote precisely.
function insertProject(
  id: string,
  gitRemote: string | null,
  name = "repo",
  path = `/local/${id}`,
) {
  db()
    .query(
      "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, path, name, gitRemote, now());
}
function getProject(id: string) {
  return db()
    .query("SELECT id, path, name, git_remote FROM projects WHERE id = ?")
    .get(id) as {
    id: string;
    path: string;
    name: string | null;
    git_remote: string | null;
  } | null;
}
function insertKnowledge(
  id: string,
  projectId: string | null,
  crossProject = 0,
) {
  db()
    .query(
      `INSERT INTO knowledge (id, logical_id, project_id, category, title, content, cross_project, created_at, updated_at)
       VALUES (?, ?, ?, 'pattern', 't', 'c', ?, ?, ?)`,
    )
    .run(id, id, projectId, crossProject, now(), now());
}
function insertEntity(id: string, projectId: string | null, crossProject = 0) {
  db()
    .query(
      `INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at)
       VALUES (?, ?, 'tool', 'n', ?, ?, ?)`,
    )
    .run(id, projectId, crossProject, now(), now());
}
const outboxRowIds = (table: string) =>
  readOutbox(0, 1000)
    .filter((e) => e.table_name === table)
    .map((e) => e.row_id);
const projectOutbox = () => outboxRowIds("projects");

beforeEach(() => {
  deleteTeamConfig("sync.enabled");
  db().exec("DELETE FROM temp._sync_applying");
  db().exec("DELETE FROM sync_outbox");
  db().exec("DELETE FROM sync_state");
  db().exec("DELETE FROM knowledge");
  db().exec("DELETE FROM knowledge_meta");
  db().exec("DELETE FROM entities");
  db().exec("DELETE FROM profiles");
  db().exec(
    "DELETE FROM projects WHERE path LIKE '/local/%' OR path LIKE '/real/%' OR path LIKE 'lore:project/%'",
  );
  reinstallSyncCapture();
});

afterEach(() => assertSyncInvariants());

describe("applyRemoteProject (pull-seed / backfill)", () => {
  test("seeds a synthetic-path FK-parent row for an unknown id", () => {
    applyRemoteProject({
      id: "p-new",
      git_remote: "github.com/o/r",
      name: "r",
      created_at: now(),
    });
    const p = getProject("p-new");
    expect(p?.path).toBe("lore:project/p-new"); // synthetic, non-fs, unique per id
    expect(p?.git_remote).toBe("github.com/o/r");
    expect(p?.name).toBe("r");
  });

  test("re-applying the same remote row is idempotent (updates in place, no duplicate)", () => {
    applyRemoteProject({
      id: "p-idem",
      git_remote: "R",
      name: "r",
      created_at: now(),
    });
    applyRemoteProject({
      id: "p-idem",
      git_remote: "R",
      name: "r2",
      created_at: now(),
    });
    const c = db()
      .query("SELECT COUNT(*) as c FROM projects WHERE id = 'p-idem'")
      .get() as { c: number };
    expect(c.c).toBe(1); // no duplicate row
    expect(getProject("p-idem")?.name).toBe("r2"); // updated in place
    expect(getProject("p-idem")?.path).toBe("lore:project/p-idem"); // still synthetic
  });

  test("backfills git_remote but COALESCE keeps a locally-known name; never touches path", () => {
    insertProject("p-loc", null, "local-name", "/real/path");
    applyRemoteProject({
      id: "p-loc",
      git_remote: "R",
      name: null,
      created_at: now(),
    });
    const p = getProject("p-loc");
    expect(p?.git_remote).toBe("R"); // backfilled
    expect(p?.name).toBe("local-name"); // COALESCE kept the local value
    expect(p?.path).toBe("/real/path"); // device-local path untouched
  });
});

describe("convergeProjectsByRemote (deterministic merge)", () => {
  test("merges same-remote projects into the min-id winner and re-keys content", () => {
    insertProject("bbb", "R", "r", "/local/bbb");
    insertProject("aaa", "R", "r", "/local/aaa"); // inserted second, but is the min id
    insertKnowledge("k-b", "bbb"); // content under the (to-be) loser
    convergeProjectsByRemote();
    expect(getProject("aaa")).toBeTruthy(); // lexicographically-smallest id wins
    expect(getProject("bbb")).toBeNull(); // loser merged away
    const k = db()
      .query("SELECT project_id FROM knowledge WHERE id = 'k-b'")
      .get() as { project_id: string };
    expect(k.project_id).toBe("aaa"); // content re-keyed to the winner
  });

  test("a merge-loser is NEVER tombstoned by reconcile (projects is delete-invisible)", () => {
    insertProject("bbb", "R");
    insertProject("aaa", "R");
    // Both look previously-pushed (a sync_state row is the trigger for reconcile's
    // delete-tombstone pass on a now-missing local row).
    setSyncState("projects", "aaa", {
      content_hash: "h",
      revision: 0,
      remote_updated_at: null,
    });
    setSyncState("projects", "bbb", {
      content_hash: "h",
      revision: 0,
      remote_updated_at: null,
    });
    enableSync("basic");
    convergeProjectsByRemote(); // merges bbb → aaa, deletes bbb locally
    db().exec("DELETE FROM sync_outbox"); // ignore seed / re-key upserts
    reconcile("basic"); // delete-tombstone pass — must SKIP projects (deleteInvisible)
    const del = readOutbox(0, 1000).filter(
      (e) => e.table_name === "projects" && e.op === "delete",
    );
    expect(del.map((e) => e.row_id)).not.toContain("bbb"); // loser NOT tombstoned
  });

  test("is a no-op when projects have distinct remotes", () => {
    insertProject("aaa", "R1");
    insertProject("bbb", "R2");
    convergeProjectsByRemote();
    expect(getProject("aaa")).toBeTruthy();
    expect(getProject("bbb")).toBeTruthy();
  });

  test("ignores remote-less projects (NULL git_remote never groups)", () => {
    insertProject("aaa", null);
    insertProject("bbb", null);
    convergeProjectsByRemote();
    expect(getProject("aaa")).toBeTruthy();
    expect(getProject("bbb")).toBeTruthy();
  });
});

describe("git_remote gate (only remote-backed projects sync)", () => {
  test("capture: a remote-backed project enqueues; a remote-less one does not", () => {
    enableSync("basic");
    insertProject("with-r", "R");
    insertProject("no-r", null);
    const q = projectOutbox();
    expect(q).toContain("with-r");
    expect(q).not.toContain("no-r");
  });

  test("seed: only remote-backed projects are seeded on enable", () => {
    insertProject("seed-r", "R"); // created while sync is OFF → seeded, not captured
    insertProject("seed-none", null);
    enableSync("basic"); // reconcile → seedOutbox
    const q = projectOutbox();
    expect(q).toContain("seed-r");
    expect(q).not.toContain("seed-none");
  });
});

describe("content git_remote gate — P2a (#1246)", () => {
  test("capture: knowledge/entities of a remote-backed project enqueue; a remote-less one's do NOT", () => {
    insertProject("p-remote", "R");
    insertProject("p-local", null);
    enableSync("basic");
    insertKnowledge("k-remote", "p-remote");
    insertKnowledge("k-local", "p-local");
    insertEntity("e-remote", "p-remote");
    insertEntity("e-local", "p-local");
    expect(outboxRowIds("knowledge")).toEqual(["k-remote"]);
    expect(outboxRowIds("entities")).toEqual(["e-remote"]);
  });

  test("capture: GLOBAL/cross-project content ALWAYS syncs, even under a remote-less project", () => {
    insertProject("p-local", null);
    enableSync("basic");
    // cross_project=1 retains its origin project_id but is not tied to that remote.
    insertKnowledge("k-cross", "p-local", 1);
    insertEntity("e-cross", "p-local", 1);
    insertKnowledge("k-global", null); // NULL project_id (global)
    insertEntity("e-global", null);
    expect(outboxRowIds("knowledge").sort()).toEqual(["k-cross", "k-global"]);
    expect(outboxRowIds("entities").sort()).toEqual(["e-cross", "e-global"]);
  });

  test("seed: only remote-backed (+ global/cross) content is seeded on enable", () => {
    // Created while sync is OFF → exercises the seedSelect gate, not the trigger.
    insertProject("p-remote", "R");
    insertProject("p-local", null);
    insertKnowledge("k-remote", "p-remote");
    insertKnowledge("k-local", "p-local"); // gated out
    insertKnowledge("k-cross", "p-local", 1); // global → always seeded
    insertEntity("e-remote", "p-remote");
    insertEntity("e-local", "p-local"); // gated out
    enableSync("basic"); // reconcile → seedOutbox
    expect(outboxRowIds("knowledge").sort()).toEqual(["k-cross", "k-remote"]);
    expect(outboxRowIds("entities")).toEqual(["e-remote"]);
  });

  test("reseedProjectContent: re-enqueues a project's project-scoped content after it gains a remote", () => {
    // A project created remote-less: its content is NOT captured (gated out)…
    insertProject("p", null);
    enableSync("basic");
    insertKnowledge("k1", "p");
    insertKnowledge("k2", "p");
    insertKnowledge("k-cross", "p", 1); // global → already captured
    insertEntity("e1", "p");
    expect(outboxRowIds("knowledge")).toEqual(["k-cross"]); // only the global one
    expect(outboxRowIds("entities")).toEqual([]);
    // …now the project gains a remote (backfill fires this) → its held-back
    // project-scoped content is re-enqueued (the global one is NOT re-queued).
    db().query("UPDATE projects SET git_remote='R' WHERE id='p'").run();
    reseedProjectContent("p");
    expect(outboxRowIds("knowledge").sort()).toEqual(["k-cross", "k1", "k2"]);
    expect(outboxRowIds("entities")).toEqual(["e1"]);
  });

  test("reseedProjectContent: no-op when sync is disabled", () => {
    insertProject("p", "R");
    insertKnowledge("k1", "p");
    reseedProjectContent("p"); // sync OFF → must not enqueue
    expect(outboxRowIds("knowledge")).toEqual([]);
  });
});
