import { describe, test, expect } from "vitest";
import {
  inferProjectPath,
  inferProjectPathDetailed,
  getProjectPath,
  extractGitRemoteHeader,
  extractProjectHeader,
  unattributedBucketPath,
  isUnattributedPath,
  UNATTRIBUTED_PREFIX,
  type GatewayConfig,
} from "../src/config";
import {
  resolveSessionProjectPath,
  applySyntheticResolution,
} from "../src/pipeline";
import type { SessionState } from "../src/translate/types";
import type { ResolveProjectResult } from "../src/synthetic-tools";
import {
  ensureProject,
  projectId,
  ltm,
  saveSessionTracking,
  loadSessionTracking,
  enableHostedMode,
  _resetHostedModeForTest,
  type LoadedSessionTracking,
} from "@loreai/core";

// ---------------------------------------------------------------------------
// inferProjectPath
// ---------------------------------------------------------------------------

describe("inferProjectPath", () => {
  test("extracts path from JSON-style cwd field (double-quoted)", () => {
    const system = `Some preamble\n"cwd": "/home/user/my-project"\nMore text`;
    expect(inferProjectPath(system)).toBe("/home/user/my-project");
  });

  test("extracts path from JSON-style cwd field (single-quoted)", () => {
    const system = `Tool def: 'cwd': '/Users/dev/app'`;
    expect(inferProjectPath(system)).toBe("/Users/dev/app");
  });

  test("extracts path from JSON-style cwd field (no quotes)", () => {
    const system = `cwd=/home/user/project`;
    expect(inferProjectPath(system)).toBe("/home/user/project");
  });

  test("extracts path from Working directory line", () => {
    const system = `Working directory: /Users/dev/my-project\nOther stuff`;
    expect(inferProjectPath(system)).toBe("/Users/dev/my-project");
  });

  test("extracts path from working directory (lowercase w)", () => {
    const system = `working directory: /Users/dev/project`;
    expect(inferProjectPath(system)).toBe("/Users/dev/project");
  });

  test("extracts directory from CLAUDE.md path reference", () => {
    const system = `Instructions from: /home/user/my-project/CLAUDE.md`;
    expect(inferProjectPath(system)).toBe("/home/user/my-project");
  });

  test("extracts directory from AGENTS.md path reference", () => {
    const system = `Instructions from: /Users/dev/my-project/AGENTS.md`;
    expect(inferProjectPath(system)).toBe("/Users/dev/my-project");
  });

  test("extracts directory from .lore.md path reference", () => {
    const system = `See /Users/dev/project/.lore.md for details`;
    expect(inferProjectPath(system)).toBe("/Users/dev/project");
  });

  test("falls back to generic /home/ path", () => {
    const system = `Some text mentioning /home/user/generic-project here`;
    expect(inferProjectPath(system)).toBe("/home/user/generic-project");
  });

  test("falls back to generic /Users/ path", () => {
    const system = `Some text mentioning /Users/dev/generic-project here`;
    expect(inferProjectPath(system)).toBe("/Users/dev/generic-project");
  });

  test("returns null for empty system prompt", () => {
    expect(inferProjectPath("")).toBeNull();
  });

  test("returns null for system prompt without paths", () => {
    expect(inferProjectPath("You are a helpful assistant.")).toBeNull();
  });

  test("cwd pattern matches any absolute path (not just /home/ or /Users/)", () => {
    // The cwd pattern is structurally specific enough to accept any absolute path.
    expect(inferProjectPath("cwd: /var/lib/project")).toBe("/var/lib/project");
  });

  test("generic fallback returns null for paths not starting with /home/ or /Users/", () => {
    // Without a structural prefix (cwd, Working directory, CLAUDE.md), only
    // /home/ and /Users/ paths are matched by the generic fallback.
    expect(inferProjectPath("Some text /var/lib/project here")).toBeNull();
  });

  test("prefers cwd field over generic path match", () => {
    // cwd pattern is checked first; if both are present, cwd wins
    const system = `Some /home/other/path here\n"cwd": "/home/user/correct-project"`;
    expect(inferProjectPath(system)).toBe("/home/user/correct-project");
  });

  test("prefers Working directory over CLAUDE.md reference", () => {
    const system = `Working directory: /home/user/project-a\nInstructions from: /home/user/project-b/CLAUDE.md`;
    expect(inferProjectPath(system)).toBe("/home/user/project-a");
  });

  test("strips trailing slashes", () => {
    const system = `Working directory: /home/user/project/`;
    expect(inferProjectPath(system)).toBe("/home/user/project");
  });

  // --- Broadened patterns (any absolute path for structurally-specific patterns) ---

  test("extracts path from cwd field with /root/ prefix", () => {
    expect(inferProjectPath('"cwd": "/root/project"')).toBe("/root/project");
  });

  test("extracts path from cwd field with /var/home/ prefix", () => {
    expect(inferProjectPath('"cwd": "/var/home/user/project"')).toBe(
      "/var/home/user/project",
    );
  });

  test("extracts path from cwd field with /nix/store/ prefix", () => {
    expect(inferProjectPath('"cwd": "/nix/store/abc/project"')).toBe(
      "/nix/store/abc/project",
    );
  });

  test("extracts path from Working directory with /root/ prefix", () => {
    expect(inferProjectPath("Working directory: /root/my-app")).toBe(
      "/root/my-app",
    );
  });

  test("extracts path from Working directory with /data/ prefix (Termux)", () => {
    expect(
      inferProjectPath(
        "Working directory: /data/data/com.termux/files/home/project",
      ),
    ).toBe("/data/data/com.termux/files/home/project");
  });

  test("extracts directory from CLAUDE.md with /root/ path", () => {
    expect(inferProjectPath("Instructions from: /root/project/CLAUDE.md")).toBe(
      "/root/project",
    );
  });

  test("extracts directory from AGENTS.md with /nix/store/ path", () => {
    expect(
      inferProjectPath("Instructions from: /nix/store/abc/project/AGENTS.md"),
    ).toBe("/nix/store/abc/project");
  });

  test("generic fallback still requires /home/ or /Users/", () => {
    // Only the generic pattern should apply — and it should NOT match /root/
    expect(inferProjectPath("Some text /root/project here")).toBeNull();
  });

  test("generic fallback still rejects /var/ paths", () => {
    expect(inferProjectPath("Some text /var/lib/project here")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inferProjectPathDetailed — authoritative vs. weak (misattribution guard)
// ---------------------------------------------------------------------------

describe("inferProjectPathDetailed", () => {
  test("cwd / Working directory / *.md matches are authoritative", () => {
    expect(inferProjectPathDetailed('"cwd": "/home/u/p"')).toEqual({
      path: "/home/u/p",
      authoritative: true,
    });
    expect(inferProjectPathDetailed("Working directory: /home/u/p")).toEqual({
      path: "/home/u/p",
      authoritative: true,
    });
    expect(
      inferProjectPathDetailed("Instructions from: /home/u/p/AGENTS.md"),
    ).toEqual({ path: "/home/u/p", authoritative: true });
  });

  test("generic /home or /Users matches are NON-authoritative", () => {
    expect(inferProjectPathDetailed("see /home/u/generic here")).toEqual({
      path: "/home/u/generic",
      authoritative: false,
    });
    expect(inferProjectPathDetailed("see /Users/u/generic here")).toEqual({
      path: "/Users/u/generic",
      authoritative: false,
    });
  });

  test("returns null when nothing matches", () => {
    expect(inferProjectPathDetailed("no paths here")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getProjectPath
// ---------------------------------------------------------------------------

describe("getProjectPath", () => {
  // Conflict matrix: header vs authoritative system-prompt inference.
  // An authoritative inference (the request's own working directory) is the
  // strongest per-request truth and OVERRIDES a conflicting (stale/static)
  // X-Lore-Project header.

  test("authoritative inference OVERRIDES a conflicting header (the fix)", () => {
    const result = getProjectPath(
      `Working directory: /home/user/inferred-project`,
      { "x-lore-project": "/home/user/stale-header-project" },
    );
    expect(result.path).toBe("/home/user/inferred-project");
    expect(result.source).toBe("inferred");
    expect(result.overrodeHeaderPath).toBe("/home/user/stale-header-project");
  });

  test("header that AGREES with the inference → no override flag", () => {
    const result = getProjectPath(`Working directory: /home/user/proj`, {
      "x-lore-project": "/home/user/proj",
    });
    expect(result.path).toBe("/home/user/proj");
    expect(result.overrodeHeaderPath).toBeUndefined();
  });

  test("header WINS when there is no authoritative inference (plugin case)", () => {
    // Legit OpenCode/Pi clients send a correct header alongside a system
    // prompt with no inferable working directory — the header must still bind.
    const result = getProjectPath("You are a helpful assistant.", {
      "x-lore-project": "/home/user/plugin-project",
    });
    expect(result.path).toBe("/home/user/plugin-project");
    expect(result.source).toBe("header");
    expect(result.overrodeHeaderPath).toBeUndefined();
  });

  test("a WEAK (/home catch-all) inference must NOT override a header", () => {
    // A bare /home path in embedded content is non-authoritative; the header
    // must win and no override is flagged.
    const result = getProjectPath(
      `see /home/user/some-other-thing in the logs`,
      { "x-lore-project": "/home/user/real-project" },
    );
    expect(result.path).toBe("/home/user/real-project");
    expect(result.source).toBe("header");
    expect(result.overrodeHeaderPath).toBeUndefined();
  });

  test("falls back to inferProjectPath when no header", () => {
    const result = getProjectPath(
      `Working directory: /home/user/inferred-project`,
      {},
    );
    expect(result.path).toBe("/home/user/inferred-project");
    expect(result.source).toBe("inferred");
    expect(result.gitRemote).toBeUndefined();
  });

  test("falls back to process.cwd() when neither header nor inference match", () => {
    const result = getProjectPath("You are a helpful assistant.", {});
    expect(result.path).toBe(process.cwd());
    expect(result.source).toBe("cwd");
    expect(result.gitRemote).toBeUndefined();
  });

  test("does NOT confidently infer from a bare /home path in embedded content", () => {
    // A generic /home path with no authoritative marker could be a stray path
    // inside tool output / file contents referencing another project. It must
    // NOT bind as a confident "inferred" source (which would trigger a merge).
    const result = getProjectPath(
      "Tool output: file /home/user/other-project/src/x.ts was read",
      {},
    );
    expect(result.source).toBe("cwd");
    expect(result.path).toBe(process.cwd());
  });

  test("still confidently infers from an authoritative Working directory marker", () => {
    const result = getProjectPath("Working directory: /home/user/real", {});
    expect(result.source).toBe("inferred");
    expect(result.path).toBe("/home/user/real");
  });

  test("ignores empty X-Lore-Project header", () => {
    const result = getProjectPath(`Working directory: /home/user/project`, {
      "x-lore-project": "",
    });
    expect(result.path).toBe("/home/user/project");
    expect(result.source).toBe("inferred");
    expect(result.gitRemote).toBeUndefined();
  });

  test("sanitizes control characters from X-Lore-Project header", () => {
    const result = getProjectPath("", {
      "x-lore-project": "/home/user/project\n",
    });
    expect(result.path).toBe("/home/user/project");
    expect(result.source).toBe("header");
  });

  test("rejects non-absolute X-Lore-Project header, falls through to inference", () => {
    const result = getProjectPath("Working directory: /home/user/project", {
      "x-lore-project": "relative/path",
    });
    expect(result.source).toBe("inferred");
  });

  test("strips trailing slashes from X-Lore-Project header", () => {
    const result = getProjectPath("", {
      "x-lore-project": "/home/user/project///",
    });
    expect(result.path).toBe("/home/user/project");
    expect(result.source).toBe("header");
  });

  test("rejects X-Lore-Project header exceeding 1024 characters", () => {
    const longPath = `/${"a".repeat(1030)}`;
    const result = getProjectPath("Working directory: /home/user/project", {
      "x-lore-project": longPath,
    });
    expect(result.source).toBe("inferred");
  });

  test("extracts and normalizes X-Lore-Git-Remote header (HTTPS)", () => {
    const result = getProjectPath(`Working directory: /home/user/project`, {
      "x-lore-git-remote": "https://github.com/org/repo.git",
    });
    expect(result.path).toBe("/home/user/project");
    expect(result.source).toBe("inferred");
    expect(result.gitRemote).toBe("github.com/org/repo");
  });

  test("extracts and normalizes X-Lore-Git-Remote header (SSH)", () => {
    const result = getProjectPath(`Working directory: /home/user/project`, {
      "x-lore-git-remote": "git@github.com:org/repo.git",
    });
    expect(result.gitRemote).toBe("github.com/org/repo");
  });

  test("extracts and normalizes X-Lore-Git-Remote header (already normalized)", () => {
    const result = getProjectPath(`Working directory: /home/user/project`, {
      "x-lore-git-remote": "github.com/org/repo",
    });
    expect(result.gitRemote).toBe("github.com/org/repo");
  });

  test("trims whitespace from X-Lore-Git-Remote header", () => {
    const result = getProjectPath(`Working directory: /home/user/project`, {
      "x-lore-git-remote": "  https://github.com/org/repo.git  ",
    });
    expect(result.gitRemote).toBe("github.com/org/repo");
  });

  test("ignores empty X-Lore-Git-Remote header", () => {
    const result = getProjectPath(`Working directory: /home/user/project`, {
      "x-lore-git-remote": "",
    });
    expect(result.gitRemote).toBeUndefined();
  });

  test("X-Lore-Git-Remote is independent of project path source", () => {
    // With header path
    const r1 = getProjectPath("", {
      "x-lore-project": "/home/user/project",
      "x-lore-git-remote": "github.com/org/repo",
    });
    expect(r1.source).toBe("header");
    expect(r1.gitRemote).toBe("github.com/org/repo");

    // With cwd fallback
    const r2 = getProjectPath("No paths here", {
      "x-lore-git-remote": "github.com/org/repo",
    });
    expect(r2.source).toBe("cwd");
    expect(r2.gitRemote).toBe("github.com/org/repo");
  });
});

// ---------------------------------------------------------------------------
// extractProjectHeader
// ---------------------------------------------------------------------------

describe("extractProjectHeader", () => {
  test("returns undefined when header is absent", () => {
    expect(extractProjectHeader({})).toBeUndefined();
  });

  test("returns undefined for empty header", () => {
    expect(extractProjectHeader({ "x-lore-project": "" })).toBeUndefined();
  });

  test("returns undefined for whitespace-only header", () => {
    expect(extractProjectHeader({ "x-lore-project": "   " })).toBeUndefined();
  });

  test("extracts valid absolute path", () => {
    expect(
      extractProjectHeader({ "x-lore-project": "/home/user/project" }),
    ).toBe("/home/user/project");
  });

  test("strips control characters", () => {
    expect(
      extractProjectHeader({ "x-lore-project": "/home/user/project\n" }),
    ).toBe("/home/user/project");
  });

  test("strips carriage return and null bytes", () => {
    expect(
      extractProjectHeader({ "x-lore-project": "/home/user/project\r\0" }),
    ).toBe("/home/user/project");
  });

  test("rejects non-absolute path", () => {
    expect(
      extractProjectHeader({ "x-lore-project": "relative/path" }),
    ).toBeUndefined();
  });

  test("strips trailing slashes", () => {
    expect(
      extractProjectHeader({ "x-lore-project": "/home/user/project///" }),
    ).toBe("/home/user/project");
  });

  test("rejects values exceeding 1024 characters", () => {
    const longPath = `/${"a".repeat(1030)}`;
    expect(
      extractProjectHeader({ "x-lore-project": longPath }),
    ).toBeUndefined();
  });

  test("accepts values at exactly 1024 characters", () => {
    const value = `/${"a".repeat(1023)}`; // 1024 total
    expect(extractProjectHeader({ "x-lore-project": value })).toBeDefined();
  });

  test("trims whitespace before validation", () => {
    expect(
      extractProjectHeader({ "x-lore-project": "  /home/user/project  " }),
    ).toBe("/home/user/project");
  });

  test("accepts /root/ paths", () => {
    expect(extractProjectHeader({ "x-lore-project": "/root/project" })).toBe(
      "/root/project",
    );
  });
});

// ---------------------------------------------------------------------------
// extractGitRemoteHeader
// ---------------------------------------------------------------------------

describe("extractGitRemoteHeader", () => {
  test("returns undefined when header is absent", () => {
    expect(extractGitRemoteHeader({})).toBeUndefined();
  });

  test("returns undefined for empty header", () => {
    expect(extractGitRemoteHeader({ "x-lore-git-remote": "" })).toBeUndefined();
  });

  test("returns undefined for whitespace-only header", () => {
    expect(
      extractGitRemoteHeader({ "x-lore-git-remote": "   " }),
    ).toBeUndefined();
  });

  test("normalizes HTTPS URL", () => {
    expect(
      extractGitRemoteHeader({
        "x-lore-git-remote": "https://github.com/org/repo.git",
      }),
    ).toBe("github.com/org/repo");
  });

  test("normalizes SSH URL", () => {
    expect(
      extractGitRemoteHeader({
        "x-lore-git-remote": "git@github.com:org/repo.git",
      }),
    ).toBe("github.com/org/repo");
  });

  test("strips control characters (newline injection)", () => {
    // After stripping \n, the result is "github.com/org/repoX-Api-Key: stolen"
    // which normalizeRemoteUrl lowercases the host part only.
    // The key point: the newline is gone, preventing header injection.
    expect(
      extractGitRemoteHeader({
        "x-lore-git-remote": "github.com/org/repo\nX-Api-Key: stolen",
      }),
    ).toBe("github.com/org/repoX-Api-Key: stolen");
  });

  test("strips carriage return and null bytes", () => {
    expect(
      extractGitRemoteHeader({
        "x-lore-git-remote": "github.com/org/repo\r\0",
      }),
    ).toBe("github.com/org/repo");
  });

  test("rejects values exceeding 512 characters", () => {
    const longValue = `github.com/${"a".repeat(510)}`;
    expect(
      extractGitRemoteHeader({ "x-lore-git-remote": longValue }),
    ).toBeUndefined();
  });

  test("accepts values at exactly 512 characters", () => {
    const value = `github.com/${"a".repeat(501)}`; // 512 total
    expect(
      extractGitRemoteHeader({ "x-lore-git-remote": value }),
    ).toBeDefined();
  });

  test("trims whitespace before length check", () => {
    const value = "  github.com/org/repo  ";
    expect(extractGitRemoteHeader({ "x-lore-git-remote": value })).toBe(
      "github.com/org/repo",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSessionProjectPath
// ---------------------------------------------------------------------------

describe("resolveSessionProjectPath", () => {
  // A confident binding has projectPath set and projectPathProvisional falsy.
  function confidentState(projectPath: string): SessionState {
    return {
      sessionID: "sid-confident",
      projectPath,
      projectPathProvisional: false,
    } as Partial<SessionState> as SessionState;
  }
  // A provisional binding (cwd fallback / bucket) — overridable by a later
  // confident path.
  function provisionalState(
    sessionID: string,
    projectPath: string,
  ): SessionState {
    return {
      sessionID,
      projectPath,
      projectPathProvisional: true,
    } as Partial<SessionState> as SessionState;
  }
  // Freshly-created session (e.g. first turn) seeded by getOrCreateSession with
  // a cwd path → provisional.
  function freshCwdState(sessionID: string, cwdPath: string): SessionState {
    return {
      sessionID,
      projectPath: cwdPath,
      projectPathProvisional: true,
    } as Partial<SessionState> as SessionState;
  }

  const localCfg = { remoteGateway: false } as GatewayConfig;
  const remoteCfg = { remoteGateway: true } as GatewayConfig;

  test("keeps confident binding when a cwd probe arrives (no downgrade)", () => {
    const state = confidentState("/home/user/real-project");
    const result = resolveSessionProjectPath(
      { path: process.cwd(), source: "cwd" },
      state,
      localCfg,
    );
    expect(result).toBe("/home/user/real-project");
    expect(state.projectPath).toBe("/home/user/real-project");
  });

  test("local gateway: provisional cwd keeps the cwd path (legacy behavior)", () => {
    const cwd = process.cwd();
    const state = freshCwdState("sid-local", cwd);
    const result = resolveSessionProjectPath(
      { path: cwd, source: "cwd" },
      state,
      localCfg,
    );
    expect(result).toBe(cwd);
    expect(state.projectPathProvisional).toBe(true);
  });

  test("inferred path binds the session and clears provisional flag", () => {
    const state = provisionalState("sid-inf", "/home/user/old-project");
    const result = resolveSessionProjectPath(
      { path: "/home/user/new-project", source: "inferred" },
      state,
      localCfg,
    );
    expect(result).toBe("/home/user/new-project");
    expect(state.projectPath).toBe("/home/user/new-project");
    expect(state.projectPathProvisional).toBe(false);
  });

  test("header path binds the session and clears provisional flag", () => {
    const state = provisionalState("sid-hdr", "/home/user/old-project");
    const result = resolveSessionProjectPath(
      { path: "/home/user/header-project", source: "header" },
      state,
      localCfg,
    );
    expect(result).toBe("/home/user/header-project");
    expect(state.projectPath).toBe("/home/user/header-project");
    expect(state.projectPathProvisional).toBe(false);
  });

  // --- Fix 3: remote-gateway synthetic bucketing ---

  test("remote gateway: cwd fallback routes to a per-session bucket (never cwd)", () => {
    const state = freshCwdState("abc123session", process.cwd());
    const result = resolveSessionProjectPath(
      { path: process.cwd(), source: "cwd" },
      state,
      remoteCfg,
    );
    expect(result).toBe(unattributedBucketPath("abc123session"));
    expect(isUnattributedPath(result)).toBe(true);
    expect(state.projectPath).toBe(result);
    expect(state.projectPathProvisional).toBe(true);
  });

  test("remote gateway: two path-less sessions get DISTINCT buckets (never merged)", () => {
    const s1 = freshCwdState("sessionAAA", process.cwd());
    const s2 = freshCwdState("sessionBBB", process.cwd());
    const r1 = resolveSessionProjectPath(
      { path: process.cwd(), source: "cwd" },
      s1,
      remoteCfg,
    );
    const r2 = resolveSessionProjectPath(
      { path: process.cwd(), source: "cwd" },
      s2,
      remoteCfg,
    );
    expect(r1).not.toBe(r2);
    expect(r1).toBe(`${UNATTRIBUTED_PREFIX}/sessionAAA`);
    expect(r2).toBe(`${UNATTRIBUTED_PREFIX}/sessionBBB`);
  });

  // --- Fix 3: self-heal — re-point bucket rows to the real project ---

  test("self-heal: confident path re-attributes rows from a provisional bucket", () => {
    const sessionID = "selfhealsession1";
    const bucketPath = unattributedBucketPath(sessionID);
    // Simulate prior provisional attribution: create the bucket project and
    // store a knowledge entry under it.
    const bucketId = ensureProject(bucketPath);
    ltm.create({
      projectPath: bucketPath,
      scope: "project",
      category: "gotcha",
      title: "probe-turn-finding",
      content: "something learned during a path-less probe turn",
    });
    expect(projectId(bucketPath)).toBe(bucketId);

    // Now a confident header turn arrives for the same session.
    const state = provisionalState(sessionID, bucketPath);
    const realPath = "/home/user/real-faiss-project";
    const result = resolveSessionProjectPath(
      { path: realPath, source: "header", gitRemote: "github.com/onur/faiss" },
      state,
      remoteCfg,
    );

    expect(result).toBe(realPath);
    expect(state.projectPathProvisional).toBe(false);

    // The bucket project should have been merged into the real one: bucket row
    // deleted, knowledge re-pointed to the real project.
    const realId = projectId(realPath);
    expect(realId).toBeDefined();
    expect(realId).not.toBe(bucketId);
    const moved = ltm.search({
      query: "probe-turn-finding",
      projectPath: realPath,
    });
    expect(moved.length).toBeGreaterThan(0);
  });

  // --- self-heal merge guard (cross-project contamination prevention) ---

  test("does NOT merge two distinct real projects lacking a shared git remote", () => {
    const sid = `noMerge-${crypto.randomUUID()}`;
    const oldPath = `/test/merge/old-${crypto.randomUUID()}`;
    const newPath = `/test/merge/new-${crypto.randomUUID()}`;
    const oldId = ensureProject(oldPath);
    const secretTitle = `old-project-secret-${crypto.randomUUID()}`;
    ltm.create({
      projectPath: oldPath,
      scope: "project",
      category: "gotcha",
      title: secretTitle,
      content: "knowledge that must not migrate into an unrelated project",
    });

    // A confident turn learns a DIFFERENT real path with no corroborating
    // git remote. The session re-binds, but the old project must NOT be merged
    // (which would permanently alias oldPath → newId and leak its knowledge).
    const state = provisionalState(sid, oldPath);
    const result = resolveSessionProjectPath(
      { path: newPath, source: "header" },
      state,
      localCfg,
    );

    expect(result).toBe(newPath);
    expect(state.projectPathProvisional).toBe(false); // healed (re-bound)
    // Old project row survives, still owns its knowledge.
    expect(projectId(oldPath)).toBe(oldId);
    const stillThere = ltm.forProject(oldPath, false);
    expect(stillThere.some((e) => e.title === secretTitle)).toBe(true);
    // New project is a distinct row — no aliasing happened.
    expect(projectId(newPath)).not.toBe(oldId);
  });

  test("DOES merge when the provisional path is a synthetic unattributed bucket", () => {
    const sid = `bucketMerge-${crypto.randomUUID()}`;
    const bucket = unattributedBucketPath(sid);
    const realPath = `/test/merge/real-${crypto.randomUUID()}`;
    const bucketId = ensureProject(bucket);
    ltm.create({
      projectPath: bucket,
      scope: "project",
      category: "gotcha",
      title: `bucket-finding-${sid}`,
      content: "learned during a path-less probe turn",
    });

    const state = provisionalState(sid, bucket);
    const result = resolveSessionProjectPath(
      { path: realPath, source: "header" },
      state,
      localCfg,
    );

    expect(result).toBe(realPath);
    // Bucket merged into the real project: bucket row gone, knowledge moved.
    const realId = projectId(realPath);
    expect(realId).toBeDefined();
    expect(realId).not.toBe(bucketId);
    const moved = ltm.forProject(realPath, false);
    expect(moved.some((e) => e.title === `bucket-finding-${sid}`)).toBe(true);
  });

  // --- confidentlyWrong: re-bind an already-confident session bound to a
  // stale header path, WITHOUT merging (cross-project safety) ---

  test("re-binds a confident session off a stale header path without merging", () => {
    const sid = `staleHdr-${crypto.randomUUID()}`;
    const stalePath = `/test/stale/magnet-${crypto.randomUUID()}`;
    const realPath = `/test/stale/real-${crypto.randomUUID()}`;
    const staleId = ensureProject(stalePath);
    const secretTitle = `magnet-secret-${crypto.randomUUID()}`;
    ltm.create({
      projectPath: stalePath,
      scope: "project",
      category: "gotcha",
      title: secretTitle,
      content: "knowledge wrongly collected under the stale-header magnet",
    });

    // Session was CONFIDENTLY bound to the stale header path (provisional=0).
    const state = confidentState(stalePath);
    state.sessionID = sid;
    // A new turn: authoritative inference contradicts the stale header.
    const result = resolveSessionProjectPath(
      {
        path: realPath,
        source: "inferred",
        overrodeHeaderPath: stalePath,
      },
      state,
      remoteCfg,
    );

    expect(result).toBe(realPath);
    expect(state.projectPath).toBe(realPath);
    expect(state.projectPathProvisional).toBe(false);
    // No merge: stale project survives and keeps its (mis-collected) knowledge;
    // a human runs `lore data split` to redistribute it later.
    expect(projectId(stalePath)).toBe(staleId);
    expect(projectId(realPath)).not.toBe(staleId);
    const stillThere = ltm.forProject(stalePath, false);
    expect(stillThere.some((e) => e.title === secretTitle)).toBe(true);
  });

  test("confident re-bind DOES merge when a shared git remote corroborates", () => {
    // A supplied git remote is only trusted (persisted) in hosted mode — the
    // central-gateway scenario this fix targets.
    enableHostedMode();
    const sid = `staleHdrMerge-${crypto.randomUUID()}`;
    const stalePath = `/test/stale/magnet2-${crypto.randomUUID()}`;
    const realPath = `/test/stale/real2-${crypto.randomUUID()}`;
    const remote = `github.com/onur/nutri-${crypto.randomUUID()}`;
    ensureProject(stalePath, undefined, remote);
    const title = `merge-finding-${sid}`;
    ltm.create({
      projectPath: stalePath,
      scope: "project",
      category: "gotcha",
      title,
      content: "should migrate because the git remote matches",
    });

    const state = confidentState(stalePath);
    state.sessionID = sid;
    const result = resolveSessionProjectPath(
      {
        path: realPath,
        source: "inferred",
        gitRemote: remote,
        overrodeHeaderPath: stalePath,
      },
      state,
      remoteCfg,
    );

    expect(result).toBe(realPath);
    // With a shared git remote, ensureProject(realPath, remote) resolves to the
    // SAME project as the stale path (same repo) — so the knowledge is unified
    // under the real path (corroborated merge), not stranded.
    const realId = projectId(realPath);
    expect(realId).toBeDefined();
    const moved = ltm.forProject(realPath, false);
    expect(moved.some((e) => e.title === title)).toBe(true);
    _resetHostedModeForTest();
  });

  test("does NOT re-bind a confident session when previous !== overrodeHeaderPath", () => {
    // The guard only fires when the session is bound to the EXACT stale header
    // path. If it's confidently bound to something else, a header/inference
    // change must not silently re-point or merge.
    const sid = `noRebind-${crypto.randomUUID()}`;
    const boundPath = `/test/norebind/bound-${crypto.randomUUID()}`;
    const headerPath = `/test/norebind/header-${crypto.randomUUID()}`;
    const inferredPath = `/test/norebind/inferred-${crypto.randomUUID()}`;
    const boundId = ensureProject(boundPath);
    const title = `bound-secret-${crypto.randomUUID()}`;
    ltm.create({
      projectPath: boundPath,
      scope: "project",
      category: "gotcha",
      title,
      content: "must stay put — guard must not fire",
    });

    const state = confidentState(boundPath);
    state.sessionID = sid;
    // overrodeHeaderPath (headerPath) does NOT equal the current binding.
    resolveSessionProjectPath(
      {
        path: inferredPath,
        source: "inferred",
        overrodeHeaderPath: headerPath,
      },
      state,
      remoteCfg,
    );

    // The session re-binds to the new confident inference (normal behavior),
    // but the OLD bound project must NOT be merged away.
    expect(projectId(boundPath)).toBe(boundId);
    const stillThere = ltm.forProject(boundPath, false);
    expect(stillThere.some((e) => e.title === title)).toBe(true);
  });

  // --- gitRemote caching (unchanged behavior) ---

  test("caches gitRemote from result onto session state", () => {
    const state = provisionalState("sid-gr1", "/home/user/project");
    resolveSessionProjectPath(
      {
        path: "/home/user/project",
        source: "inferred",
        gitRemote: "github.com/org/repo",
      },
      state,
      localCfg,
    );
    expect(state.gitRemote).toBe("github.com/org/repo");
  });

  test("does not overwrite existing session gitRemote", () => {
    const state = provisionalState("sid-gr2", "/home/user/project");
    state.gitRemote = "github.com/org/original-repo";
    resolveSessionProjectPath(
      {
        path: "/home/user/project",
        source: "inferred",
        gitRemote: "github.com/org/new-repo",
      },
      state,
      localCfg,
    );
    expect(state.gitRemote).toBe("github.com/org/original-repo");
  });

  test("does not set gitRemote when result has none", () => {
    const state = provisionalState("sid-gr3", "/home/user/project");
    resolveSessionProjectPath(
      { path: "/home/user/project", source: "inferred" },
      state,
      localCfg,
    );
    expect(state.gitRemote).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// v36: restart continuity — persisted project binding rehydration
//
// getOrCreateSession() is private, so these tests reconstruct the exact seed it
// builds from loadSessionTracking() (see pipeline.ts getOrCreateSession), then
// drive the rehydrated state through the public resolveSessionProjectPath() to
// assert the no-split invariant: a persisted confident binding must NOT be
// downgraded by a path-less first post-restart turn.
// ---------------------------------------------------------------------------

describe("restart continuity: persisted project binding", () => {
  const localCfg = { remoteGateway: false } as GatewayConfig;
  const remoteCfg = { remoteGateway: true } as GatewayConfig;

  // Mirrors the project-binding seed inside getOrCreateSession(): a persisted
  // confident binding wins over the current request path; a persisted
  // provisional binding is resumed; otherwise fall back to the request seed.
  function rehydrateSeed(
    sessionID: string,
    persisted: LoadedSessionTracking | null,
    reqPath: string,
    reqSource: "header" | "inferred" | "cwd",
  ): SessionState {
    const persistedConfident =
      !!persisted?.projectPath && persisted.projectPathProvisional === false;
    const persistedProvisional =
      !!persisted?.projectPath && persisted.projectPathProvisional === true;
    return {
      sessionID,
      projectPath:
        persistedConfident || persistedProvisional
          ? (persisted?.projectPath as string)
          : reqPath,
      projectPathProvisional: persistedConfident
        ? false
        : persistedProvisional
          ? true
          : reqSource === "cwd",
    } as Partial<SessionState> as SessionState;
  }

  test("confident binding survives restart (rehydrated from DB)", () => {
    const sid = `restart-confident-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      projectPath: "/home/me/real",
      projectPathProvisional: false,
    });
    // Simulate restart: in-memory state is gone; rehydrate from DB with a
    // path-less first turn (cwd).
    const persisted = loadSessionTracking(sid);
    const state = rehydrateSeed(sid, persisted, process.cwd(), "cwd");
    expect(state.projectPath).toBe("/home/me/real");
    expect(state.projectPathProvisional).toBe(false);
  });

  test("path-less first post-restart turn does NOT downgrade confident binding", () => {
    const sid = `restart-nodowngrade-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      projectPath: "/home/me/real",
      projectPathProvisional: false,
    });
    const persisted = loadSessionTracking(sid);
    const state = rehydrateSeed(sid, persisted, process.cwd(), "cwd");
    const result = resolveSessionProjectPath(
      { path: process.cwd(), source: "cwd" },
      state,
      localCfg,
    );
    expect(result).toBe("/home/me/real");
    expect(state.projectPath).toBe("/home/me/real");
    expect(state.projectPathProvisional).toBe(false);
  });

  test("provisional binding resumes the same bucket and still self-heals", () => {
    const sid = `restart-provisional-${crypto.randomUUID()}`;
    const bucket = unattributedBucketPath(sid);
    saveSessionTracking(sid, {
      projectPath: bucket,
      projectPathProvisional: true,
    });
    const persisted = loadSessionTracking(sid);
    // Restart, path-less turn: resumes the same provisional bucket.
    const state = rehydrateSeed(sid, persisted, process.cwd(), "cwd");
    expect(state.projectPath).toBe(bucket);
    expect(state.projectPathProvisional).toBe(true);
    // A later confident header turn rebinds to the real project.
    const result = resolveSessionProjectPath(
      { path: "/home/me/real", source: "header" },
      state,
      remoteCfg,
    );
    expect(result).toBe("/home/me/real");
    expect(state.projectPathProvisional).toBe(false);
  });

  test("no persisted binding falls back to legacy request-seed behavior", () => {
    const sid = `restart-legacy-${crypto.randomUUID()}`;
    // No prior save → loadSessionTracking returns null.
    const persisted = loadSessionTracking(sid);
    expect(persisted).toBeNull();
    const cwdState = rehydrateSeed(sid, persisted, process.cwd(), "cwd");
    expect(cwdState.projectPathProvisional).toBe(true);
    const headerState = rehydrateSeed(sid, persisted, "/home/me/x", "header");
    expect(headerState.projectPathProvisional).toBe(false);
    expect(headerState.projectPath).toBe("/home/me/x");
  });

  test("legacy DB row (binding never written) rehydrates as no-binding", () => {
    const sid = `restart-legacyrow-${crypto.randomUUID()}`;
    // Row exists but the v36 binding columns were never written.
    saveSessionTracking(sid, { messageCount: 3 });
    const persisted = loadSessionTracking(sid);
    expect(persisted?.projectPath).toBeNull();
    expect(persisted?.projectPathProvisional).toBe(true);
    // With a NULL persisted path, the seed uses the current request — a cwd
    // turn stays provisional (no false confidence inherited from the default).
    const state = rehydrateSeed(sid, persisted, process.cwd(), "cwd");
    expect(state.projectPath).toBe(process.cwd());
    expect(state.projectPathProvisional).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applySyntheticResolution — #627 Phase 1 gitHead binding
// ---------------------------------------------------------------------------

describe("applySyntheticResolution gitHead binding (#627 Phase 1)", () => {
  function freshState(sessionID: string): SessionState {
    return {
      sessionID,
      projectPath: "/tmp/provisional",
      projectPathProvisional: true,
    } as Partial<SessionState> as SessionState;
  }

  test("binds gitHead onto the session when the probe captured one", () => {
    const state = freshState("sid-githead-1");
    const resolved: ResolveProjectResult = {
      root: "/home/me/proj-a",
      gitHead: "abc1234deadbeef",
    };
    const path = applySyntheticResolution(state, resolved, "/tmp/provisional");
    expect(path).toBe("/home/me/proj-a");
    // The whole point of Phase 1: gitHead survives onto the session so later
    // knowledge creations can stamp metadata.gitHead.
    expect(state.gitHead).toBe("abc1234deadbeef");
  });

  test("leaves gitHead undefined when the probe captured none", () => {
    const state = freshState("sid-githead-2");
    const resolved: ResolveProjectResult = { root: "/home/me/proj-b" };
    applySyntheticResolution(state, resolved, "/tmp/provisional");
    expect(state.gitHead).toBeUndefined();
  });

  test("binds gitHead alongside a git remote (both captured)", () => {
    const state = freshState("sid-githead-3");
    const resolved: ResolveProjectResult = {
      root: "/home/me/proj-c",
      gitRemote: "github.com/org/repo",
      gitHead: "f00dface99",
    };
    applySyntheticResolution(state, resolved, "/tmp/provisional");
    expect(state.gitRemote).toBe("github.com/org/repo");
    expect(state.gitHead).toBe("f00dface99");
  });

  test("no-op result (no root, no remote) never binds gitHead", () => {
    const state = freshState("sid-githead-4");
    // A gitHead with no root/remote is not a confident binding — the early
    // return fires before any gitHead is bound.
    const resolved: ResolveProjectResult = { gitHead: "deadbeef" };
    const path = applySyntheticResolution(state, resolved, "/tmp/provisional");
    expect(path).toBe("/tmp/provisional");
    expect(state.gitHead).toBeUndefined();
  });
});
