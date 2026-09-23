/**
 * Tests for the REST API endpoints in `/api/v1/`.
 *
 * Uses a real gateway server on an ephemeral port with an isolated temp DB.
 * No upstream interceptor needed — these endpoints don't call LLM APIs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import {
  loopbackRequest,
  type LoopbackRequestInit,
} from "./helpers/loopback-request";
import { createTestDatabasePath } from "../../core/test/helpers/test-db-path";

// ---------------------------------------------------------------------------
// Test-scoped server setup
// ---------------------------------------------------------------------------

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;

beforeAll(async () => {
  dbPath = createTestDatabasePath("api");
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

  it.each(["false", "0", "no"])(
    "returns an unexpanded response without an LLM for expand=%s",
    async (expand) => {
      const { projectPath } = await seedProject();
      const path = `/api/v1/recall?q=test&path=${encodeURIComponent(
        projectPath,
      )}&expand=${expand}`;
      const res = await api(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        query: string;
        scope: string;
        projectPath: string;
        result: string;
      };
      expect(body).toEqual(
        expect.objectContaining({
          query: "test",
          scope: "all",
          projectPath,
        }),
      );
      expect(typeof body.result).toBe("string");
    },
  );

  it("returns 400 for an invalid expand value", async () => {
    const { projectPath } = await seedProject();
    const res = await api(
      `/api/v1/recall?q=test&path=${encodeURIComponent(
        projectPath,
      )}&expand=garbage`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "Invalid expand: garbage (expected a boolean)",
    );
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

  it("offers an entry edited after clustering under its current version, and drops a deleted one", async () => {
    const { projectPath, projectId, a, b, unrelated } = await seedDuplicates();
    const { ltm } = await import("@loreai/core");
    const { dedupPreviewGroups } = await import("../src/dedup-api");
    // Clustering saw the original version ids; the entries change before the
    // groups are built (the deduplicators await embeddings in between).
    const clustered = {
      clusters: [
        {
          surviving: { id: a, title: "a" },
          merged: [
            { id: b, title: "b" },
            { id: unrelated, title: "u" },
          ],
        },
      ],
      totalRemoved: 2,
      pairSimilarities: new Map<string, number>(),
      entryTitles: new Map<string, string>(),
    };
    ltm.remove(unrelated);
    const stableGroupId = dedupPreviewGroups(clustered, "project", projectId)[0]
      .group_id;
    ltm.update(a, { content: "edited after clustering" });
    const current = ltm.getByLogical(a);
    if (!current) throw new Error("expected a to still be live");
    expect(current.id).not.toBe(a);

    const groups = dedupPreviewGroups(clustered, "project", projectId);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.candidates.map((c) => c.id).sort()).toEqual(
      [current.id, b].sort(),
    );
    const edited = group.candidates.find((c) => c.logical_id === a);
    expect(edited).toMatchObject({
      id: current.id,
      revision: 2,
      content_excerpt: "edited after clustering",
    });
    expect(group.suggested_keep_id).toBe(current.id);
    // Membership by logical id is unchanged, so the group id is too.
    expect(group.group_id).toBe(stableGroupId);
    expect(ltm.forProject(projectPath, false).map((e) => e.logical_id)).toEqual(
      expect.arrayContaining([a, b]),
    );
  });

  it("suggests the live runner-up when the survivor was deleted after clustering", async () => {
    const { projectId, a, b, unrelated } = await seedDuplicates();
    const { ltm } = await import("@loreai/core");
    const { dedupPreviewGroups } = await import("../src/dedup-api");

    const clustered = {
      clusters: [
        {
          surviving: { id: a, title: "a" },
          // ltm.deduplicate orders `merged` by the same survivor ranking.
          merged: [
            { id: b, title: "b" },
            { id: unrelated, title: "u" },
          ],
        },
      ],
      totalRemoved: 2,
      pairSimilarities: new Map<string, number>(),
      entryTitles: new Map<string, string>(),
    };

    ltm.remove(a);

    const groups = dedupPreviewGroups(clustered, "project", projectId);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.candidates.map((c) => c.id)).toEqual([b, unrelated]);
    expect(group.suggested_keep_id).toBe(b);
    expect(ltm.get(group.suggested_keep_id)).not.toBeNull();
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

// ---------------------------------------------------------------------------
// Cursor pagination, knowledge list options, version history (#1799, #1800)
// ---------------------------------------------------------------------------

type CursorPage<T> = { items: T[]; next_cursor: string | null };
type ApiError = { type: "error"; error: { type: string; message: string } };

/** Seed a fresh project with 7 entries in scrambled order, with equal sort
 *  keys on every sortable column (adversarial-order setup, quality/REVIEW.md). */
