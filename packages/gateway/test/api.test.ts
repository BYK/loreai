/**
 * Tests for the REST API endpoints in `/api/v1/`.
 *
 * Uses a real gateway server on an ephemeral port with an isolated temp DB.
 * No upstream interceptor needed — these endpoints don't call LLM APIs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import {
  loopbackRequest,
  type LoopbackRequestInit,
} from "./helpers/loopback-request";

// ---------------------------------------------------------------------------
// Test-scoped server setup
// ---------------------------------------------------------------------------

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;

beforeAll(async () => {
  dbPath = `/tmp/lore-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.LORE_DB_PATH = dbPath;

  // Port 0 = OS-assigned ephemeral port; server.port returns the actual bound
  // port (used for baseURL below). Avoids EADDRINUSE random-port flakes (#931).
  process.env.LORE_LISTEN_PORT = "0";
  process.env.LORE_DEBUG = "false";

  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  const { resetPipelineState: reset } = await import("../src/pipeline");
  const { close } = await import("@loreai/core");

  closeDB = close;
  resetPipelineState = reset;

  closeDB();
  await resetPipelineState();

  const config = loadConfig();
  config.remoteGateway = false;
  config.hostedMode = false;
  server = await startServer(config);
  baseURL = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.stop();
  if (closeDB) closeDB();
  if (resetPipelineState) await resetPipelineState();

  for (const suffix of ["", "-shm", "-wal"]) {
    const file = `${dbPath}${suffix}`;
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* best-effort */
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function api(path: string, init?: LoopbackRequestInit): Promise<Response> {
  return loopbackRequest(`${baseURL}${path}`, init);
}

async function apiJSON<T = unknown>(
  path: string,
  init?: LoopbackRequestInit,
): Promise<T> {
  const res = await api(path, init);
  return res.json() as Promise<T>;
}

/** Create a project + knowledge entry directly via core APIs for test setup. */
async function seedProject() {
  const { ensureProject, db } = await import("@loreai/core");
  const { ltm } = await import("@loreai/core");

  // Stable path so repeated seedProject() calls reuse ONE project (previously
  // this dedup happened via the shared git remote; ensureProject now refuses a
  // client remote on a non-repo local path, so we anchor on the path instead).
  const projectPath = `/test/api/project`;
  const projectId = ensureProject(projectPath, "test-project");
  // Attach a git remote directly. `ensureProject` deliberately refuses to
  // accept a client-supplied remote for a non-repo path on a local gateway
  // (the "git-remote magnet" guard), so we stamp it via SQL to model a project
  // that already carries a remote — what these resolution tests need.
  db()
    .query("UPDATE projects SET git_remote = ? WHERE id = ?")
    .run("git@github.com:test/repo.git", projectId);

  const knowledgeId = ltm.create({
    projectPath,
    category: "decision",
    title: "Test Decision",
    content: "We decided to use REST for the API",
    session: "test-session",
    scope: "project",
  });

  return { projectPath, projectId, knowledgeId };
}

// ---------------------------------------------------------------------------
// Tests: Data read endpoints
// ---------------------------------------------------------------------------

describe("GET /api/v1/projects", () => {
  it("returns empty array when no projects", async () => {
    const data = await apiJSON<unknown[]>("/api/v1/projects");
    expect(Array.isArray(data)).toBe(true);
  });

  it("returns projects after seeding", async () => {
    const { projectId } = await seedProject();
    const projects =
      await apiJSON<Array<{ id: string; name: string | null }>>(
        "/api/v1/projects",
      );
    expect(projects.length).toBeGreaterThanOrEqual(1);
    const found = projects.find((p) => p.id === projectId);
    expect(found).toBeDefined();
    expect(found?.name).toBe("test-project");
  });
});

describe("GET /api/v1/stats", () => {
  it("returns global stats", async () => {
    const stats = await apiJSON<{
      project_count: number;
      knowledge_count: number;
    }>("/api/v1/stats");
    expect(stats.project_count).toBeGreaterThanOrEqual(0);
    expect(typeof stats.knowledge_count).toBe("number");
  });
});

