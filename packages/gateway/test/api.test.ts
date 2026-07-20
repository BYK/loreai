/**
 * Tests for the REST API endpoints in `/api/v1/`.
 *
 * Uses a real gateway server on an ephemeral port with an isolated temp DB.
 * No upstream interceptor needed — these endpoints don't call LLM APIs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Test-scoped server setup
// ---------------------------------------------------------------------------

let baseURL: string;
let dbPath: string;
let server: { stop: () => void; port: number; hosts: string[] };
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
  server = await startServer(config);
  baseURL = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) server.stop();
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

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseURL}${path}`, init);
}

async function apiJSON<T = unknown>(
  path: string,
  init?: RequestInit,
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
