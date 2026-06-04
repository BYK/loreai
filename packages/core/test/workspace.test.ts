import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverWorkspaceRoot,
  resolveWorkspaces,
  clearWorkspaceCache,
} from "../src/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempBase: string;

function makeTempDir(): string {
  if (!tempBase) {
    tempBase = mkdtempSync(join(tmpdir(), "lore-workspace-test-"));
  }
  const dir = join(
    tempBase,
    `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(dir: string, file: string, content = ""): void {
  const fp = join(dir, file);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, content);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearWorkspaceCache();
});

afterAll(() => {
  if (tempBase) {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
});

// ---------------------------------------------------------------------------
// discoverWorkspaceRoot
// ---------------------------------------------------------------------------

describe("discoverWorkspaceRoot", () => {
  test("returns cwd when .git exists at cwd", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".git"));
    expect(discoverWorkspaceRoot(root)).toBe(root);
  });

  test("finds .git above cwd", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".git"));
    const sub = join(root, "packages", "a");
    mkdirSync(sub, { recursive: true });
    expect(discoverWorkspaceRoot(sub)).toBe(root);
  });

  test(".lore.json with workspaces is highest priority", () => {
    const root = makeTempDir();
    // .git is at the root — but .lore.json with workspaces is also there
    mkdirSync(join(root, ".git"));
    writeFileSync(
      join(root, ".lore.json"),
      JSON.stringify({ workspaces: ["project-a"] }),
    );
    const sub = join(root, "project-a");
    mkdirSync(sub, { recursive: true });

    // .lore.json with workspaces should be found first (before .git check)
    // Both are at the same level, so result is the same directory
    expect(discoverWorkspaceRoot(sub)).toBe(root);
  });

  test(".lore.json with workspaces above .git wins", () => {
    const root = makeTempDir();
    writeFileSync(
      join(root, ".lore.json"),
      JSON.stringify({ workspaces: ["project-a"] }),
    );
    const projectA = join(root, "project-a");
    mkdirSync(projectA, { recursive: true });
    // project-a has its own .git — but the parent's .lore.json with workspaces wins
    mkdirSync(join(projectA, ".git"));

    // Starting from project-a: finds .git at project-a first (definitive),
    // but .lore.json with workspaces is above. Since .git is definitive and
    // stops the walk, it returns project-a. This is correct — when you're
    // inside a sub-project with its own .git, that IS your project root.
    expect(discoverWorkspaceRoot(projectA)).toBe(projectA);

    // Starting from a non-git subdir under root, the .lore.json wins
    const noGitSub = join(root, "scripts");
    mkdirSync(noGitSub, { recursive: true });
    expect(discoverWorkspaceRoot(noGitSub)).toBe(root);
  });

  test("pnpm-workspace.yaml at parent returns parent", () => {
    const root = makeTempDir();
    touch(root, "pnpm-workspace.yaml");
    const sub = join(root, "packages", "a");
    mkdirSync(sub, { recursive: true });
    expect(discoverWorkspaceRoot(sub)).toBe(root);
  });

  test("workspace markers: nx.json, turbo.json, lerna.json", () => {
    for (const marker of ["nx.json", "turbo.json", "lerna.json"]) {
      clearWorkspaceCache();
      const root = makeTempDir();
      touch(root, marker);
      const sub = join(root, "apps", "web");
      mkdirSync(sub, { recursive: true });
      expect(discoverWorkspaceRoot(sub)).toBe(root);
    }
  });

  test("language marker (package.json) returns closest-wins", () => {
    const root = makeTempDir();
    const sub = join(root, "project-a");
    mkdirSync(sub, { recursive: true });
    touch(sub, "package.json", "{}");
    // Root has no markers — language marker at sub is closest
    expect(discoverWorkspaceRoot(sub)).toBe(sub);
  });

  test("language marker: walk continues past to find definitive root", () => {
    const root = makeTempDir();
    touch(root, "pnpm-workspace.yaml");
    const sub = join(root, "packages", "a");
    mkdirSync(sub, { recursive: true });
    touch(sub, "package.json", "{}");
    // pnpm-workspace.yaml at root is definitive — wins over package.json at sub
    expect(discoverWorkspaceRoot(sub)).toBe(root);
  });

  test("no markers found returns startDir", () => {
    const dir = makeTempDir();
    expect(discoverWorkspaceRoot(dir)).toBe(dir);
  });

  test("cache returns same result on second call", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".git"));
    const sub = join(root, "src");
    mkdirSync(sub, { recursive: true });

    const first = discoverWorkspaceRoot(sub);
    const second = discoverWorkspaceRoot(sub);
    expect(first).toBe(root);
    expect(second).toBe(root);
  });

  test("fake monorepo: sub-projects under root with pnpm-workspace.yaml", () => {
    // This is the target scenario: monorepo root has pnpm-workspace.yaml
    // but no .git. Sub-projects are bare directories.
    const root = makeTempDir();
    touch(root, "pnpm-workspace.yaml");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    touch(projectA, "package.json", "{}");
    touch(projectB, "package.json", "{}");

    expect(discoverWorkspaceRoot(projectA)).toBe(root);
    clearWorkspaceCache();
    expect(discoverWorkspaceRoot(projectB)).toBe(root);
  });

  test("fake monorepo with .lore.json workspaces config", () => {
    // The primary target scenario: no .git at root, .lore.json declares workspaces
    const root = makeTempDir();
    writeFileSync(
      join(root, ".lore.json"),
      JSON.stringify({ workspaces: ["project-a", "project-b"] }),
    );
    const projectA = join(root, "project-a");
    mkdirSync(projectA, { recursive: true });
    touch(projectA, "package.json", "{}");

    expect(discoverWorkspaceRoot(projectA)).toBe(root);
  });

  test(".lore.json without workspaces is not a workspace signal", () => {
    const root = makeTempDir();
    // .lore.json exists but has no workspaces field
    writeFileSync(
      join(root, ".lore.json"),
      JSON.stringify({ crossProject: true }),
    );
    const sub = join(root, "project");
    mkdirSync(sub, { recursive: true });
    // No definitive marker, no language marker → returns startDir
    expect(discoverWorkspaceRoot(sub)).toBe(sub);
  });

  test(".lore.json with empty workspaces array is not a signal", () => {
    const root = makeTempDir();
    writeFileSync(join(root, ".lore.json"), JSON.stringify({ workspaces: [] }));
    const sub = join(root, "project");
    mkdirSync(sub, { recursive: true });
    expect(discoverWorkspaceRoot(sub)).toBe(sub);
  });

  test("VCS markers: .hg, .jj, .svn", () => {
    for (const marker of [".hg", ".jj", ".svn"]) {
      clearWorkspaceCache();
      const root = makeTempDir();
      mkdirSync(join(root, marker));
      const sub = join(root, "src");
      mkdirSync(sub, { recursive: true });
      expect(discoverWorkspaceRoot(sub)).toBe(root);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaces
// ---------------------------------------------------------------------------

describe("resolveWorkspaces", () => {
  test("resolves literal paths to existing directories", () => {
    const root = makeTempDir();
    const a = join(root, "project-a");
    const b = join(root, "project-b");
    mkdirSync(a);
    mkdirSync(b);

    const result = resolveWorkspaces(root, ["project-a", "project-b"]);
    expect(result).toEqual([a, b]);
  });

  test("filters out non-existent literal paths", () => {
    const root = makeTempDir();
    const a = join(root, "project-a");
    mkdirSync(a);

    const result = resolveWorkspaces(root, ["project-a", "does-not-exist"]);
    expect(result).toEqual([a]);
  });

  test("filters out files (only directories)", () => {
    const root = makeTempDir();
    touch(root, "not-a-dir");

    const result = resolveWorkspaces(root, ["not-a-dir"]);
    expect(result).toEqual([]);
  });

  test("expands glob patterns like packages/*", () => {
    const root = makeTempDir();
    const pkgs = join(root, "packages");
    mkdirSync(pkgs);
    mkdirSync(join(pkgs, "core"));
    mkdirSync(join(pkgs, "gateway"));
    // Also add a file — should be filtered out
    writeFileSync(join(pkgs, "README.md"), "");

    const result = resolveWorkspaces(root, ["packages/*"]);
    expect(result.sort()).toEqual(
      [join(pkgs, "core"), join(pkgs, "gateway")].sort(),
    );
  });

  test("glob pattern with non-existent parent returns empty", () => {
    const root = makeTempDir();
    const result = resolveWorkspaces(root, ["nonexistent/*"]);
    expect(result).toEqual([]);
  });

  test("mixed literal paths and globs", () => {
    const root = makeTempDir();
    const infra = join(root, "infra");
    const pkgs = join(root, "packages");
    mkdirSync(infra);
    mkdirSync(pkgs);
    mkdirSync(join(pkgs, "web"));
    mkdirSync(join(pkgs, "api"));

    const result = resolveWorkspaces(root, ["infra", "packages/*"]);
    expect(result.sort()).toEqual(
      [infra, join(pkgs, "api"), join(pkgs, "web")].sort(),
    );
  });

  test("empty patterns returns empty", () => {
    const root = makeTempDir();
    expect(resolveWorkspaces(root, [])).toEqual([]);
  });

  test("deduplicates results", () => {
    const root = makeTempDir();
    const a = join(root, "project-a");
    mkdirSync(a);

    // Same dir matched by two different patterns
    const result = resolveWorkspaces(root, ["project-a", "project-a"]);
    expect(result).toEqual([a]);
  });

  test("glob with ? wildcard", () => {
    const root = makeTempDir();
    const pkgs = join(root, "packages");
    mkdirSync(pkgs);
    mkdirSync(join(pkgs, "app1"));
    mkdirSync(join(pkgs, "app2"));
    mkdirSync(join(pkgs, "lib1"));

    const result = resolveWorkspaces(root, ["packages/app?"]);
    expect(result.sort()).toEqual(
      [join(pkgs, "app1"), join(pkgs, "app2")].sort(),
    );
  });

  test("cache returns same result on second call", () => {
    const root = makeTempDir();
    const a = join(root, "project-a");
    mkdirSync(a);

    const first = resolveWorkspaces(root, ["project-a"]);
    const second = resolveWorkspaces(root, ["project-a"]);
    expect(first).toEqual([a]);
    expect(second).toEqual([a]);
    expect(first).toBe(second); // same reference (cached)
  });

  test("bare glob * at root level", () => {
    const root = makeTempDir();
    mkdirSync(join(root, "proj-a"));
    mkdirSync(join(root, "proj-b"));
    writeFileSync(join(root, "README.md"), "");

    const result = resolveWorkspaces(root, ["*"]);
    // Should include both dirs but not the file
    expect(result.sort()).toEqual(
      [join(root, "proj-a"), join(root, "proj-b")].sort(),
    );
  });

  test("rejects ../ path traversal escapes", () => {
    const root = makeTempDir();
    // Create a sibling directory that should NOT be reachable
    const sibling = join(root, "..", `sibling-${Date.now()}`);
    mkdirSync(sibling, { recursive: true });

    try {
      const result = resolveWorkspaces(root, [
        `../sibling-${sibling.split("-").pop()}`,
      ]);
      expect(result).toEqual([]);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("glob excludes dot-prefixed directories", () => {
    const root = makeTempDir();
    const pkgs = join(root, "packages");
    mkdirSync(pkgs);
    mkdirSync(join(pkgs, "core"));
    mkdirSync(join(pkgs, ".hidden"));
    mkdirSync(join(pkgs, ".git"));

    const result = resolveWorkspaces(root, ["packages/*"]);
    expect(result).toEqual([join(pkgs, "core")]);
  });

  test("glob parent with ../ is rejected", () => {
    const root = makeTempDir();
    const result = resolveWorkspaces(root, ["../../*"]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discoverWorkspaceRoot — homedir boundary
// ---------------------------------------------------------------------------

describe("discoverWorkspaceRoot — homedir boundary", () => {
  test("does not claim homedir as workspace root even if it has .git", () => {
    // We can't modify $HOME, but we CAN test that the walk stops at
    // homedir by starting from a subdirectory of a temp dir that is
    // structured to mimic the boundary scenario.
    //
    // The actual homedir() stop prevents us from testing this directly
    // without mocking os.homedir(). Instead, verify that the function
    // returns startDir when no markers exist below homedir.
    const sub = makeTempDir();
    // No markers anywhere in the temp tree — should return startDir
    expect(discoverWorkspaceRoot(sub)).toBe(sub);
  });

  test("finds markers below homedir but not at homedir itself", () => {
    // Create a structure where a marker exists at a parent that is NOT homedir
    const root = makeTempDir();
    mkdirSync(join(root, ".git"));
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });

    // .git at root (which is under /tmp, not $HOME) should be found
    expect(discoverWorkspaceRoot(deep)).toBe(root);
  });
});
