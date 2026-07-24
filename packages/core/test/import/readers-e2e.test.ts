import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Real-reader e2e: drives the ACTUAL claude-code / codex history readers
// (detect → readChunks) against on-disk fixtures placed under a tmp HOME. This
// is possible because the readers now resolve `homedir()` lazily (per call) —
// so setting $HOME before the call redirects them. Guards against regressions
// in the load-time-const → lazy-fn refactor and in the readers themselves.

import "../../src/import/providers/claude-code";
import "../../src/import/providers/codex";
import { getProvider } from "../../src/import/providers";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

/** claude-code detect mangles the project path into a dir name (slashes → dashes). */
function manglePath(p: string): string {
  return p.replace(/\//g, "-");
}

describe("import readers — real on-disk e2e under a redirected HOME", () => {
  let home: string;
  let project: string;
  const prevHome = process.env.HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lore-reader-home-"));
    project = mkdtempSync(join(tmpdir(), "lore-reader-proj-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  test("claude-code: detect finds a session under ~/.claude/projects/<mangled> and readChunks parses it", () => {
    const provider = getProvider("claude-code");
    if (!provider) throw new Error("claude-code not registered");

    // Place the real fixture at the real detect location for THIS project path.
    const projectsDir = join(home, ".claude", "projects", manglePath(project));
    mkdirSync(projectsDir, { recursive: true });
    const fixture = readFileSync(
      join(FIXTURES, "claude-code-session.jsonl"),
      "utf-8",
    );
    const sessionFile = join(projectsDir, "session-abc.jsonl");
    writeFileSync(sessionFile, fixture);

    // detect() must resolve the redirected HOME (lazy claudeDir()).
    const sessions = provider.detect([project]);
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe(sessionFile);
    expect(sessions[0].messageCount).toBeGreaterThanOrEqual(3);

    // readChunks() over the detected session id.
    const chunks = provider.readChunks(
      project,
      sessions.map((s) => s.id),
    );
    expect(chunks.length).toBeGreaterThan(0);
    const text = chunks.map((c) => c.text).join("\n");
    expect(text).toContain("[user]");
    expect(text).toContain("fix the build error");
  });

  test("claude-code: detect returns nothing when HOME has no matching project dir", () => {
    const provider = getProvider("claude-code");
    if (!provider) throw new Error("claude-code not registered");
    // Fresh HOME, no fixture written → empty.
    expect(provider.detect([project])).toEqual([]);
  });

  test("codex: detect matches a session by cwd under ~/.codex/sessions and readChunks parses it", () => {
    const provider = getProvider("codex");
    if (!provider) throw new Error("codex not registered");

    // Codex matches sessions by the recorded `cwd`, so rewrite the fixture's
    // session_meta cwd to THIS project path, then drop it in the sessions tree.
    const raw = readFileSync(join(FIXTURES, "codex-session.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const meta = JSON.parse(lines[0]) as {
      type: string;
      payload: { meta: { cwd: string } };
    };
    meta.payload.meta.cwd = project;
    lines[0] = JSON.stringify(meta);
    const rewritten = lines.join("\n") + "\n";

    const sessionsDir = join(home, ".codex", "sessions", "2026", "07", "24");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, "rollout-e2e.jsonl");
    writeFileSync(sessionFile, rewritten);

    const sessions = provider.detect([project]);
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe(sessionFile);
    expect(sessions[0].messageCount).toBeGreaterThanOrEqual(3);

    const chunks = provider.readChunks(
      project,
      sessions.map((s) => s.id),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.text).join("\n").length).toBeGreaterThan(0);
  });

  test("codex: a session recorded in a DIFFERENT cwd is not matched", () => {
    const provider = getProvider("codex");
    if (!provider) throw new Error("codex not registered");

    // Fixture cwd left as its original (/test/codex-project), which is not our
    // tmp project → detect must skip it.
    const raw = readFileSync(join(FIXTURES, "codex-session.jsonl"), "utf-8");
    const sessionsDir = join(home, ".codex", "sessions", "2026", "07", "24");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "rollout-other.jsonl"), raw);

    expect(provider.detect([project])).toEqual([]);
  });
});
