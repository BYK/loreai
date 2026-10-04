import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import {
  loopbackRequest,
  type LoopbackRequestInit,
} from "./helpers/loopback-request";

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;

beforeAll(async () => {
  dbPath = `/tmp/lore-knowledge-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.LORE_DB_PATH = dbPath;
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

async function seedEntries(
  tag: string,
  count: number,
): Promise<{
  projectId: string;
  projectPath: string;
  ids: string[];
  marker: string;
}> {
  const { ensureProject, ltm } = await import("@loreai/core");
  const marker = `knowledgeapi${tag.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const projectPath = `/test/knowledge-api/${tag}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const projectId = ensureProject(projectPath, `Project ${tag}`);
  const { db } = await import("@loreai/core");
  db().query("UPDATE projects SET name = '' WHERE id = ?").run(projectId);
  const ids: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    ids.push(
      ltm.create({
        id: randomUUID(),
        projectPath,
        scope: "project",
        category: "decision",
        title: `${tag} knowledge row ${i}`,
        content: `${marker} searchable body ${i}`,
      }),
    );
  }
  return { projectId, projectPath, ids, marker };
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

interface KnowledgeItem {
  id: string;
  logical_id: string;
  project_id: string | null;
  project_name: string | null;
  category: string;
  rank?: number | null;
}

interface ListResponse {
  items: KnowledgeItem[];
  next_cursor: string | null;
}

interface SearchResponse {
  query: string;
  mode: "fts" | "like" | "none";
  total: number;
  items: KnowledgeItem[];
}

describe("GET /api/v1/knowledge", () => {
  it("returns externalized project fields and round-trips cursor pages", async () => {
    const seeded = await seedEntries("list-shape", 5);
    const first = await apiJSON<ListResponse>(
      `/api/v1/knowledge?q=${seeded.marker}&sort=title:asc&limit=2&page=ignored`,
    );
    expect(first.items).toHaveLength(2);
    expect(first.items[0].id).toBe(first.items[0].logical_id);
    expect(first.items[0].project_id).toBe(seeded.projectId);
    expect(first.items[0].project_name).toBe(seeded.projectPath);
    expect(first.next_cursor).toBeTruthy();

    const paged = [...first.items];
    let cursor = first.next_cursor;
    while (cursor) {
      const page = await apiJSON<ListResponse>(
        `/api/v1/knowledge?q=${seeded.marker}&sort=title:asc&limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      paged.push(...page.items);
      cursor = page.next_cursor;
    }
    const single = await apiJSON<ListResponse>(
      `/api/v1/knowledge?q=${seeded.marker}&sort=title:asc&limit=100`,
    );
    expect(paged.map((item) => item.id)).toEqual(
      single.items.map((item) => item.id),
    );
    expect(new Set(paged.map((item) => item.id)).size).toBe(paged.length);
    expect(single.next_cursor).toBeNull();
  });

  it("traverses a two-key sort with a typed key array", async () => {
    const seeded = await seedEntries("list-stacked-sort", 5);
    const sort = "updated_at:desc,title:asc";
    const params = `project=${seeded.projectId}&q=${seeded.marker}&sort=${encodeURIComponent(sort)}&limit=2`;
    const paged: KnowledgeItem[] = [];
    let cursor: string | null = null;
    do {
      const page: ListResponse = await apiJSON<ListResponse>(
        `/api/v1/knowledge?${cursor ? `cursor=${encodeURIComponent(cursor)}&` : ""}${params}`,
      );
      if (cursor === null) {
        if (!page.next_cursor) {
          throw new Error("expected a cursor for the first stacked-sort page");
        }
        const payload = JSON.parse(
          Buffer.from(page.next_cursor, "base64url").toString("utf8"),
        ) as { kind: string; sort: string; keys: unknown[] };
        expect(payload.kind).toBe("knowledge_all");
        expect(payload.sort).toBe(sort);
        expect(payload.keys).toHaveLength(2);
        expect(typeof payload.keys[0]).toBe("number");
        expect(typeof payload.keys[1]).toBe("string");
      }
      paged.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    const single = await apiJSON<ListResponse>(
      `/api/v1/knowledge?project=${seeded.projectId}&q=${seeded.marker}&sort=${encodeURIComponent(sort)}&limit=100`,
    );
    expect(paged.map((item) => item.id)).toEqual(
      single.items.map((item) => item.id),
    );
    expect(new Set(paged.map((item) => item.id)).size).toBe(paged.length);
  });

  it("matches the project list for the same exact project filter and options", async () => {
    const seeded = await seedEntries("list-parity", 5);
    const options = `q=${seeded.marker}&category=decision&scope=project&sort=created_at:desc&limit=2`;
    const allProjects = await apiJSON<ListResponse>(
      `/api/v1/knowledge?project=${seeded.projectId}&${options}`,
    );
    const projectList = await apiJSON<ListResponse>(
      `/api/v1/projects/${seeded.projectId}/knowledge?page=cursor&${options}`,
    );
    expect(allProjects.items.map((item) => item.id)).toEqual(
      projectList.items.map((item) => item.id),
    );
    expect(allProjects.next_cursor).toBeTruthy();
  });

  it("rejects malformed, wrong-kind, mismatched, and sort-incompatible cursors", async () => {
    const a = await seedEntries("cursor-a", 3);
    const b = await seedEntries("cursor-b", 2);
    const projectCursor = await apiJSON<ListResponse>(
      `/api/v1/knowledge?project=${a.projectId}&q=${a.marker}&limit=1`,
    );
    const unboundCursor = await apiJSON<ListResponse>(
      `/api/v1/knowledge?q=${a.marker}&limit=1`,
    );
    expect(projectCursor.next_cursor).toBeTruthy();
    expect(unboundCursor.next_cursor).toBeTruthy();
    const bad = [
      "malformed",
      encodeCursor({
        v: 1,
        kind: "knowledge",
        project: a.projectId,
        sort: "updated_at:desc",
        keys: [1],
        id: "entry",
      }),
      encodeCursor({
        v: 1,
        kind: "sessions",
        project: a.projectId,
        last_message_at: 1,
        session_id: "session",
      }),
      encodeCursor({
        v: 1,
        kind: "knowledge_all",
        project: a.projectId,
        sort: "updated_at:desc,title:asc",
        keys: [1, "not-a-number"],
        id: "entry",
      }),
    ];
    for (const cursor of bad) {
      const response = await api(
        `/api/v1/knowledge?project=${a.projectId}&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: "invalid_cursor" },
      });
    }
    for (const path of [
      `/api/v1/knowledge?project=${b.projectId}&cursor=${encodeURIComponent(projectCursor.next_cursor!)}`,
      `/api/v1/knowledge?cursor=${encodeURIComponent(projectCursor.next_cursor!)}`,
      `/api/v1/knowledge?project=${a.projectId}&cursor=${encodeURIComponent(unboundCursor.next_cursor!)}`,
      `/api/v1/knowledge?project=${a.projectId}&sort=title:asc&cursor=${encodeURIComponent(projectCursor.next_cursor!)}`,
    ]) {
      const response = await api(path);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: "invalid_cursor" },
      });
    }
    const sortMismatch = await api(
      `/api/v1/knowledge?project=${a.projectId}&sort=title:asc&cursor=${encodeURIComponent(projectCursor.next_cursor!)}`,
    );
    expect(sortMismatch.status).toBe(400);
    expect(
      ((await sortMismatch.json()) as { error: { message: string } }).error
        .message,
    ).toBe(
      "Cursor was issued for sort=updated_at:desc; request uses sort=title:asc",
    );
  });

  it("rejects knowledge-all keysets with the wrong length or value type", async () => {
    const seeded = await seedEntries("cursor-key-shape", 3);
    const sort = "updated_at:desc,title:asc";
    for (const keys of [[1], [1, 2]]) {
      const cursor = encodeCursor({
        v: 1,
        kind: "knowledge_all",
        project: seeded.projectId,
        sort,
        keys,
        id: "entry",
      });
      const response = await api(
        `/api/v1/knowledge?project=${seeded.projectId}&sort=${encodeURIComponent(sort)}&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { message: string } }).error
          .message,
      ).toBe("Malformed cursor");
    }
  });

  it("validates filters, limits, and exact project IDs", async () => {
    for (const query of [
      "category=bogus",
      "scope=invalid",
      "sort=",
      "sort=updated_at",
      "sort=updated_at:up",
      "sort=updated_at:desc,updated_at:asc",
      "sort=updated_at:desc,created_at:desc,confidence:desc,title:asc",
      "sort=%20updated_at:desc",
      "sort=updated_desc",
      "scope=global",
      "limit=0",
      "limit=abc",
      `q=${"x".repeat(501)}`,
      "project=",
    ]) {
      const response = await api(`/api/v1/knowledge?${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: "invalid_request" },
      });
    }
    const unknown = "project-id-that-does-not-exist";
    const response = await api(`/api/v1/knowledge?project=${unknown}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        type: "not_found",
        message: `Project not found: ${unknown}`,
      },
    });
  });

  it("preserves existing detail and version routes and non-GET behavior", async () => {
    const seeded = await seedEntries("legacy-routes", 1);
    const detail = await api(`/api/v1/knowledge/${seeded.ids[0]}`);
    expect(detail.status).toBe(200);
    const versions = await api(`/api/v1/knowledge/${seeded.ids[0]}/versions`);
    expect(versions.status).toBe(200);

    const post = await api("/api/v1/knowledge", { method: "POST" });
    expect(post.status).toBe(404);
    expect(await post.json()).toEqual({
      type: "error",
      error: {
        type: "not_found",
        message: "No API route for POST /api/v1/knowledge",
      },
    });
  });
});

