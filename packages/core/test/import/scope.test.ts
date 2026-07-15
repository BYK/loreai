import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectSearchPaths } from "../../src/import/scope";
import { db, ensureProject, projectKnownPaths } from "../../src/db";

/**
 * Register a filesystem path as an alias of an existing project. Mirrors the
 * INSERT ensureProject() performs on a git-remote/worktree match, without
 * needing a real git repo in the test sandbox.
 */
function addAlias(path: string, projectId: string): void {
  db()
    .query(
      "INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)",
    )
    .run(path, projectId);
}

describe("projectSearchPaths", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lore-scope-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns just the resolved cwd for a non-git directory", () => {
    // A fresh temp dir is not a git repo → no worktrees, not in the DB.
    const paths = projectSearchPaths(tmp);
    expect(paths).toEqual([resolve(tmp)]);
  });

  test("cwd is always the first element", () => {
    const paths = projectSearchPaths(tmp);
    expect(paths[0]).toBe(resolve(tmp));
  });

  test("worktrees:false restricts to cwd only (no DB union)", () => {
    // Seed a project + alias, then confirm --no-worktrees ignores both.
    const main = join(tmp, "main");
    const alias = join(tmp, "worktree-x");
    const id = ensureProject(main);
    addAlias(alias, id);

    const paths = projectSearchPaths(main, { worktrees: false });
    expect(paths).toEqual([resolve(main)]);
  });

  test("unions DB-known alias paths for the project", () => {
    const main = join(tmp, "main");
    const alias = join(tmp, "worktree-x");
    const id = ensureProject(main);
    addAlias(alias, id);

    const paths = projectSearchPaths(main);
    expect(paths).toContain(resolve(main));
    expect(paths).toContain(resolve(alias));
  });

  test("finds sibling paths when invoked from an alias path", () => {
    // The reported bug: importing from a worktree should still surface the
    // main checkout's history (and vice-versa). projectKnownPaths resolves the
    // shared project from either path.
    const main = join(tmp, "main");
    const alias = join(tmp, "worktree-x");
    const id = ensureProject(main);
    addAlias(alias, id);

    const fromAlias = projectSearchPaths(alias);
    expect(fromAlias[0]).toBe(resolve(alias)); // cwd first
    expect(fromAlias).toContain(resolve(main)); // sibling surfaced
  });

  test("deduplicates overlapping candidate paths", () => {
    const main = join(tmp, "main");
    const id = ensureProject(main);
    // Register the main path itself as an alias (overlap with projects.path).
    addAlias(main, id);

    const paths = projectSearchPaths(main);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });

  test("degrades to [] extra paths when the project is unknown", () => {
    // projectKnownPaths returns [] for a path the DB has never seen.
    expect(projectKnownPaths(join(tmp, "never-seen"))).toEqual([]);
  });
});
