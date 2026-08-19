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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness, TEST_GATEWAY_AUTH_TOKEN } from "./helpers/harness";
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

function pathlessBodyWithoutTools(
  userMessage: string,
): Record<string, unknown> {
  return {
    ...pathlessBody(userMessage),
    // Keep enough tool definitions for normal-turn classification, but none of
    // the read/shell tools that trigger the synthetic project-resolution probe.
    tools: [
      {
        name: "write_a",
        description: "Write A",
        input_schema: { type: "object" },
      },
      {
        name: "write_b",
        description: "Write B",
        input_schema: { type: "object" },
      },
      {
        name: "write_c",
        description: "Write C",
        input_schema: { type: "object" },
      },
    ],
  };
}

describe("remote gateway: path-less session attribution", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  it("routes two unrelated path-less sessions to DISTINCT buckets (never merged)", async () => {
    // Two unrelated conversations → two fingerprints → two sessions.
    harness = await createHarness({
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
      fixtures: [
        ...makeConversationFixtures([
          { userMessage: "alpha project question one", assistantText: "A1." },
        ]),
        ...makeConversationFixtures([
          {
            userMessage: "beta project totally different",
            assistantText: "B1.",
          },
        ]),
      ],
    });

    // Suppress the harness default x-lore-project header — this test
    // intentionally sends path-less requests.
    const noProject = {
      "x-lore-project": "",
      "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
    };
    const r1 = await harness.chat(
      pathlessBody("alpha project question one"),
      "test-key",
      noProject,
    );
    expect(r1.status).toBe(200);
    await r1.text();
    const r2 = await harness.chat(
      pathlessBody("beta project totally different"),
      "test-key",
      noProject,
    );
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

  it("re-attributes a provisional bucket before publishing a rotated session header", async () => {
    const first = "bucket turn that must follow the session";
    const second = "second stable bucket turn";
    const third = "confident turn after client restart";
    const realPath = "/client/projects/remote-self-heal";
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: first, assistantText: "First response." },
        { userMessage: second, assistantText: "Second response." },
        { userMessage: third, assistantText: "Third response." },
      ]),
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });

    let response = await harness.chat(
      pathlessBodyWithoutTools(first),
      "test-key",
      {
        "x-lore-project": "",
        "x-session-affinity": "remote-affinity-before-restart",
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    response = await harness.chat(
      {
        ...pathlessBodyWithoutTools(second),
        messages: [
          { role: "user", content: first },
          { role: "assistant", content: "First response." },
          { role: "user", content: second },
        ],
      },
      "test-key",
      {
        "x-lore-project": "",
        "x-session-affinity": "remote-affinity-before-restart",
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    // A real client restart may coincide with a gateway restart. This also
    // deterministically drains the old affinity's deferred finalizer before the
    // persisted binding is inspected and the affinity value rotates.
    await harness.restartPipeline();

    const before = harness.queryDB<{
      session_id: string;
      project_path: string;
      project_path_provisional: number;
    }>(
      `SELECT session_id, project_path, project_path_provisional
         FROM session_state
        WHERE header_session_id = 'remote-affinity-before-restart'`,
    );
    expect(before).toHaveLength(1);
    expect(before[0].project_path).toMatch(/^\/__lore_unattributed__\//);
    expect(before[0].project_path_provisional).toBe(1);

    // OpenCode restarted and rotated its affinity value. Fingerprint adoption
    // proves continuity with both leading user messages in the provisional
    // bucket; the successful turn must self-heal that bucket before publishing
    // the new header and confident path.
    response = await harness.chat(
      {
        ...pathlessBodyWithoutTools(third),
        messages: [
          { role: "user", content: first },
          { role: "assistant", content: "First response." },
          { role: "user", content: second },
          { role: "assistant", content: "Second response." },
          { role: "user", content: third },
        ],
      },
      "test-key",
      {
        "x-lore-project": realPath,
        "x-session-affinity": "remote-affinity-after-restart",
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const after = harness.queryDB<{
      session_id: string;
      header_session_id: string;
      project_path: string;
      project_path_provisional: number;
    }>(
      `SELECT session_id, header_session_id, project_path,
              project_path_provisional
         FROM session_state
        WHERE session_id = ?`,
      [before[0].session_id],
    );
    expect(after).toEqual([
      {
        session_id: before[0].session_id,
        header_session_id: "remote-affinity-after-restart",
        project_path: realPath,
        project_path_provisional: 0,
      },
    ]);

    const attribution = harness.queryDB<{
      content: string;
      project_path: string;
    }>(
      `SELECT tm.content, p.path AS project_path
         FROM temporal_messages tm
         JOIN projects p ON p.id = tm.project_id
        WHERE tm.session_id = ?`,
      [before[0].session_id],
    );
    expect(attribution.some((row) => row.content.includes(first))).toBe(true);
    expect(attribution.some((row) => row.content.includes(second))).toBe(true);
    expect(attribution.some((row) => row.content.includes(third))).toBe(true);
    expect(new Set(attribution.map((row) => row.project_path))).toEqual(
      new Set([realPath]),
    );
  });

  it("rolls back project re-attribution when the provisional turn commit fails", async () => {
    const first = "atomic bucket turn";
    const second = "atomic stable bucket turn";
    const third = "atomic confident retry";
    const realPath = "/client/projects/atomic-self-heal";
    const oldRoute = "https://old-anthropic-route.invalid";
    const newRoute = "https://new-anthropic-route.invalid";
    const oldAffinity = "atomic-affinity-before-restart";
    const newAffinity = "atomic-affinity-after-restart";
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: first, assistantText: "First response." },
        { userMessage: second, assistantText: "Second response." },
        { userMessage: third, assistantText: "Failed local commit." },
        { userMessage: third, assistantText: "Failed project merge." },
        { userMessage: third, assistantText: "Successful retry." },
      ]),
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
        callerUpstreamAllowlist: [
          new URL(oldRoute).origin,
          new URL(newRoute).origin,
        ],
      },
    });

    let response = await harness.chat(
      pathlessBodyWithoutTools(first),
      "test-key",
      {
        "x-lore-project": "",
        "x-session-affinity": oldAffinity,
        "x-lore-provider": "anthropic",
        "x-lore-upstream-url": oldRoute,
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    response = await harness.chat(
      {
        ...pathlessBodyWithoutTools(second),
        messages: [
          { role: "user", content: first },
          { role: "assistant", content: "First response." },
          { role: "user", content: second },
        ],
      },
      "test-key",
      {
        "x-lore-project": "",
        "x-session-affinity": oldAffinity,
        "x-lore-provider": "anthropic",
        "x-lore-upstream-url": oldRoute,
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    await harness.restartPipeline();

    const before = harness.queryDB<{
      session_id: string;
      project_path: string;
      last_upstream: string;
    }>(
      `SELECT session_id, project_path, last_upstream
         FROM session_state
        WHERE header_session_id = ?`,
      [oldAffinity],
    );
    expect(before).toHaveLength(1);
    const bucketPath = before[0].project_path;
    expect(bucketPath).toMatch(/^\/__lore_unattributed__\//);
    expect(before[0].last_upstream).toContain(oldRoute);

    const { db } = await import("@loreai/core");
    db().exec(`
      CREATE TEMP TRIGGER fail_atomic_provisional_turn
      BEFORE INSERT ON temporal_messages
       WHEN NEW.content LIKE '%${third}%'
      BEGIN
        SELECT RAISE(ABORT, 'forced provisional temporal failure');
      END;
    `);

    const migratedBody = {
      ...pathlessBodyWithoutTools(third),
      model: "claude-opus-4-1",
      messages: [
        { role: "user", content: first },
        { role: "assistant", content: "First response." },
        { role: "user", content: second },
        { role: "assistant", content: "Second response." },
        { role: "user", content: third },
      ],
    };
    response = await harness.chat(migratedBody, "test-key", {
      "x-lore-project": realPath,
      "x-session-affinity": newAffinity,
      "x-lore-provider": "anthropic",
      "x-lore-upstream-url": newRoute,
      "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
    });
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const afterFailure = harness.queryDB<{
      header_session_id: string;
      project_path: string;
      project_path_provisional: number;
      last_upstream: string;
    }>(
      `SELECT header_session_id, project_path, project_path_provisional,
              last_upstream
         FROM session_state
        WHERE session_id = ?`,
      [before[0].session_id],
    );
    expect(afterFailure).toEqual([
      {
        header_session_id: oldAffinity,
        project_path: bucketPath,
        project_path_provisional: 1,
        last_upstream: before[0].last_upstream,
      },
    ]);
    expect(
      harness.queryDB("SELECT id FROM projects WHERE path = ?", [realPath]),
    ).toHaveLength(0);
    expect(
      harness.queryDB("SELECT id FROM projects WHERE path = ?", [bucketPath]),
    ).toHaveLength(1);
    expect(
      harness.queryDB(
        "SELECT project_id FROM project_path_aliases WHERE path = ?",
        [bucketPath],
      ),
    ).toHaveLength(0);
    const failedAttribution = harness.queryDB<{
      content: string;
      project_path: string;
    }>(
      `SELECT tm.content, p.path AS project_path
         FROM temporal_messages tm
         JOIN projects p ON p.id = tm.project_id
        WHERE tm.session_id = ?`,
      [before[0].session_id],
    );
    expect(failedAttribution.some((row) => row.content.includes(first))).toBe(
      true,
    );
    expect(failedAttribution.some((row) => row.content.includes(second))).toBe(
      true,
    );
    expect(failedAttribution.some((row) => row.content.includes(third))).toBe(
      false,
    );
    expect(new Set(failedAttribution.map((row) => row.project_path))).toEqual(
      new Set([bucketPath]),
    );

    db().exec("DROP TRIGGER fail_atomic_provisional_turn");
    db().exec(`
      CREATE TEMP TRIGGER fail_atomic_project_merge
      BEFORE DELETE ON projects
      WHEN OLD.path LIKE '/__lore_unattributed__/%'
      BEGIN
        SELECT RAISE(ABORT, 'forced provisional project merge failure');
      END;
    `);
    response = await harness.chat(migratedBody, "test-key", {
      "x-lore-project": realPath,
      "x-session-affinity": newAffinity,
      "x-lore-provider": "anthropic",
      "x-lore-upstream-url": newRoute,
      "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
    });
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      harness.queryDB(
        `SELECT header_session_id, project_path, project_path_provisional,
                last_upstream
           FROM session_state
          WHERE session_id = ?`,
        [before[0].session_id],
      ),
    ).toEqual(afterFailure);
    expect(
      harness.queryDB("SELECT id FROM projects WHERE path = ?", [realPath]),
    ).toHaveLength(0);
    expect(
      harness.queryDB("SELECT id FROM projects WHERE path = ?", [bucketPath]),
    ).toHaveLength(1);

    db().exec("DROP TRIGGER fail_atomic_project_merge");
    response = await harness.chat(migratedBody, "test-key", {
      "x-lore-project": realPath,
      "x-session-affinity": newAffinity,
      "x-lore-provider": "anthropic",
      "x-lore-upstream-url": newRoute,
      "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
    });
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const afterRetry = harness.queryDB<{
      header_session_id: string;
      project_path: string;
      project_path_provisional: number;
      last_upstream: string;
    }>(
      `SELECT header_session_id, project_path, project_path_provisional,
              last_upstream
         FROM session_state
        WHERE session_id = ?`,
      [before[0].session_id],
    );
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0]).toMatchObject({
      header_session_id: newAffinity,
      project_path: realPath,
      project_path_provisional: 0,
    });
    expect(afterRetry[0].last_upstream).toContain(newRoute);
    expect(afterRetry[0].last_upstream).toContain("claude-opus-4-1");
    expect(
      harness.queryDB("SELECT id FROM projects WHERE path = ?", [bucketPath]),
    ).toHaveLength(0);
    expect(
      harness.queryDB(
        "SELECT project_id FROM project_path_aliases WHERE path = ?",
        [bucketPath],
      ),
    ).toHaveLength(1);
    const attribution = harness.queryDB<{
      content: string;
      project_path: string;
    }>(
      `SELECT tm.content, p.path AS project_path
         FROM temporal_messages tm
         JOIN projects p ON p.id = tm.project_id
        WHERE tm.session_id = ?`,
      [before[0].session_id],
    );
    expect(attribution.some((row) => row.content.includes(first))).toBe(true);
    expect(attribution.some((row) => row.content.includes(second))).toBe(true);
    expect(attribution.some((row) => row.content.includes(third))).toBe(true);
    expect(new Set(attribution.map((row) => row.project_path))).toEqual(
      new Set([realPath]),
    );
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
      .run(
        bucketId,
        bucketPath,
        "(unattributed) sessionfaiss",
        remote,
        Date.now(),
      );
    ltm.create({
      projectPath: bucketPath,
      scope: "project",
      category: "gotcha",
      title: "bucket-finding-xyz",
      content: "learned in an unattributed bucket",
    });
    // Backfill the remote onto the real project so the two share a remote.
    db()
      .query("UPDATE projects SET git_remote = ? WHERE id = ?")
      .run(remote, realId);
    expect(bucketId).not.toBe(realId);

    // Apply consolidation.
    await commandData(["consolidate"], { yes: true });

    // Bucket project gone; knowledge re-pointed to the real project.
    expect(projectId(bucketPath)).toBe(realId); // path now an alias of real
    const moved = ltm.search({
      query: "bucket-finding-xyz",
      projectPath: realPath,
    });
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
