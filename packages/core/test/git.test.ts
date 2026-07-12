import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getGitRemote, normalizeRemoteUrl } from "../src/git";

describe("normalizeRemoteUrl", () => {
  test("normalizes SSH shorthand", () => {
    expect(normalizeRemoteUrl("git@github.com:user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes HTTPS", () => {
    expect(normalizeRemoteUrl("https://github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes HTTPS without .git suffix", () => {
    expect(normalizeRemoteUrl("https://github.com/user/repo")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes SSH protocol URL", () => {
    expect(normalizeRemoteUrl("ssh://git@github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes git:// protocol", () => {
    expect(normalizeRemoteUrl("git://github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("normalizes HTTP", () => {
    expect(normalizeRemoteUrl("http://github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("strips auth from HTTPS URL", () => {
    expect(
      normalizeRemoteUrl("https://user:token@github.com/user/repo.git"),
    ).toBe("github.com/user/repo");
  });

  test("lowercases host but preserves path case", () => {
    expect(normalizeRemoteUrl("git@GitHub.COM:User/MyRepo.git")).toBe(
      "github.com/User/MyRepo",
    );
  });

  test("strips trailing slashes", () => {
    expect(normalizeRemoteUrl("https://github.com/user/repo/")).toBe(
      "github.com/user/repo",
    );
  });

  test("handles GitLab SSH", () => {
    expect(normalizeRemoteUrl("git@gitlab.com:org/project.git")).toBe(
      "gitlab.com/org/project",
    );
  });

  test("handles self-hosted with port in SSH protocol URL", () => {
    expect(
      normalizeRemoteUrl("ssh://git@git.example.com:2222/org/repo.git"),
    ).toBe("git.example.com:2222/org/repo");
  });

  test("handles nested paths (subgroups)", () => {
    expect(normalizeRemoteUrl("git@gitlab.com:org/subgroup/project.git")).toBe(
      "gitlab.com/org/subgroup/project",
    );
  });

  test("produces same result for SSH and HTTPS of same repo", () => {
    const ssh = normalizeRemoteUrl("git@github.com:user/repo.git");
    const https = normalizeRemoteUrl("https://github.com/user/repo.git");
    expect(ssh).toBe(https);
  });

  test("produces same result for git:// and HTTPS of same repo", () => {
    const git = normalizeRemoteUrl("git://github.com/user/repo.git");
    const https = normalizeRemoteUrl("https://github.com/user/repo.git");
    expect(git).toBe(https);
  });

  test("handles whitespace", () => {
    expect(normalizeRemoteUrl("  https://github.com/user/repo.git  ")).toBe(
      "github.com/user/repo",
    );
  });
});

describe("getGitRemote remote preference", () => {
  // Each repo lives at a unique temp path, so getGitRemote's per-path cache
  // never bleeds between cases.
  function makeRepo(remotes: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "lore-git-remote-"));
    const opts = { cwd: dir, stdio: "pipe" as const };
    execFileSync("git", ["init", "-q"], opts);
    for (const [name, url] of Object.entries(remotes)) {
      execFileSync("git", ["remote", "add", name, url], opts);
    }
    return dir;
  }

  test("prefers origin over upstream when both exist", () => {
    // The core of the fix (#1300 context): keying on the shared upstream would
    // falsely merge two template-derived repos. origin must win.
    const dir = makeRepo({
      origin: "git@github.com:me/my-fork.git",
      upstream: "https://github.com/template/starter.git",
    });
    expect(getGitRemote(dir)).toBe("github.com/me/my-fork");
  });

  test("falls back to upstream when no origin is configured", () => {
    const dir = makeRepo({
      upstream: "https://github.com/template/starter.git",
    });
    expect(getGitRemote(dir)).toBe("github.com/template/starter");
  });

  test("falls back to any remote when neither origin nor upstream exists", () => {
    const dir = makeRepo({
      fork: "git@github.com:someone/repo.git",
    });
    expect(getGitRemote(dir)).toBe("github.com/someone/repo");
  });

  test("two repos sharing an upstream but with distinct origins do NOT converge", () => {
    // Regression guard for the false-merge that collapsed unrelated projects
    // (e.g. nutri / figma-rn-bridge / uk-immigration-analyzer): both were
    // bootstrapped from the same template (shared upstream) but are separate
    // projects with their own origin. They must resolve to DIFFERENT keys.
    const a = makeRepo({
      origin: "git@github.com:me/project-a.git",
      upstream: "https://github.com/template/starter.git",
    });
    const b = makeRepo({
      origin: "git@github.com:me/project-b.git",
      upstream: "https://github.com/template/starter.git",
    });
    const ra = getGitRemote(a);
    const rb = getGitRemote(b);
    expect(ra).toBe("github.com/me/project-a");
    expect(rb).toBe("github.com/me/project-b");
    expect(ra).not.toBe(rb);
  });

  test("returns null when no remotes are configured", () => {
    const dir = makeRepo({});
    expect(getGitRemote(dir)).toBeNull();
  });
});