async function seedPagedProject(tag: string) {
  const { ensureProject, ltm, db } = await import("@loreai/core");
  const projectPath = `/test/api/paged/${tag}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const projectId = ensureProject(projectPath, `paged-${tag}`);
  const rows = [
    {
      title: "Delta",
      category: "decision",
      created: 1000,
      updated: 5000,
      confidence: 0.9,
    },
    {
      title: "Alpha",
      category: "gotcha",
      created: 3000,
      updated: 5000,
      confidence: 0.9,
    },
    {
      title: "Echo",
      category: "decision",
      created: 3000,
      updated: 7000,
      confidence: 0.5,
    },
    {
      title: "Bravo",
      category: "pattern",
      created: 1000,
      updated: 7000,
      confidence: 0.5,
    },
    {
      title: "Charlie",
      category: "decision",
      created: 2000,
      updated: 6000,
      confidence: 0.9,
    },
    {
      title: "Alpha",
      category: "preference",
      created: 2000,
      updated: 6000,
      confidence: 0.5,
    },
    {
      title: "Foxtrot",
      category: "architecture",
      created: 4000,
      updated: 5000,
      confidence: 0.7,
    },
  ];
  const ids: string[] = [];
  for (const r of rows) {
    const id = ltm.create({
      id: randomUUID(),
      projectPath,
      scope: "project",
      category: r.category,
      title: r.title,
      content: `content about ${r.title.toLowerCase()} widgets`,
      confidence: r.confidence,
    });
    db()
      .query("UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(r.created, r.updated, id);
    db()
      .query(
        "UPDATE knowledge_meta SET confidence = ?, base_confidence = ? WHERE logical_id = ?",
      )
      .run(r.confidence, r.confidence, id);
    ids.push(id);
  }
  return { projectPath, projectId, ids };
}

async function pageThrough<T>(
  path: string,
  extra = "",
  mutate?: (pageNo: number) => Promise<void>,
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const qs = cursor ? `cursor=${encodeURIComponent(cursor)}` : "page=cursor";
    const res = await api(`${path}?${qs}${extra}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as CursorPage<T>;
    expect(Array.isArray(page.items)).toBe(true);
    items.push(...page.items);
    pages++;
    if (!page.next_cursor) break;
    // URL-safe: no characters that need escaping.
    expect(page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    cursor = page.next_cursor;
    await mutate?.(pages);
    expect(pages).toBeLessThan(50);
  }
  return { items, pages };
}

