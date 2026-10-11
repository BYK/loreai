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
  dbPath = `/tmp/lore-discussions-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

// oxlint-disable-next-line typescript/no-explicit-any -- loose JSON fixtures
type Json = Record<string, any>;

async function seed(tag: string) {
  const core = await import("@loreai/core");
  const projectPath = `/test/discussions-api/${tag}-${Date.now()}`;
  const projectId = core.ensureProject(projectPath);
  const content = "First line of the answer";
  const messageId = `m-${tag}-${Date.now()}`;
  core
    .db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, created_at, metadata) VALUES (?, ?, 'sess', 'assistant', ?, ?, ?)",
    )
    .run(messageId, projectId, content, Date.now(), '{"agent":"claude"}');
  const hash = core.discussions.messagePartHashes(content)[0];
  return { core, projectId, projectPath, messageId, hash };
}

async function start(s: Awaited<ReturnType<typeof seed>>, body?: string) {
  const res = await send("POST", "/api/v1/discussions", {
    project_id: s.projectId,
    source: { kind: "session", id: "sess" },
    anchors: [
      {
        block_id: `m.${s.messageId}`,
        part_index: 0,
        start: 0,
        end: 5,
        content_hash: s.hash,
      },
    ],
    quote: "First",
    ...(body === undefined ? {} : { body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Json;
}

describe("discussions API", () => {
  it("creates, replies, lists and re-reads a discussion", async () => {
    const s = await seed("crud");
    const created = await start(s, "opening");
    const d = created.discussion;
    expect(d).toMatchObject({
      project_id: s.projectId,
      kind: "discussion",
      source: { kind: "session", id: "sess" },
      quote: "First",
      state: "open",
      anchor_status: "current",
      revision: 1,
      reply_count: 1,
      participants: ["user"],
    });
    expect(created.reply.content).toEqual({ kind: "text", body: "opening" });

    const replied = await send(
      "POST",
      `/api/v1/discussions/${d.id}/replies?project=${s.projectId}`,
      { expected_revision: 1, response_message_id: s.messageId },
    );
    expect(replied.status).toBe(201);
    const r = (await replied.json()) as Json;
    expect(r.reply.author).toBe("agent:claude");
    expect(r.discussion.revision).toBe(2);

    const replies = await apiJSON<Json>(
      `/api/v1/discussions/${d.id}/replies?project=${s.projectId}`,
    );
    expect(replies.replies.map((x: Json) => x.seq)).toEqual([1, 2]);

    const bySource = await apiJSON<Json>(
      `/api/v1/discussions?project=${s.projectId}&source_kind=session&source_id=sess`,
    );
    expect(bySource.discussions.map((x: Json) => x.id)).toEqual([d.id]);

    const again = await apiJSON<Json>(
      `/api/v1/discussions/${d.id}?project=${s.projectId}`,
    );
    expect(again.discussion).toMatchObject({ id: d.id, reply_count: 2 });
  });

  it("validates bodies and rejects text + bound response together", async () => {
    const s = await seed("validate");
    const { discussion } = await start(s);
    const both = await send(
      "POST",
      `/api/v1/discussions/${discussion.id}/replies?project=${s.projectId}`,
      { expected_revision: 1, body: "x", response_message_id: s.messageId },
    );
    expect(both.status).toBe(400);
    const unknownKey = await send("POST", "/api/v1/discussions", {
      project_id: s.projectId,
      source: { kind: "session", id: "sess" },
      anchors: [],
      quote: "q",
      extra: true,
    });
    expect(unknownKey.status).toBe(400);
    const missingRevision = await send(
      "PATCH",
      `/api/v1/discussions/${discussion.id}?project=${s.projectId}`,
      { state: "resolved" },
    );
    expect(missingRevision.status).toBe(400);
    for (const content_hash of ["", "a".repeat(12), "ABC"]) {
      const badHash = await send("POST", "/api/v1/discussions", {
        project_id: s.projectId,
        source: { kind: "session", id: "sess" },
        anchors: [
          {
            block_id: `m.${s.messageId}`,
            part_index: 0,
            start: 0,
            end: 5,
            content_hash,
          },
        ],
        quote: "First",
      });
      expect(badHash.status).toBe(400);
    }
  });

  it("returns 409 with the current revision on a stale expected_revision", async () => {
    const s = await seed("conflict");
    const { discussion } = await start(s);
    const ok = await send(
      "PATCH",
      `/api/v1/discussions/${discussion.id}?project=${s.projectId}`,
      { expected_revision: 1, state: "resolved" },
    );
    expect(ok.status).toBe(200);
    const stale = await send(
      "PATCH",
      `/api/v1/discussions/${discussion.id}?project=${s.projectId}`,
      { expected_revision: 1, state: "open" },
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as Json).error).toMatchObject({
      type: "revision_conflict",
      current_revision: 2,
    });
    const del = await send(
      "DELETE",
      `/api/v1/discussions/${discussion.id}?project=${s.projectId}&expected_revision=1`,
    );
    expect(del.status).toBe(409);
  });

  it("reports stale_anchor after the source changes", async () => {
    const s = await seed("stale");
    const { discussion } = await start(s);
    s.core
      .db()
      .query("UPDATE temporal_messages SET content = ? WHERE id = ?")
      .run("First line, rewritten", s.messageId);
    const again = await apiJSON<Json>(
      `/api/v1/discussions/${discussion.id}?project=${s.projectId}`,
    );
    expect(again.discussion.anchor_status).toBe("stale_anchor");
    expect(again.discussion.anchors[0].content_hash).toBe(s.hash);
  });

  it("isolates projects", async () => {
    const a = await seed("iso-a");
    const b = await seed("iso-b");
    const { discussion } = await start(a, "secret");
    for (const path of [
      `/api/v1/discussions/${discussion.id}?project=${b.projectId}`,
      `/api/v1/discussions/${discussion.id}/replies?project=${b.projectId}`,
      `/api/v1/discussions/${discussion.id}?project=unknown-project`,
    ]) {
      expect((await api(path)).status).toBe(404);
    }
    const list = await apiJSON<Json>(
      `/api/v1/discussions?project=${b.projectId}`,
    );
    expect(list.discussions).toEqual([]);
    const cursorLeak = await api(
      `/api/v1/discussions?project=${a.projectId}&limit=1`,
    );
    expect(cursorLeak.status).toBe(200);
  });

  it("pages discussions with a filter-bound keyset cursor", async () => {
    const s = await seed("page");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await start(s)).discussion.id);
    const first = await apiJSON<Json>(
      `/api/v1/discussions?project=${s.projectId}&limit=2`,
    );
    expect(first.discussions.map((d: Json) => d.id)).toEqual([ids[2], ids[1]]);
    const next = await apiJSON<Json>(
      `/api/v1/discussions?project=${s.projectId}&limit=2&cursor=${first.next_cursor}`,
    );
    expect(next.discussions.map((d: Json) => d.id)).toEqual([ids[0]]);
    expect(next.next_cursor).toBeNull();
    const rebound = await api(
      `/api/v1/discussions?project=${s.projectId}&state=open&cursor=${first.next_cursor}`,
    );
    expect(rebound.status).toBe(400);
  });

  it("creates threads and links discussions", async () => {
    const s = await seed("threads");
    const { discussion } = await start(s);
    const created = await send(
      "POST",
      `/api/v1/projects/${s.projectId}/threads`,
      {
        title: "Auth rework",
      },
    );
    expect(created.status).toBe(201);
    const { thread } = (await created.json()) as Json;
    const linked = await send(
      "POST",
      `/api/v1/projects/${s.projectId}/threads/${thread.id}/discussions`,
      { discussion_id: discussion.id, expected_revision: 1 },
    );
    expect(((await linked.json()) as Json).discussion.thread_id).toBe(
      thread.id,
    );
    const shown = await apiJSON<Json>(
      `/api/v1/projects/${s.projectId}/threads/${thread.id}`,
    );
    expect(shown.thread.discussion_count).toBe(1);
    expect(shown.discussions.map((d: Json) => d.id)).toEqual([discussion.id]);
    const listed = await apiJSON<Json>(
      `/api/v1/projects/${s.projectId}/threads`,
    );
    expect(listed.threads.map((t: Json) => t.id)).toEqual([thread.id]);
    const other = await seed("threads-other");
    expect(
      (await api(`/api/v1/projects/${other.projectId}/threads/${thread.id}`))
        .status,
    ).toBe(404);
    const unlink = await send(
      "DELETE",
      `/api/v1/projects/${s.projectId}/threads/${thread.id}/discussions/${discussion.id}?expected_revision=2`,
    );
    expect(((await unlink.json()) as Json).discussion.thread_id).toBeNull();
  });
});