describe("GET /api/v1/projects/:id/knowledge", () => {
  it("returns knowledge entries for a project", async () => {
    const { projectId } = await seedProject();
    const entries = await apiJSON<Array<{ id: string; title: string }>>(
      `/api/v1/projects/${projectId}/knowledge`,
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].title).toBe("Test Decision");
  });

  it("returns 404 for unknown project", async () => {
    const res = await api(
      "/api/v1/projects/00000000-0000-0000-0000-000000000000/knowledge",
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/projects/:id/sessions", () => {
  it("returns sessions for a project (may be empty)", async () => {
    const { projectId } = await seedProject();
    const sessions = await apiJSON<unknown[]>(
      `/api/v1/projects/${projectId}/sessions`,
    );
    expect(Array.isArray(sessions)).toBe(true);
  });
});

describe("GET /api/v1/projects/:id/distillations", () => {
  it("returns distillations for a project (may be empty)", async () => {
    const { projectId } = await seedProject();
    const dists = await apiJSON<unknown[]>(
      `/api/v1/projects/${projectId}/distillations`,
    );
    expect(Array.isArray(dists)).toBe(true);
  });
});

describe("GET /api/v1/knowledge/:id", () => {
  it("returns a knowledge entry by ID", async () => {
    const { knowledgeId } = await seedProject();
    const entry = await apiJSON<{ id: string; title: string; content: string }>(
      `/api/v1/knowledge/${knowledgeId}`,
    );
    expect(entry.id).toBe(knowledgeId);
    expect(entry.title).toBe("Test Decision");
    expect(entry.content).toBe("We decided to use REST for the API");
  });

  it("returns 404 for unknown knowledge ID", async () => {
    const res = await api(
      "/api/v1/knowledge/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
  });

  it("supports prefix resolution", async () => {
    const { knowledgeId } = await seedProject();
    const prefix = knowledgeId.slice(0, 8);
    const entry = await apiJSON<{ id: string }>(`/api/v1/knowledge/${prefix}`);
    expect(entry.id).toBe(knowledgeId);
  });
});

describe("GET /api/v1/distillations/:id", () => {
  it("returns 404 for unknown distillation ID", async () => {
    const res = await api(
      "/api/v1/distillations/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: Data mutation endpoints
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/knowledge/:id", () => {
  it("deletes a knowledge entry", async () => {
    const { knowledgeId } = await seedProject();

    const res = await api(`/api/v1/knowledge/${knowledgeId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);

    // Verify it's gone
    const check = await api(`/api/v1/knowledge/${knowledgeId}`);
    expect(check.status).toBe(404);
  });

  it("returns 404 for unknown knowledge ID", async () => {
    const res = await api(
      "/api/v1/knowledge/00000000-0000-0000-0000-000000000000",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/projects/:id", () => {
  it("deletes a project and all its data", async () => {
    const { projectId } = await seedProject();

    const res = await api(`/api/v1/projects/${projectId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { knowledge_deleted: number };
    expect(body.knowledge_deleted).toBeGreaterThanOrEqual(1);

    // Verify project is gone
    const check = await api(`/api/v1/projects/${projectId}/knowledge`);
    expect(check.status).toBe(404);
  });
});

describe("POST /api/v1/projects/:id/clear", () => {
  it("clears all data for a project", async () => {
    const { projectId } = await seedProject();

    const res = await api(`/api/v1/projects/${projectId}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { knowledge_deleted: number };
    expect(body.knowledge_deleted).toBeGreaterThanOrEqual(1);
  });

  it("clears only knowledge when flag is set", async () => {
    const { projectId } = await seedProject();

    const res = await api(`/api/v1/projects/${projectId}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ knowledge: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { knowledge_deleted: number };
    expect(body.knowledge_deleted).toBeGreaterThanOrEqual(1);
    // temporal_deleted should not be in response since we only asked for knowledge
    expect(body).not.toHaveProperty("temporal_deleted");
  });
});

describe("POST /api/v1/projects/merge", () => {
  it("succeeds (may be a no-op)", async () => {
    const res = await api("/api/v1/projects/merge", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/reindex", () => {
  it("succeeds (global reindex)", async () => {
    const res = await api("/api/v1/reindex", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      knowledge_embedded: number;
      distillations_embedded: number;
    };
    expect(typeof body.knowledge_embedded).toBe("number");
    expect(typeof body.distillations_embedded).toBe("number");
  });
});

describe("POST /api/v1/projects/:id/clear — null body handling", () => {
  it("handles JSON null body without crashing", async () => {
    const { projectId } = await seedProject();
    const res = await api(`/api/v1/projects/${projectId}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    // Should clear everything (null treated as empty = no flags)
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: Zstd compression
// ---------------------------------------------------------------------------

describe("Zstd request body decompression", () => {
  it("handles zstd-compressed POST body", async () => {
    const { projectId } = await seedProject();
    const body = JSON.stringify({ knowledge: true });
    const compressed = zstdCompressSync(Buffer.from(body));

    const res = await api(`/api/v1/projects/${projectId}/clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "zstd",
      },
      body: new Uint8Array(compressed),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: Project resolution via query params
// ---------------------------------------------------------------------------

describe("Project resolution", () => {
  it("resolves project by git_remote query param", async () => {
    await seedProject();
    // The seedProject uses git_remote "git@github.com:test/repo.git"
    const gitRemote = encodeURIComponent("git@github.com:test/repo.git");
    const data = await apiJSON<{ query: string; result: string }>(
      `/api/v1/recall?q=REST&git_remote=${gitRemote}`,
    );
    expect(data.query).toBe("REST");
    expect(typeof data.result).toBe("string");
  });

  it("resolves project by path query param", async () => {
    const { projectPath } = await seedProject();
    const data = await apiJSON<{ query: string; result: string }>(
      `/api/v1/recall?q=REST&path=${encodeURIComponent(projectPath)}`,
    );
    expect(data.query).toBe("REST");
    expect(typeof data.result).toBe("string");
  });

  it("returns 400 when project cannot be resolved", async () => {
    const res = await api("/api/v1/recall?q=test&git_remote=nonexistent");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests: Error handling
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  it("returns 404 for unknown API routes", async () => {
    const res = await api("/api/v1/nonexistent");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("error");
  });

  it("returns 404 for DELETE on unknown routes", async () => {
    const res = await api("/api/v1/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: Recall endpoint
// ---------------------------------------------------------------------------

describe("GET /api/v1/recall", () => {
  it("returns 400 when query is missing", async () => {
    const res = await api("/api/v1/recall");
    expect(res.status).toBe(400);
  });

  it("returns 400 when project is not identified", async () => {
    const res = await api("/api/v1/recall?q=test");
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid scope", async () => {
    const { projectPath } = await seedProject();
    const pq = `path=${encodeURIComponent(projectPath)}`;
    const res = await api(`/api/v1/recall?q=test&${pq}&scope=invalid`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Invalid scope");
  });

  it("returns results for a valid query", async () => {
    const { projectPath } = await seedProject();
    const pq = `path=${encodeURIComponent(projectPath)}`;
    const data = await apiJSON<{ query: string; result: string }>(
      `/api/v1/recall?q=REST+API&${pq}`,
    );
    expect(data.query).toBe("REST API");
    expect(typeof data.result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Tests: Import endpoints
// ---------------------------------------------------------------------------

describe("GET /api/v1/import/history", () => {
  it("returns 400 when project is not identified", async () => {
    const res = await api("/api/v1/import/history");
    expect(res.status).toBe(400);
  });

  it("returns empty array for project with no imports", async () => {
    const { projectPath } = await seedProject();
    const pq = `path=${encodeURIComponent(projectPath)}`;
    const records = await apiJSON<unknown[]>(`/api/v1/import/history?${pq}`);
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBe(0);
  });
});

describe("POST /api/v1/import/record", () => {
  it("records an import", async () => {
    const { projectPath } = await seedProject();
    const res = await api("/api/v1/import/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: projectPath,
        agent_name: "test-agent",
        source_id: "session-123",
        source_hash: "100:50:1715000000000",
        stats: { created: 2, updated: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recorded: boolean };
    expect(body.recorded).toBe(true);

    // Verify via history endpoint
    const pq = `path=${encodeURIComponent(projectPath)}`;
    const records = await apiJSON<
      Array<{ agent_name: string; source_id: string }>
    >(`/api/v1/import/history?${pq}`);
    expect(records.length).toBe(1);
    expect(records[0].agent_name).toBe("test-agent");
    expect(records[0].source_id).toBe("session-123");
  });

  it("returns 400 for missing fields", async () => {
    const res = await api("/api/v1/import/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/test" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/import/structured", () => {
  const doc = (entries: unknown[]) => ({
    lore_import_version: 1,
    source: "generic",
    entries,
  });

  async function knowledgeCount(path: string): Promise<number> {
    const { ltm } = await import("@loreai/core");
    return ltm.forProject(path, false).length;
  }

  it("writes entries and reports counts", async () => {
    const { projectPath } = await seedProject();
    const before = await knowledgeCount(projectPath);
    const res = await api("/api/v1/import/structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: projectPath,
        doc: doc([
          { title: "Struct import A", content: "body a", category: "pattern" },
        ]),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: number;
      updated: number;
      skipped: number;
    };
    expect(body.created).toBe(1);
    expect(await knowledgeCount(projectPath)).toBe(before + 1);
  });

  it("dry_run reports counts without writing", async () => {
    const { projectPath } = await seedProject();
    const before = await knowledgeCount(projectPath);
    const res = await api("/api/v1/import/structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: projectPath,
        dry_run: true,
        doc: doc([
          {
            title: "Dry struct entry",
            content: "must not persist",
            category: "pattern",
          },
        ]),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number };
    expect(body.created).toBe(1);
    expect(await knowledgeCount(projectPath)).toBe(before);
  });

  it("returns 400 for an invalid document", async () => {
    const { projectPath } = await seedProject();
    const res = await api("/api/v1/import/structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: projectPath,
        doc: { lore_import_version: 1, source: "generic", entries: [{}] },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the project cannot be resolved", async () => {
    const res = await api("/api/v1/import/structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        doc: doc([{ title: "x", content: "y", category: "pattern" }]),
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 in hosted mode", async () => {
    const { projectPath } = await seedProject();
    const core = await import("@loreai/core");
    core.enableHostedMode();
    try {
      const res = await api("/api/v1/import/structured", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: projectPath,
          doc: doc([{ title: "Blocked", content: "no", category: "pattern" }]),
        }),
      });
      expect(res.status).toBe(403);
    } finally {
      core._resetHostedModeForTest();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: dedup preview + apply (#1803 / #1804)
// ---------------------------------------------------------------------------

describe("POST /api/v1/projects/:id/dedup (+ /apply)", () => {
  type Candidate = {
    id: string;
    logical_id: string;
    revision: number;
    title: string;
    content_excerpt: string;
    score: number;
    reasons: string[];
  };
  type Group = {
    group_id: string;
    scope: "project" | "global";
    project_id: string | null;
    candidates: Candidate[];
    suggested_keep_id: string;
  };
  type Preview = {
    dry_run: true;
    groups: Group[];
    project: { clusters: unknown[]; totalRemoved: number };
    global: { clusters: unknown[]; totalRemoved: number };
  };
  type Receipt = {
    operationId: string;
    applied: Array<{ keepId: string; merged: Array<{ id: string }> }>;
    refused: Array<{
      groupIndex: number;
      keepId: string;
      error: { code: string; details: Array<{ id: string; reason: string }> };
    }>;
    replayed: boolean;
  };
  type ApiError = {
    type: "error";
    error: { type: string; message: string };
  };

  let seq = 0;
  /** Fresh project per test so clusters from one test never leak into another. */
  async function seedDuplicates() {
    const { ensureProject, ltm } = await import("@loreai/core");
    const projectPath = `/test/api/dedup-${Date.now()}-${seq++}`;
    const projectId = ensureProject(projectPath, "dedup-project");
    const title = "Cache warming time slot buckets hardcoded values";
    const create = (t: string, content: string) =>
      ltm.create({
        // explicit id bypasses the create-time dedup guard
        id: crypto.randomUUID(),
        projectPath,
        category: "gotcha",
        title: t,
        content,
        session: "test-session",
        scope: "project",
      });
    const a = create(title, "Buckets are hardcoded to 15 minutes.");
    const b = create(`${title} duplicate`, "x".repeat(600));
    const unrelated = create(
      "React useState async pitfall",
      "setState is async",
    );
    return { projectPath, projectId, a, b, unrelated };
  }

  function groupFor(preview: Preview, projectId: string): Group {
    const group = preview.groups.find((g) => g.project_id === projectId);
    if (!group) throw new Error("expected a project group in the preview");
    return group;
  }

  function decisionFrom(group: Group) {
    const keepId = group.suggested_keep_id;
    const mergeIds = group.candidates
      .map((c) => c.id)
      .filter((id) => id !== keepId);
    const expectedRevisions = Object.fromEntries(
      group.candidates.map((c) => [c.id, c.revision]),
    );
    return { keepId, mergeIds, expectedRevisions };
  }

  function post(path: string, body: unknown): Promise<Response> {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("returns a typed dry-run preview alongside the legacy payload", async () => {
    const { projectId, a, b, unrelated } = await seedDuplicates();
    const res = await post(`/api/v1/projects/${projectId}/dedup`, {});
    expect(res.status).toBe(200);
    const preview = (await res.json()) as Preview;

    expect(preview.dry_run).toBe(true);
    // Legacy shape kept for `lore data dedup --remote`.
    expect(preview.project.clusters).toHaveLength(1);
    expect(preview.project.totalRemoved).toBe(1);
    expect(preview.global).toMatchObject({
      clusters: expect.any(Array),
      totalRemoved: expect.any(Number),
    });

    const group = groupFor(preview, projectId);
    expect(group.group_id).toMatch(/^project:[0-9a-f]{16}$/);
    expect(group.scope).toBe("project");
    expect(group.candidates.map((c) => c.id).sort()).toEqual([a, b].sort());
    expect(group.candidates.map((c) => c.id)).toContain(
      group.suggested_keep_id,
    );
    for (const c of group.candidates) {
      expect(c.revision).toBe(1);
      expect(c.logical_id).toBe(c.id);
      expect(c.title).toContain("Cache warming");
      expect(c.content_excerpt.length).toBeLessThanOrEqual(200);
      expect(c.score).toBeGreaterThanOrEqual(0.7);
      expect(c.reasons).toEqual(["title_overlap"]);
    }
    const long = group.candidates.find((c) => c.id === b);
    expect(long?.content_excerpt.endsWith("…")).toBe(true);
    expect(
      preview.groups.flatMap((g) => g.candidates.map((c) => c.id)),
    ).not.toContain(unrelated);
  });

  it("preview never writes", async () => {
    const { projectPath, projectId } = await seedDuplicates();
    const { ltm } = await import("@loreai/core");
    const before = ltm.forProject(projectPath, false).length;
    await post(`/api/v1/projects/${projectId}/dedup`, {});
    expect(ltm.forProject(projectPath, false).length).toBe(before);
  });

  it("applies a reviewed group and replays the receipt for the same operationId", async () => {
    const { projectPath, projectId } = await seedDuplicates();
    const { ltm } = await import("@loreai/core");
    const preview = (await (
      await post(`/api/v1/projects/${projectId}/dedup`, {})
    ).json()) as Preview;
    const decision = decisionFrom(groupFor(preview, projectId));
    const body = {
      operationId: `op-${crypto.randomUUID()}`,
      reviewedAt: Date.now(),
      actor: "api-test",
      decisions: [decision],
    };

    const res = await post(`/api/v1/projects/${projectId}/dedup/apply`, body);
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as Receipt;
    expect(receipt.operationId).toBe(body.operationId);
    expect(receipt.replayed).toBe(false);
    expect(receipt.refused).toEqual([]);
    expect(receipt.applied).toHaveLength(1);
    expect(receipt.applied[0].keepId).toBe(decision.keepId);
    expect(receipt.applied[0].merged.map((m) => m.id)).toEqual(
      decision.mergeIds,
    );

    const live = ltm.forProject(projectPath, false).map((e) => e.logical_id);
    expect(live).toContain(decision.keepId);
    for (const id of decision.mergeIds) {
      expect(live).not.toContain(id);
      // Recoverable: the merged entry keeps its history behind a tombstone.
      const history = ltm.versionHistory(id);
      expect(history.at(-1)?.is_deleted).toBe(1);
    }

    const replay = await post(
      `/api/v1/projects/${projectId}/dedup/apply`,
      body,
    );
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as Receipt;
    expect(replayed.replayed).toBe(true);
    expect(replayed.applied).toEqual(receipt.applied);

    const conflict = await post(`/api/v1/projects/${projectId}/dedup/apply`, {
      ...body,
      actor: "someone-else",
    });
    expect(conflict.status).toBe(409);
    const err = (await conflict.json()) as ApiError;
    expect(err.error.type).toBe("operation_conflict");
  });

  it("reports stale_revision in the receipt (200) when an entry changed after the preview", async () => {
    const { projectPath, projectId } = await seedDuplicates();
    const { ltm } = await import("@loreai/core");
    const preview = (await (
      await post(`/api/v1/projects/${projectId}/dedup`, {})
    ).json()) as Preview;
    const decision = decisionFrom(groupFor(preview, projectId));

    // Adversarial order: the edit lands between preview and apply.
    ltm.update(decision.mergeIds[0], { content: "edited after the preview" });
    const before = ltm.forProject(projectPath, false).length;

    const res = await post(`/api/v1/projects/${projectId}/dedup/apply`, {
      operationId: `op-${crypto.randomUUID()}`,
      reviewedAt: Date.now(),
      actor: "api-test",
      decisions: [decision],
    });
    // The operation completed (nothing applied); refusal is data, not an error.
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as Receipt;
    expect(receipt.applied).toEqual([]);
    expect(receipt.refused).toHaveLength(1);
    expect(receipt.refused[0].error.code).toBe("stale_revision");
    expect(receipt.refused[0].error.details).toEqual([
      expect.objectContaining({
        id: decision.mergeIds[0],
        reason: "stale_revision",
      }),
    ]);
    expect(ltm.forProject(projectPath, false).length).toBe(before);
  });

  it("returns 200 with a mixed receipt when one group applied and another was refused", async () => {
    const { projectPath, projectId, a, b } = await seedDuplicates();
    const { ltm } = await import("@loreai/core");
    const other = ltm.create({
      id: crypto.randomUUID(),
      projectPath,
      category: "gotcha",
      title: "Retry backoff jitter window",
      content: "Jitter is 10%.",
      session: "test-session",
      scope: "project",
    });
    const otherDupe = ltm.create({
      id: crypto.randomUUID(),
      projectPath,
      category: "gotcha",
      title: "Retry backoff jitter window duplicate",
      content: "Jitter is ten percent.",
      session: "test-session",
      scope: "project",
    });
    const revisions = (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, 1]));
    // Group 0 is fresh; group 1 goes stale between preview and apply.
    ltm.update(b, { content: "edited after the preview" });

    const res = await post(`/api/v1/projects/${projectId}/dedup/apply`, {
      operationId: `op-${crypto.randomUUID()}`,
      reviewedAt: Date.now(),
      actor: "api-test",
      decisions: [
        {
          keepId: other,
          mergeIds: [otherDupe],
          expectedRevisions: revisions([other, otherDupe]),
        },
        { keepId: a, mergeIds: [b], expectedRevisions: revisions([a, b]) },
      ],
    });
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as Receipt;
    expect(receipt.applied.map((g) => g.keepId)).toEqual([other]);
    expect(receipt.refused.map((g) => [g.groupIndex, g.error.code])).toEqual([
      [1, "stale_revision"],
    ]);
    const live = ltm.forProject(projectPath, false).map((e) => e.logical_id);
    expect(live).not.toContain(otherDupe);
    expect(live).toContain(a);
    expect(live).toContain(b);
  });

  it.each([
    ["not json", "{not json"],
    ["array body", "[]"],
    ["missing decisions", { operationId: "op-1", reviewedAt: 1, actor: "a" }],
    [
      "bad expectedRevisions",
      {
        operationId: "op-1",
        reviewedAt: 1,
        actor: "a",
        decisions: [{ keepId: "k", mergeIds: ["m"], expectedRevisions: {} }],
      },
    ],
    [
      "projectId for another project",
      {
        projectId: "some-other-project",
        operationId: "op-1",
        reviewedAt: 1,
        actor: "a",
        decisions: [{ keepId: "k", mergeIds: ["m"], expectedRevisions: {} }],
      },
    ],
  ])("returns 400 for a malformed body (%s)", async (_label, body) => {
    const { projectId } = await seedDuplicates();
    const res = await post(`/api/v1/projects/${projectId}/dedup/apply`, body);
    expect(res.status).toBe(400);
    const err = (await res.json()) as ApiError;
    expect(err.error.type).toBe("invalid_request");
  });

  it("returns 404 for an unknown project", async () => {
    const res = await post(`/api/v1/projects/nope/dedup/apply`, {
      operationId: "op-1",
      reviewedAt: 1,
      actor: "a",
      decisions: [{ keepId: "k", mergeIds: ["m"], expectedRevisions: {} }],
    });
    expect(res.status).toBe(404);
    expect((await post(`/api/v1/projects/nope/dedup`, {})).status).toBe(404);
  });

  it("returns 403 in hosted mode without touching data", async () => {
    const { projectPath, projectId } = await seedDuplicates();
    const core = await import("@loreai/core");
    const preview = (await (
      await post(`/api/v1/projects/${projectId}/dedup`, {})
    ).json()) as Preview;
    const decision = decisionFrom(groupFor(preview, projectId));
    const before = core.ltm.forProject(projectPath, false).length;
    core.enableHostedMode();
    try {
      const res = await post(`/api/v1/projects/${projectId}/dedup/apply`, {
        operationId: `op-${crypto.randomUUID()}`,
        reviewedAt: Date.now(),
        actor: "api-test",
        decisions: [decision],
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as ApiError).error.type).toBe("forbidden");
    } finally {
      core._resetHostedModeForTest();
    }
    expect(core.ltm.forProject(projectPath, false).length).toBe(before);
  });
});
