import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  dbPath = `/tmp/lore-threads-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

function send(method: string, path: string, body?: unknown) {
  return api(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seed() {
  const { ensureProject, db, sourceAnchors, threadLinks } =
    await import("@loreai/core");
  const n = Math.random().toString(36).slice(2);
  const projectId = ensureProject(`/test/threads-api/${n}`);
  const session = `s-${n}`;
  const mid = `m-${n}`;
  const content = "hello world";
  db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)",
    )
    .run(mid, projectId, session, content, Date.now());
  const anchor = {
    blockId: `m.${mid}`,
    partIndex: 0,
    start: 0,
    end: 4,
    contentHash: sourceAnchors.messagePartHashes(content)[0],
  };
  const link = threadLinks.createThreadLink({
    projectId,
    source: { kind: "session", id: session },
    anchors: [anchor],
    quote: "hell",
    agent: "claude-code",
    forkMode: "seeded",
  });
  return { projectId, session, anchor, link };
}

describe("thread routes", () => {
  it("lists, reads, closes and deletes a thread with revisions", async () => {
    const { projectId, session, link } = await seed();
    const base = `/api/v1/projects/${projectId}/threads`;
    const list = await apiJSON<{ threads: Array<{ id: string }> }>(
      `${base}?source_kind=session&source_id=${session}`,
    );
    expect(list.threads.map((t) => t.id)).toEqual([link.id]);
    const one = await apiJSON<{ thread: Record<string, unknown> }>(
      `${base}/${link.id}`,
    );
    expect(one.thread).toMatchObject({
      parent_session_id: session,
      state: "starting",
      fork_mode: "seeded",
      child_session_id: null,
    });
    const stale = await send("PATCH", `${base}/${link.id}`, {
      expected_revision: 5,
      state: "closed",
    });
    expect(stale.status).toBe(409);
    const closed = await send("PATCH", `${base}/${link.id}`, {
      expected_revision: 1,
      state: "closed",
    });
    expect(closed.status).toBe(200);
    expect(
      (
        await send("PATCH", `${base}/${link.id}`, {
          expected_revision: 2,
          state: "running",
        })
      ).status,
    ).toBe(400);
    expect(
      (await send("DELETE", `${base}/${link.id}?expected_revision=2`)).status,
    ).toBe(204);
    expect((await api(`${base}/${link.id}`)).status).toBe(404);
  });

  it("keeps projects isolated and pages with a bound cursor", async () => {
    const a = await seed();
    const b = await seed();
    expect(
      (await api(`/api/v1/projects/${b.projectId}/threads/${a.link.id}`))
        .status,
    ).toBe(404);
    expect((await api(`/api/v1/projects/nope/threads`)).status).toBe(404);
    const page = await apiJSON<{ next_cursor: string | null }>(
      `/api/v1/projects/${a.projectId}/threads?limit=1`,
    );
    expect(page.next_cursor).toBeNull();
  });

  it("creates and lists anchored notes through knowledge", async () => {
    const { projectId, session, anchor } = await seed();
    const base = `/api/v1/projects/${projectId}/notes`;
    const wire = {
      block_id: anchor.blockId,
      part_index: 0,
      start: 0,
      end: 4,
      content_hash: anchor.contentHash,
    };
    const created = await send("POST", base, {
      source: { kind: "session", id: session },
      anchors: [wire],
      quote: "hell",
      category: "pattern",
      title: "A note",
      content: "body",
    });
    expect(created.status).toBe(201);
    const { note } = (await created.json()) as { note: { id: string } };
    const shown = await apiJSON<{ entry?: unknown; id?: string }>(
      `/api/v1/knowledge/${note.id}`,
    );
    expect(JSON.stringify(shown)).toContain("A note");
    const listed = await apiJSON<{
      notes: Array<{ id: string; anchor_status: string }>;
    }>(`${base}?source_kind=session&source_id=${session}`);
    expect(listed.notes).toEqual([
      expect.objectContaining({ id: note.id, anchor_status: "current" }),
    ]);
    const bad = await send("POST", base, {
      source: { kind: "session", id: session },
      anchors: [wire],
      quote: "hell",
      category: "nope",
      title: "x",
      content: "y",
    });
    expect(bad.status).toBe(400);
  });
});
