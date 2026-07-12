import { describe, test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db, onProjectRemoteBackfilled } from "../src/db";
import * as git from "../src/git";
import { backfillGitRemotes } from "../src/data";

// Regression (Seer, PR #1272 review): backfillGitRemotes flips a project
// NULL→remote via a direct UPDATE. It must fire the remote-backfill event so
// the sync layer re-seeds content gated out while the project was remote-less
// (#1246) — exactly like ensureProject's inline lazy backfill does. Without it,
// a project backfilled through this path silently stops being pushed.
describe("backfillGitRemotes remote-backfill reseed event (#1246)", () => {
  let repoDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    onProjectRemoteBackfilled(null);
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true });
      repoDir = undefined;
    }
  });

  test("fires onProjectRemoteBackfilled when it backfills a remote via direct UPDATE", () => {
    // A real, existing directory — backfillGitRemotes skips non-existent paths.
    // Mock the on-disk remote so no real git repo is required.
    repoDir = mkdtempSync(join(tmpdir(), "lore-backfill-evt-"));
    const dir = repoDir;
    const remote = "github.com/test/backfill-evt";
    vi.spyOn(git, "getGitRemote").mockImplementation((p) =>
      p === dir ? remote : null,
    );

    // Seed a remote-less project row directly: ensureProject would resolve the
    // mocked remote immediately, so a raw INSERT reproduces the pre-v14 /
    // remote-less row that backfillGitRemotes is meant to repair.
    const id = crypto.randomUUID();
    db()
      .query(
        "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, NULL, ?)",
      )
      .run(id, dir, "backfill-evt", Date.now());

    const backfilled: string[] = [];
    onProjectRemoteBackfilled((pid) => backfilled.push(pid));

    const result = backfillGitRemotes();

    // The remote was set via the direct-UPDATE branch...
    expect(result.updated).toBe(1);
    const row = db()
      .query("SELECT git_remote FROM projects WHERE id = ?")
      .get(id) as { git_remote: string | null };
    expect(row.git_remote).toBe(remote);
    // ...and the reseed event fired for that project (the bug: it did not).
    expect(backfilled).toContain(id);
  });
});
