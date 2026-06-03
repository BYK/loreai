/**
 * End-to-end (harness) tests for project attribution on a REMOTE gateway.
 *
 * Regression coverage for the "lore-config" bug: a central/remote gateway must
 * never merge unrelated path-less sessions onto its own cwd. With
 * LORE_REMOTE_GATEWAY=1, path-less requests are routed to per-session synthetic
 * "unattributed" buckets so each session stays isolated.
 *
 * These drive the FULL pipeline (handleRequest → handleConversationTurn →
 * resolveSessionProjectPath) via the real HTTP server, complementing the
 * unit-level tests in project-path.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  makeConversationFixtures,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";

// A request body with NO inferable project path in the system prompt, so the
// gateway must fall back (and, on a remote gateway, bucket per-session).
function pathlessBody(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM, // intentionally contains no absolute path
    messages: [{ role: "user", content: userMessage }],
    tools: STANDARD_TOOLS,
  };
}

describe("remote gateway: path-less session attribution", () => {
  let harness: Harness;
  let prevRemote: string | undefined;

  beforeEach(() => {
    prevRemote = process.env.LORE_REMOTE_GATEWAY;
    process.env.LORE_REMOTE_GATEWAY = "1";
  });

  afterEach(async () => {
    await harness?.teardown();
    if (prevRemote === undefined) delete process.env.LORE_REMOTE_GATEWAY;
    else process.env.LORE_REMOTE_GATEWAY = prevRemote;
  });

  it("routes two unrelated path-less sessions to DISTINCT buckets (never merged)", async () => {
    // Two unrelated conversations → two fingerprints → two sessions.
    harness = await createHarness({
      fixtures: [
        ...makeConversationFixtures([
          { userMessage: "alpha project question one", assistantText: "A1." },
        ]),
        ...makeConversationFixtures([
          { userMessage: "beta project totally different", assistantText: "B1." },
        ]),
      ],
    });

    const r1 = await harness.chat(pathlessBody("alpha project question one"));
    expect(r1.status).toBe(200);
    await r1.text();
    const r2 = await harness.chat(pathlessBody("beta project totally different"));
    expect(r2.status).toBe(200);
    await r2.text();

    // Each session must have its own unattributed bucket — never the gateway cwd,
    // and never a single shared project.
    const projects = harness.queryDB<{ path: string; name: string }>(
      "SELECT path, name FROM projects",
    );
    const buckets = projects.filter((p) =>
      p.path.startsWith("/__lore_unattributed__/"),
    );
    expect(buckets.length).toBe(2);
    // Distinct bucket paths.
    expect(new Set(buckets.map((b) => b.path)).size).toBe(2);
    // Provisional naming applied.
    for (const b of buckets) {
      expect(b.name.startsWith("(unattributed)")).toBe(true);
    }
    // The gateway's own cwd must NOT have become a project.
    expect(projects.some((p) => p.path === process.cwd())).toBe(false);
  });
});

describe("lore data consolidate", () => {
  let prevDb: string | undefined;
  const dbPath = `/tmp/lore-consolidate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

  beforeEach(async () => {
    prevDb = process.env.LORE_DB_PATH;
    process.env.LORE_DB_PATH = dbPath;
    const { close } = await import("@loreai/core");
    close();
  });

  afterEach(async () => {
    const { close } = await import("@loreai/core");
    close();
    const { unlinkSync, existsSync } = await import("node:fs");
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
      } catch {
        /* best-effort */
      }
    }
    if (prevDb === undefined) delete process.env.LORE_DB_PATH;
    else process.env.LORE_DB_PATH = prevDb;
  });

  it("merges an unattributed bucket into a real project matched by git remote", async () => {
    const { db, ensureProject, projectId, ltm, UNATTRIBUTED_PROJECT_PREFIX } =
      await import("@loreai/core");
    const { commandData } = await import("../src/cli/data");

    const remote = "github.com/onur/faiss";
    const realPath = "/home/onur/code/faiss";
    const bucketPath = `${UNATTRIBUTED_PROJECT_PREFIX}/sessionfaiss1234`;

    // Real project, created by PATH without a remote initially.
    const realId = ensureProject(realPath);
    // Bucket, created with the git remote on a path-less turn, accumulating
    // knowledge that must survive consolidation. (Created via direct insert so
    // it stays a distinct row even though it shares the remote that will later
    // be backfilled onto the real project — mirroring the lazy-backfill case
    // ensureProject's git-remote dedup can't pre-empt.)
    const bucketId = crypto.randomUUID();
    db()
      .query(
        "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(bucketId, bucketPath, "(unattributed) sessionfaiss", remote, Date.now());
    ltm.create({
      projectPath: bucketPath,
      scope: "project",
      category: "gotcha",
      title: "bucket-finding-xyz",
      content: "learned in an unattributed bucket",
    });
    // Backfill the remote onto the real project so the two share a remote.
    db().query("UPDATE projects SET git_remote = ? WHERE id = ?").run(remote, realId);
    expect(bucketId).not.toBe(realId);

    // Apply consolidation.
    await commandData(["consolidate"], { yes: true });

    // Bucket project gone; knowledge re-pointed to the real project.
    expect(projectId(bucketPath)).toBe(realId); // path now an alias of real
    const moved = ltm.search({ query: "bucket-finding-xyz", projectPath: realPath });
    expect(moved.length).toBeGreaterThan(0);
  });

  it("leaves an unmatched bucket intact (dry run by default)", async () => {
    const { ensureProject, projectId, UNATTRIBUTED_PROJECT_PREFIX } =
      await import("@loreai/core");
    const { commandData } = await import("../src/cli/data");

    const bucketPath = `${UNATTRIBUTED_PROJECT_PREFIX}/sessionorphan999`;
    ensureProject(bucketPath); // no git remote → no match

    // Default (no --yes) is a dry run: nothing changes even if matchable.
    await commandData(["consolidate"], {});
    expect(projectId(bucketPath)).toBeTruthy();
  });
});