describe("GET /api/v1/projects/:id/knowledge — legacy shape is unchanged", () => {
  it("returns the exact legacy array shape with logical ids and legacy ordering", async () => {
    const { projectId, projectPath } = await seedPagedProject("legacy");
    const { ltm } = await import("@loreai/core");
    const res = await api(`/api/v1/projects/${projectId}/knowledge`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    const expected = ltm
      .forProject(projectPath, false)
      .map((e) => ({ ...e, id: e.logical_id }));
    expect(body).toEqual(JSON.parse(JSON.stringify(expected)));
    // Snapshot of the per-entry key set so a field rename/removal is caught.
    expect(Object.keys(body[0]).sort()).toEqual(
      [
        "approval_status",
        "approved_at",
        "approved_by",
        "category",
        "confidence",
        "content",
        "created_at",
        "created_by",
        "cross_project",
        "id",
        "last_accessed_at",
        "last_reinforced_at",
        "logical_id",
        "metadata",
        "project_id",
        "promoted_at",
        "promotion_status",
        "sensitivity",
        "source_entry_id",
        "source_session",
        "source_user_id",
        "tenant_id",
        "title",
        "updated_at",
        "updated_by",
        "worker_model_id",
        "worker_provider_id",
      ].sort(),
    );
    // `limit` is (still) ignored by the legacy list.
    const limited = await apiJSON<unknown[]>(
      `/api/v1/projects/${projectId}/knowledge?limit=2`,
    );
    expect(limited).toHaveLength(7);
  });
});

describe("GET /api/v1/projects/:id/knowledge — cursor mode", () => {
  it("opts in via ?page=cursor and round-trips ≥3 pages with equal sort keys", async () => {
    const { projectId, ids } = await seedPagedProject("cursor");
    const { items, pages } = await pageThrough<{
      id: string;
      updated_at: number;
    }>(`/api/v1/projects/${projectId}/knowledge`, "&limit=2");
    expect(pages).toBe(4);
    expect(items).toHaveLength(7);
    expect(new Set(items.map((i) => i.id)).size).toBe(7);
    expect(new Set(items.map((i) => i.id))).toEqual(new Set(ids));
    // Deterministic: updated_at DESC, then id DESC within ties.
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1];
      const b = items[i];
      expect(
        a.updated_at > b.updated_at ||
          (a.updated_at === b.updated_at && a.id > b.id),
      ).toBe(true);
    }
    // Same order as an unpaginated cursor-mode request.
    const whole = await apiJSON<CursorPage<{ id: string }>>(
      `/api/v1/projects/${projectId}/knowledge?page=cursor&limit=100`,
    );
    expect(whole.next_cursor).toBeNull();
    expect(whole.items.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it("paging twice with the same cursor yields the same page (cursor is not an offset)", async () => {
    const { projectId } = await seedPagedProject("idempotent");
    const p1 = await apiJSON<CursorPage<{ id: string }>>(
      `/api/v1/projects/${projectId}/knowledge?page=cursor&limit=3`,
    );
    const a = await apiJSON<CursorPage<{ id: string }>>(
      `/api/v1/projects/${projectId}/knowledge?cursor=${p1.next_cursor}&limit=3`,
    );
    const b = await apiJSON<CursorPage<{ id: string }>>(
      `/api/v1/projects/${projectId}/knowledge?cursor=${p1.next_cursor}&limit=3`,
    );
    expect(a).toEqual(b);
    expect(a.items.some((i) => p1.items.some((j) => j.id === i.id))).toBe(
      false,
    );
  });

  it("stays gap/duplicate-free when rows are inserted and deleted between pages", async () => {
    const { projectId, projectPath, ids } = await seedPagedProject("mutate");
    const { ltm, db } = await import("@loreai/core");
    const deleted: string[] = [];
    const inserted: string[] = [];
    const { items } = await pageThrough<{ id: string }>(
      `/api/v1/projects/${projectId}/knowledge`,
      "&limit=2&sort=title_asc",
      async (pageNo) => {
        if (pageNo === 1) {
          // Delete an entry that has NOT been served yet (title "Foxtrot").
          const fox = ids[6];
          ltm.remove(fox);
          deleted.push(fox);
        }
        if (pageNo === 2) {
          // Insert one that sorts after the cursor ("Zulu") and one before ("Aardvark").
          const z = ltm.create({
            id: randomUUID(),
            projectPath,
            scope: "project",
            category: "decision",
            title: "Zulu",
            content: "late insert",
          });
          const a = ltm.create({
            id: randomUUID(),
            projectPath,
            scope: "project",
            category: "decision",
            title: "Aardvark",
            content: "late insert",
          });
          db()
            .query("UPDATE knowledge SET updated_at = 1 WHERE id IN (?, ?)")
            .run(z, a);
          inserted.push(z, a);
        }
      },
    );
    const seen = items.map((i) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(deleted[0]);
    expect(seen).toContain(inserted[0]); // Zulu — after the cursor
    expect(seen).not.toContain(inserted[1]); // Aardvark — before the cursor
    expect(seen).toHaveLength(7); // 7 seeded - 1 deleted + Zulu
  });

  it("rejects a cursor minted for another project with 400", async () => {
    const a = await seedPagedProject("scope-a");
    const b = await seedPagedProject("scope-b");
    const p1 = await apiJSON<CursorPage<unknown>>(
      `/api/v1/projects/${a.projectId}/knowledge?page=cursor&limit=2`,
    );
    expect(p1.next_cursor).not.toBeNull();
    const res = await api(
      `/api/v1/projects/${b.projectId}/knowledge?cursor=${p1.next_cursor}`,
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as ApiError;
    expect(err.type).toBe("error");
    expect(err.error.type).toBe("invalid_cursor");
    // The same cursor is still valid for its own project.
    const ok = await api(
      `/api/v1/projects/${a.projectId}/knowledge?cursor=${p1.next_cursor}`,
    );
    expect(ok.status).toBe(200);
  });

  it("rejects a knowledge cursor used on the sessions list and vice versa", async () => {
    const { projectId } = await seedPagedProject("kind");
    const p1 = await apiJSON<CursorPage<unknown>>(
      `/api/v1/projects/${projectId}/knowledge?page=cursor&limit=2`,
    );
    const res = await api(
      `/api/v1/projects/${projectId}/sessions?cursor=${p1.next_cursor}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.type).toBe("invalid_cursor");
  });

  it("rejects a cursor when the sort differs from the one it was minted under", async () => {
    const { projectId } = await seedPagedProject("sort-mismatch");
    const p1 = await apiJSON<CursorPage<unknown>>(
      `/api/v1/projects/${projectId}/knowledge?page=cursor&limit=2&sort=title_asc`,
    );
    const res = await api(
      `/api/v1/projects/${projectId}/knowledge?cursor=${p1.next_cursor}&sort=created_desc`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.type).toBe("invalid_cursor");
  });

  it("returns 400 for malformed cursors", async () => {
    const { projectId } = await seedPagedProject("malformed");
    const forged = (payload: unknown) =>
      Buffer.from(JSON.stringify(payload)).toString("base64url");
    const bad = [
      "not-base64!!",
      "%%%",
      Buffer.from("not json").toString("base64url"),
      forged("a string"),
      forged({ v: 1 }),
      forged({
        v: 99,
        kind: "knowledge",
        project: projectId,
        sort: "updated_desc",
        key: 1,
        id: "x",
      }),
      forged({
        v: 1,
        kind: "knowledge",
        project: projectId,
        sort: "updated_desc",
        key: "str",
        id: "x",
      }),
      forged({
        v: 1,
        kind: "knowledge",
        project: projectId,
        sort: "updated_desc",
        key: 1,
      }),
      forged({
        v: 1,
        kind: "knowledge",
        project: projectId,
        sort: "bogus",
        key: 1,
        id: "x",
      }),
      "a".repeat(5000),
    ];
    for (const token of bad) {
      const res = await api(
        `/api/v1/projects/${projectId}/knowledge?cursor=${encodeURIComponent(token)}`,
      );
      expect(res.status, `cursor=${token.slice(0, 40)}`).toBe(400);
      const err = (await res.json()) as ApiError;
      expect(err.type).toBe("error");
      expect(err.error.type).toBe("invalid_cursor");
    }
    // A forged but well-formed cursor pointing at a non-existent key still works
    // (it simply positions the keyset) and never errors.
    const ok = await api(
      `/api/v1/projects/${projectId}/knowledge?cursor=${forged({ v: 1, kind: "knowledge", project: projectId, sort: "updated_desc", key: 999_999, id: "zzz" })}`,
    );
    expect(ok.status).toBe(200);
  });

  it("validates limit and page", async () => {
    const { projectId } = await seedPagedProject("limit");
    for (const qs of [
      "page=cursor&limit=0",
      "page=cursor&limit=abc",
      "page=cursor&limit=-1",
    ]) {
      const res = await api(`/api/v1/projects/${projectId}/knowledge?${qs}`);
      expect(res.status, qs).toBe(400);
    }
    // Anything other than `page=cursor` is not an opt-in: legacy array unchanged.
    const notOptIn = await apiJSON<unknown[]>(
      `/api/v1/projects/${projectId}/knowledge?page=2`,
    );
    expect(Array.isArray(notOptIn)).toBe(true);
    expect(notOptIn).toHaveLength(7);
    const capped = await apiJSON<CursorPage<unknown>>(
      `/api/v1/projects/${projectId}/knowledge?page=cursor&limit=99999`,
    );
    expect(capped.items).toHaveLength(7);
    const dflt = await apiJSON<CursorPage<unknown>>(
      `/api/v1/projects/${projectId}/knowledge?page=cursor`,
    );
    expect(dflt.items).toHaveLength(7);
    expect(dflt.next_cursor).toBeNull();
  });

  it("returns 404 for an unknown project in cursor mode", async () => {
    const res = await api(
      "/api/v1/projects/00000000-0000-0000-0000-000000000000/knowledge?page=cursor",
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/projects/:id/knowledge — q/category/scope/sort", () => {
  const sorts = [
    "updated_desc",
    "created_desc",
    "confidence_desc",
    "title_asc",
  ] as const;

  it.each(sorts)(
    "sort=%s is deterministic and identical with and without cursor mode",
    async (sort) => {
      const { projectId } = await seedPagedProject(`sort-${sort}`);
      type E = {
        id: string;
        updated_at: number;
        created_at: number;
        confidence: number;
        title: string;
      };
      const legacy = await apiJSON<E[]>(
        `/api/v1/projects/${projectId}/knowledge?sort=${sort}`,
      );
      expect(Array.isArray(legacy)).toBe(true);
      expect(legacy).toHaveLength(7);
      const { items } = await pageThrough<E>(
        `/api/v1/projects/${projectId}/knowledge`,
        `&limit=3&sort=${sort}`,
      );
      expect(items.map((e) => e.id)).toEqual(legacy.map((e) => e.id));
      const key = (e: E) =>
        sort === "updated_desc"
          ? e.updated_at
          : sort === "created_desc"
            ? e.created_at
            : sort === "confidence_desc"
              ? e.confidence
              : e.title;
      const asc = sort === "title_asc";
      for (let i = 1; i < items.length; i++) {
        const ka = key(items[i - 1]);
        const kb = key(items[i]);
        const ia = items[i - 1].id;
        const ib = items[i].id;
        const ok = asc
          ? ka < kb || (ka === kb && ia < ib)
          : ka > kb || (ka === kb && ia > ib);
        expect(
          ok,
          `${sort} @${i}: ${String(ka)}/${ia} vs ${String(kb)}/${ib}`,
        ).toBe(true);
      }
    },
  );

  it("category filters server-side in both modes", async () => {
    const { projectId } = await seedPagedProject("category");
    const legacy = await apiJSON<Array<{ category: string }>>(
      `/api/v1/projects/${projectId}/knowledge?category=decision`,
    );
    expect(legacy).toHaveLength(3);
    expect(legacy.every((e) => e.category === "decision")).toBe(true);
    const cur = await apiJSON<CursorPage<{ category: string }>>(
      `/api/v1/projects/${projectId}/knowledge?page=cursor&category=gotcha`,
    );
    expect(cur.items).toHaveLength(1);
    expect(cur.items[0].category).toBe("gotcha");
  });

  it("q searches title+content and composes with category/sort", async () => {
    const { projectId } = await seedPagedProject("q");
    const byTitle = await apiJSON<Array<{ title: string }>>(
      `/api/v1/projects/${projectId}/knowledge?q=charlie`,
    );
    expect(byTitle.map((e) => e.title)).toEqual(["Charlie"]);
    const byContent = await apiJSON<Array<{ title: string }>>(
      `/api/v1/projects/${projectId}/knowledge?q=widgets&sort=title_asc`,
    );
    expect(byContent).toHaveLength(7);
    expect(byContent[0].title).toBe("Alpha");
    const composed = await apiJSON<CursorPage<{ title: string }>>(
      `/api/v1/projects/${projectId}/knowledge?page=cursor&q=widgets&category=pattern`,
    );
    expect(composed.items.map((e) => e.title)).toEqual(["Bravo"]);
    const none = await apiJSON<unknown[]>(
      `/api/v1/projects/${projectId}/knowledge?q=nomatchxyz`,
    );
    expect(none).toEqual([]);
  });

  it("scope widens to global/all and defaults to project", async () => {
    const { projectId, projectPath } = await seedPagedProject("scope");
    const { ltm } = await import("@loreai/core");
    const globalId = ltm.create({
      id: randomUUID(),
      scope: "global",
      category: "preference",
      title: "Global pref for scope test",
      content: "global",
    });
    const crossId = ltm.create({
      id: randomUUID(),
      projectPath: `${projectPath}-other`,
      scope: "project",
      crossProject: true,
      category: "pattern",
      title: "Cross project pattern for scope test",
      content: "cross",
    });
    const own = await apiJSON<Array<{ id: string }>>(
      `/api/v1/projects/${projectId}/knowledge?scope=project`,
    );
    expect(own).toHaveLength(7);
    const dflt = await apiJSON<Array<{ id: string }>>(
      `/api/v1/projects/${projectId}/knowledge`,
    );
    expect(dflt).toHaveLength(7);
    const global = await apiJSON<Array<{ id: string }>>(
      `/api/v1/projects/${projectId}/knowledge?scope=global`,
    );
    expect(global.map((e) => e.id)).toContain(globalId);
    expect(global.map((e) => e.id)).not.toContain(crossId);
    const all = await apiJSON<CursorPage<{ id: string }>>(
      `/api/v1/projects/${projectId}/knowledge?page=cursor&scope=all&limit=1000`,
    );
    const allIds = all.items.map((e) => e.id);
    expect(allIds).toContain(globalId);
    expect(allIds).toContain(crossId);
    expect(allIds.length).toBeGreaterThanOrEqual(9);
  });

  it("returns 400 for invalid q/category/scope/sort in both modes", async () => {
    const { projectId } = await seedPagedProject("invalid");
    const bad = [
      "category=bogus",
      "scope=everything",
      "sort=title_desc",
      "sort=updated_asc",
      `q=${"x".repeat(501)}`,
    ];
    for (const qs of bad) {
      for (const mode of ["", "&page=cursor"]) {
        const res = await api(
          `/api/v1/projects/${projectId}/knowledge?${qs}${mode}`,
        );
        expect(res.status, qs + mode).toBe(400);
        const err = (await res.json()) as ApiError;
        expect(err.type).toBe("error");
        expect(err.error.type).toBe("invalid_request");
      }
    }
  });
});

describe("GET /api/v1/projects/:id/sessions — legacy + cursor mode", () => {
  async function seedSessions(tag: string) {
    const { ensureProject, temporal } = await import("@loreai/core");
    const projectPath = `/test/api/sessions/${tag}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const projectId = ensureProject(projectPath, `sessions-${tag}`);
    // Scrambled order; s-b, s-d and s-f tie on last_message_at.
    const plan: Array<[string, number[]]> = [
      ["s-d", [100, 5000]],
      ["s-a", [7000]],
      ["s-f", [5000]],
      ["s-c", [200, 6000]],
      ["s-b", [5000, 50]],
      ["s-e", [4000]],
      ["s-g", [3000, 1000]],
    ];
    for (const [sid, times] of plan) {
      times.forEach((created, i) => {
        const id = `${sid}-m${i}`;
        temporal.store({
          projectPath,
          info: {
            id,
            sessionID: sid,
            role: "user",
            time: { created },
            agent: "build",
            model: { providerID: "anthropic", modelID: "m" },
          },
          parts: [
            {
              id: `part-${id}`,
              sessionID: sid,
              messageID: id,
              type: "text",
              text: `hello from ${id}`,
              time: { start: 0, end: 0 },
            },
          ],
        });
      });
    }
    return { projectId, projectPath };
  }

  it("legacy shape: bare array with unchanged fields and limit semantics", async () => {
    const { projectId, projectPath } = await seedSessions("legacy");
    const { data } = await import("@loreai/core");
    const res = await api(`/api/v1/projects/${projectId}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual(
      JSON.parse(JSON.stringify(data.listSessions(projectPath, 50))),
    );
    expect(Object.keys(body[0]).sort()).toEqual(
      [
        "distillation_count",
        "distilled_count",
        "first_message_at",
        "last_message_at",
        "message_count",
        "session_id",
        "undistilled_count",
      ].sort(),
    );
    const limited = await apiJSON<unknown[]>(
      `/api/v1/projects/${projectId}/sessions?limit=2`,
    );
    expect(limited).toHaveLength(2);
    // Legacy: a bad limit silently falls back to the default (unchanged).
    const badLimit = await api(
      `/api/v1/projects/${projectId}/sessions?limit=abc`,
    );
    expect(badLimit.status).toBe(200);
  });

  it("cursor mode pages deterministically across ≥3 pages with ties, and rejects cross-project cursors", async () => {
    const a = await seedSessions("cursor-a");
    const b = await seedSessions("cursor-b");
    type S = { session_id: string; last_message_at: number };
    const { items, pages } = await pageThrough<S>(
      `/api/v1/projects/${a.projectId}/sessions`,
      "&limit=2",
    );
    expect(pages).toBe(4);
    expect(items.map((s) => s.session_id)).toEqual([
      "s-a",
      "s-c",
      "s-f",
      "s-d",
      "s-b",
      "s-e",
      "s-g",
    ]);
    const p1 = await apiJSON<CursorPage<S>>(
      `/api/v1/projects/${a.projectId}/sessions?page=cursor&limit=2`,
    );
    const res = await api(
      `/api/v1/projects/${b.projectId}/sessions?cursor=${p1.next_cursor}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.type).toBe("invalid_cursor");
    const malformed = await api(
      `/api/v1/projects/${a.projectId}/sessions?cursor=${encodeURIComponent("??")}`,
    );
    expect(malformed.status).toBe(400);
  });

  it("a session that receives a new message mid-pagination is not served twice", async () => {
    const { projectId, projectPath } = await seedSessions("cursor-mutate");
    const { temporal } = await import("@loreai/core");
    const { items } = await pageThrough<{ session_id: string }>(
      `/api/v1/projects/${projectId}/sessions`,
      "&limit=3",
      async (pageNo) => {
        if (pageNo === 1) {
          // s-a was on page 1; bumping it moves it further ahead of the cursor.
          temporal.store({
            projectPath,
            info: {
              id: "s-a-late",
              sessionID: "s-a",
              role: "user",
              time: { created: 99_000 },
              agent: "build",
              model: { providerID: "anthropic", modelID: "m" },
            },
            parts: [
              {
                id: "part-s-a-late",
                sessionID: "s-a",
                messageID: "s-a-late",
                type: "text",
                text: "late",
                time: { start: 0, end: 0 },
              },
            ],
          });
        }
      },
    );
    const ids = items.map((s) => s.session_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(7);
  });
});

describe("GET /api/v1/knowledge/:id/versions", () => {
  type VersionsBody = {
    id: string;
    current_version_id: string;
    versions: Array<{
      version_id: string;
      version: number;
      created_at: number;
      superseded_at: number | null;
      is_current: boolean;
      is_deleted: boolean;
      title: string;
      content: string;
      category: string;
      confidence: number;
      scope: string;
      cross_project: boolean;
      source_refs: Record<string, string | null>;
    }>;
  };

  it("returns ordered history incl. a superseded and a historical deleted version; resolves any version id or prefix", async () => {
    const { ltm } = await import("@loreai/core");
    const projectPath = `/test/api/versions/${Date.now()}`;
    const v1 = ltm.create({
      id: randomUUID(),
      projectPath,
      scope: "project",
      category: "decision",
      title: "Versioned decision",
      content: "first",
      session: "sess-v",
    });
    const v2 = ltm.appendVersion(v1, { content: "second" })!;
    const v3 = ltm.appendVersion(v1, { isDeleted: true })!;
    // While the head is a death cert, the entry is invisible — same as show.
    expect((await api(`/api/v1/knowledge/${v1}/versions`)).status).toBe(404);
    expect((await api(`/api/v1/knowledge/${v1}`)).status).toBe(404);
    const v4 = ltm.appendVersion(v1, { content: "fourth", title: "Retitled" })!;

    for (const lookup of [v1, v2, v3, v4, v1.slice(0, 12)]) {
      const res = await api(`/api/v1/knowledge/${lookup}/versions`);
      expect(res.status, lookup).toBe(200);
      const body = (await res.json()) as VersionsBody;
      expect(body.id).toBe(v1);
      expect(body.current_version_id).toBe(v4);
      expect(body.versions.map((v) => v.version_id)).toEqual([v1, v2, v3, v4]);
      expect(body.versions.map((v) => v.is_current)).toEqual([
        false,
        false,
        false,
        true,
      ]);
      expect(body.versions.map((v) => v.is_deleted)).toEqual([
        false,
        false,
        true,
        false,
      ]);
      expect(body.versions.map((v) => v.content)).toEqual([
        "first",
        "second",
        "second",
        "fourth",
      ]);
      expect(body.versions[3].title).toBe("Retitled");
      expect(body.versions[3].superseded_at).toBeNull();
      for (let i = 0; i < 3; i++) {
        expect(body.versions[i].superseded_at).toBe(
          body.versions[i + 1].created_at,
        );
        expect(body.versions[i].created_at).toBeLessThanOrEqual(
          body.versions[i + 1].created_at,
        );
      }
      expect(body.versions.every((v) => v.scope === "project")).toBe(true);
      expect(body.versions.every((v) => v.category === "decision")).toBe(true);
      expect(body.versions.every((v) => typeof v.confidence === "number")).toBe(
        true,
      );
      expect(
        body.versions.every((v) => v.source_refs.session_id === "sess-v"),
      ).toBe(true);
      expect(Object.keys(body.versions[0]).sort()).toEqual(
        [
          "category",
          "confidence",
          "content",
          "created_at",
          "cross_project",
          "is_current",
          "is_deleted",
          "scope",
          "source_refs",
          "superseded_at",
          "title",
          "version",
          "version_id",
        ].sort(),
      );
    }
    // The show route agrees on the external id and current content.
    const shown = await apiJSON<{ id: string; content: string }>(
      `/api/v1/knowledge/${v2}`,
    );
    expect(shown.id).toBe(v1);
    expect(shown.content).toBe("fourth");
  });

  it("?include_deleted=true returns the history of a tombstoned entry; default stays 404", async () => {
    const { ltm } = await import("@loreai/core");
    const projectPath = `/test/api/versions-deleted/${Date.now()}`;
    const v1 = ltm.create({
      id: randomUUID(),
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Merged away by dedup",
      content: "original",
    });
    const v2 = ltm.appendVersion(v1, { content: "edited" })!;
    const tomb = ltm.appendVersion(v1, { isDeleted: true })!;

    // Default and explicit false: same visibility as GET /knowledge/:id.
    expect((await api(`/api/v1/knowledge/${v1}/versions`)).status).toBe(404);
    expect(
      (await api(`/api/v1/knowledge/${v1}/versions?include_deleted=false`))
        .status,
    ).toBe(404);

    for (const lookup of [v1, v2, tomb]) {
      const res = await api(
        `/api/v1/knowledge/${lookup}/versions?include_deleted=true`,
      );
      expect(res.status, lookup).toBe(200);
      const body = (await res.json()) as VersionsBody;
      expect(body.id).toBe(v1);
      expect(body.current_version_id).toBe(tomb);
      expect(body.versions.map((v) => v.version_id)).toEqual([v1, v2, tomb]);
      expect(body.versions.map((v) => v.is_deleted)).toEqual([
        false,
        false,
        true,
      ]);
      expect(body.versions.map((v) => v.is_current)).toEqual([
        false,
        false,
        true,
      ]);
      expect(body.versions[2].superseded_at).toBeNull();
      expect(body.versions[2].content).toBe("edited");
    }

    // A live entry is unaffected by the flag.
    const live = ltm.create({
      id: randomUUID(),
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Still alive",
      content: "x",
    });
    const liveBody = await apiJSON<VersionsBody>(
      `/api/v1/knowledge/${live}/versions?include_deleted=true`,
    );
    expect(liveBody.current_version_id).toBe(live);
    expect(liveBody.versions).toHaveLength(1);

    // Unknown id is still 404 with the flag.
    const unknown = await api(
      "/api/v1/knowledge/00000000-0000-0000-0000-000000000000/versions?include_deleted=true",
    );
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as ApiError).error.type).toBe("not_found");

    // Invalid flag values → 400 invalid_request.
    for (const raw of ["1", "yes", "TRUE", ""]) {
      const res = await api(
        `/api/v1/knowledge/${v1}/versions?include_deleted=${raw}`,
      );
      expect(res.status, `include_deleted=${raw}`).toBe(400);
      const err = (await res.json()) as ApiError;
      expect(err.type).toBe("error");
      expect(err.error.type).toBe("invalid_request");
    }
  });

  it("returns 404 for unknown ids and does not shadow /knowledge/:id/move", async () => {
    const res = await api(
      "/api/v1/knowledge/00000000-0000-0000-0000-000000000000/versions",
    );
    expect(res.status).toBe(404);
    const err = (await res.json()) as ApiError;
    expect(err.error.type).toBe("not_found");
    const notRoute = await api("/api/v1/knowledge/abc/nope");
    expect(notRoute.status).toBe(404);
  });
});


describe("POST /api/v1/entities/rebuild single flight", () => {
  it(
    "rejects overlapping rebuilds and keeps cancellation tied to the active run",
    async () => {
      const { entityRebuild } = await import("@loreai/core");
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let rebuildSignal: AbortSignal | undefined;
      const rebuild = vi
        .spyOn(entityRebuild, "rebuildEntitiesFromHistory")
        .mockImplementation(async ({ signal }) => {
          rebuildSignal = signal;
          entered?.();
          await blocked;
          return {} as never;
        });

      let first: Promise<Response> | undefined;
      const start = () =>
        api("/api/v1/entities/rebuild", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/test/api/entity-rebuild" }),
        });
      try {
        const firstRequest = start();
        first = firstRequest;
        await started;

        const active = await apiJSON<{ active: boolean }>(
          "/api/v1/entities/rebuild",
        );
        expect(active.active).toBe(true);

        const duplicate = await start();
        expect(duplicate.status).toBe(409);
        expect(
          ((await duplicate.json()) as { error: { type: string } }).error.type,
        ).toBe("conflict");
        expect(rebuild).toHaveBeenCalledTimes(1);

        const cancelled = await apiJSON<{ cancelled: boolean }>(
          "/api/v1/entities/rebuild/cancel",
          { method: "POST" },
        );
        expect(cancelled.cancelled).toBe(true);
        expect(rebuildSignal?.aborted).toBe(true);
        expect(
          (await apiJSON<{ active: boolean }>("/api/v1/entities/rebuild"))
            .active,
        ).toBe(true);

        release?.();
        expect((await firstRequest).status).toBe(200);
        expect(
          (await apiJSON<{ active: boolean }>("/api/v1/entities/rebuild"))
            .active,
        ).toBe(false);
      } finally {
        release?.();
        rebuild.mockRestore();
        if (first) await first.catch(() => {});
      }
    },
  );
});
});