describe("GET /api/v1/knowledge/search", () => {
  it("returns BM25-ranked top-N results with exact totals and project filtering", async () => {
    const own = await seedEntries("search-own", 105);
    const other = await seedEntries("search-other", 1);
    const { ltm } = await import("@loreai/core");
    ltm.create({
      id: randomUUID(),
      projectPath: other.projectPath,
      scope: "project",
      category: "decision",
      title: "Matching row in another project",
      content: `also contains ${own.marker}`,
    });
    const response = await apiJSON<SearchResponse>(
      `/api/v1/knowledge/search?q=${own.marker}&project=${own.projectId}&limit=999`,
    );
    expect(response.query).toBe(own.marker);
    expect(response.mode).toBe("fts");
    expect(response.total).toBe(105);
    expect(response.items).toHaveLength(100);
    expect(
      response.items.every((item) => item.project_id === own.projectId),
    ).toBe(true);
    expect(response.items.every((item) => typeof item.rank === "number")).toBe(
      true,
    );
    expect(response.items.every((item) => item.id === item.logical_id)).toBe(
      true,
    );
    expect(response.items.map((item) => item.project_id)).not.toContain(
      other.projectId,
    );

    const unfiltered = await apiJSON<SearchResponse>(
      `/api/v1/knowledge/search?q=${own.marker}&limit=200`,
    );
    expect(unfiltered.total).toBeGreaterThan(response.total);
  });

  it("requires a searchable query and rejects pagination or sort parameters", async () => {
    for (const path of [
      "/api/v1/knowledge/search",
      "/api/v1/knowledge/search?q=",
      "/api/v1/knowledge/search?q=%20%20",
      `/api/v1/knowledge/search?q=abc&cursor=${encodeCursor({ v: 1 })}`,
      "/api/v1/knowledge/search?q=abc&sort=title:asc",
      `/api/v1/knowledge/search?q=${"x".repeat(501)}`,
      "/api/v1/knowledge/search?q=abc&category=invalid",
      "/api/v1/knowledge/search?q=abc&scope=invalid",
      "/api/v1/knowledge/search?q=abc&scope=global",
      "/api/v1/knowledge/search?q=abc&project=",
      "/api/v1/knowledge/search?q=abc&limit=0",
    ]) {
      const response = await api(path);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: "invalid_request" },
      });
    }
    const unknown = await api(
      "/api/v1/knowledge/search?q=abc&project=project-id-that-does-not-exist",
    );
    expect(unknown.status).toBe(404);
  });

  it("keeps non-GET requests on the existing API dispatcher", async () => {
    const response = await api("/api/v1/knowledge/search", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "not_found",
        message: "No API route for POST /api/v1/knowledge/search",
      },
    });
  });
});

describe("knowledge route management boundary", () => {
  it("hides both read routes from non-loopback peers", async () => {
    const { startServer } = await import("../src/server");
    const { loadConfig } = await import("../src/config");
    const config = loadConfig();
    config.remoteGateway = false;
    config.hostedMode = false;
    const remote = await startServer(config, {
      peerAddressForRequest: () => "192.0.2.10",
    });
    try {
      const remoteBase = `http://127.0.0.1:${remote.port}`;
      for (const path of [
        "/api/v1/knowledge",
        "/api/v1/knowledge/search?q=hidden",
      ]) {
        const response = await loopbackRequest(`${remoteBase}${path}`);
        expect(response.status, path).toBe(404);
        expect(await response.text()).toBe("");
      }
    } finally {
      await remote.stop();
    }
  });
});
