/**
 * Contract tests for opt-in message paging on `GET /api/v1/sessions/:id`
 * (UI-06, #1801): the legacy response is unchanged, cursor mode walks the
 * session backwards from its newest message in stable `(created_at, id)`
 * order, and cursors are bound to the project + session they were minted for.
 *
 * Same server bootstrap as api.test.ts, kept in its own file so parallel
 * work on that suite rebases cleanly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { loopbackRequest } from "./helpers/loopback-request";
import type { LoreMessage } from "@loreai/core";

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;

beforeAll(async () => {
  dbPath = `/tmp/lore-api-session-paging-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

function api(path: string): Promise<Response> {
  return loopbackRequest(`${baseURL}${path}`);
}

/** Server ids are derived (`lore_tm_v1_…`); `source_id` is the id we stored. */
type Msg = {
  id: string;
  source_id: string | null;
  created_at: number;
  role: string;
  content: string;
};

function messageInfo(id: string, sid: string, created: number): LoreMessage {
  const user = id.startsWith("m") && Number(id.slice(1)) % 2 === 1;
  return user
    ? {
        id,
        sessionID: sid,
        role: "user",
        time: { created },
        agent: "build",
        model: { providerID: "anthropic", modelID: "m" },
      }
    : {
        id,
        sessionID: sid,
        role: "assistant",
        time: { created },
        parentID: `parent-${id}`,
        modelID: "m",
        providerID: "anthropic",
        mode: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      };
}

const src = (m: Msg) => m.source_id ?? "";
type Legacy = { messages: Msg[]; distillations: unknown[] };
type Paged = Legacy & { next_cursor: string | null; message_count: number };
type ApiError = { type: "error"; error: { type: string; message: string } };

/**
 * Two sessions in one project. Session "s1" is stored in scrambled order and
 * has a run of equal timestamps (m3..m5 at 3000) so a page boundary can land
 * inside a tie; "s2" exists to prove cursors do not cross sessions.
 */
async function seed(tag: string) {
  const { ensureProject, temporal, db } = await import("@loreai/core");
  const projectPath = `/test/api/session-paging/${tag}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const projectId = ensureProject(projectPath, `session-paging-${tag}`);
  const plan: Array<[string, string, number]> = [
    ["s1", "m5", 3000],
    ["s1", "m1", 1000],
    ["s1", "m7", 7000],
    ["s1", "m3", 3000],
    ["s1", "m6", 6000],
    ["s1", "m2", 2000],
    ["s1", "m4", 3000],
    ["s2", "x1", 500],
    ["s2", "x2", 9000],
  ];
  for (const [sid, id, created] of plan) {
    temporal.store({
      projectPath,
      info: messageInfo(id, sid, created),
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
  }
  // storeDistillation is module-private; insert the row directly.
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, r_compression, c_norm, call_type)
       VALUES (?, ?, 's1', '', '[]', 'summary of s1', '["m1","m2"]', 0, 12, 7500, 0.4, 0.9, 'batch')`,
    )
    .run(`d-${tag}-${projectId}`, projectId);
  return {
    projectPath,
    base: `/api/v1/sessions/s1?path=${encodeURIComponent(projectPath)}`,
  };
}

describe("GET /api/v1/sessions/:id — legacy shape is unchanged", () => {
  it("returns every message and all distillations, no paging fields", async () => {
    const { projectPath, base } = await seed("legacy");
    const { temporal, data } = await import("@loreai/core");
    const res = await api(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Legacy;
    expect(Object.keys(body)).toEqual(["messages", "distillations"]);
    expect(body.messages.map((m) => m.id)).toEqual(
      temporal.bySession(projectPath, "s1").map((m) => m.id),
    );
    expect(body.messages.map(src).sort()).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
    ]);
    expect(body.messages).toHaveLength(7);
    expect(body.distillations).toEqual(
      JSON.parse(
        JSON.stringify(
          data.listDistillations(projectPath, { sessionId: "s1" }),
        ),
      ),
    );
    // Only `page=cursor` / `cursor=` opt in; other `page` values are ignored.
    const other = (await (
      await api(`${base}&page=2&limit=1`)
    ).json()) as Legacy;
    expect(Object.keys(other)).toEqual(["messages", "distillations"]);
    expect(other.messages).toHaveLength(7);
  });
});

describe("GET /api/v1/sessions/:id — cursor mode", () => {
  it("first page is the newest messages in chronological order with count + distillations", async () => {
    const { base } = await seed("first");
    const res = await api(`${base}&page=cursor&limit=3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Paged;
    expect(Object.keys(body).sort()).toEqual(
      ["distillations", "message_count", "messages", "next_cursor"].sort(),
    );
    // The newest three: m6, m7 and whichever of the 3000-tie sorts last by id.
    const ids = body.messages.map(src);
    expect(ids.slice(1)).toEqual(["m6", "m7"]);
    expect(["m3", "m4", "m5"]).toContain(ids[0]);
    expect(body.messages.map((m) => m.created_at)).toEqual([3000, 6000, 7000]);
    expect(body.message_count).toBe(7);
    expect(body.distillations).toHaveLength(1);
    expect(body.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("walks backwards across a tie without skipping or repeating and ends with null", async () => {
    const { projectPath, base } = await seed("walk");
    const { temporal } = await import("@loreai/core");
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const qs = cursor
        ? `&cursor=${encodeURIComponent(cursor)}&limit=2`
        : "&page=cursor&limit=2";
      const res = await api(`${base}${qs}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as Paged;
      // Each page is chronological; each page is strictly older than the last.
      const times = page.messages.map((m) => m.created_at);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      seen.unshift(...page.messages.map((m) => m.id));
      pages++;
      expect(page.message_count).toBe(7);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(4);
    // Exactly the legacy set, once each — the tie inside 3000 was split
    // across pages without a skip or repeat.
    expect([...seen].sort()).toEqual(
      temporal
        .bySession(projectPath, "s1")
        .map((m) => m.id)
        .sort(),
    );
    expect(new Set(seen).size).toBe(7);
  });

  it("a limit larger than the session returns everything and no cursor", async () => {
    const { base } = await seed("all");
    const body = (await (
      await api(`${base}&page=cursor&limit=50`)
    ).json()) as Paged;
    expect(body.messages.map(src).sort()).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
    ]);
    expect(body.messages.map((m) => m.created_at)).toEqual([
      1000, 2000, 3000, 3000, 3000, 6000, 7000,
    ]);
    expect(body.next_cursor).toBeNull();
    // Default limit (no `limit`) also covers this small session.
    const dflt = (await (await api(`${base}&page=cursor`)).json()) as Paged;
    expect(dflt.messages).toHaveLength(7);
    expect(dflt.next_cursor).toBeNull();
  });

  it("a message appended between pages does not shift older pages", async () => {
    const { projectPath, base } = await seed("append");
    const { temporal } = await import("@loreai/core");
    const p1 = (await (
      await api(`${base}&page=cursor&limit=3`)
    ).json()) as Paged;
    expect(p1.messages.map(src).slice(1)).toEqual(["m6", "m7"]);
    temporal.store({
      projectPath,
      info: {
        id: "m8",
        sessionID: "s1",
        role: "user",
        time: { created: 8000 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "m" },
      },
      parts: [
        {
          id: "part-m8",
          sessionID: "s1",
          messageID: "m8",
          type: "text",
          text: "late arrival",
          time: { start: 0, end: 0 },
        },
      ],
    });
    const p2 = (await (
      await api(`${base}&cursor=${encodeURIComponent(p1.next_cursor!)}&limit=3`)
    ).json()) as Paged;
    // Still the three messages older than page 1's oldest: m2 plus the two
    // remaining members of the 3000-tie.
    const p2Ids = p2.messages.map(src);
    expect(p2Ids[0]).toBe("m2");
    expect(new Set([...p1.messages.map(src), ...p2Ids])).toEqual(
      new Set(["m2", "m3", "m4", "m5", "m6", "m7"]),
    );
    expect(p2.message_count).toBe(8);
  });

  it("rejects malformed, cross-session and cross-project cursors and bad limits", async () => {
    const a = await seed("bind-a");
    const b = await seed("bind-b");
    const p1 = (await (
      await api(`${a.base}&page=cursor&limit=2`)
    ).json()) as Paged;
    const cursor = encodeURIComponent(p1.next_cursor!);

    const otherSession = await api(
      `/api/v1/sessions/s2?path=${encodeURIComponent(a.projectPath)}&cursor=${cursor}`,
    );
    expect(otherSession.status).toBe(400);
    expect(((await otherSession.json()) as ApiError).error.type).toBe(
      "invalid_cursor",
    );

    const otherProject = await api(`${b.base}&cursor=${cursor}`);
    expect(otherProject.status).toBe(400);
    expect(((await otherProject.json()) as ApiError).error.type).toBe(
      "invalid_cursor",
    );

    for (const bad of ["nope!", "AAAA", "e30", "e30-"]) {
      const res = await api(`${a.base}&cursor=${bad}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.type).toBe(
        "invalid_cursor",
      );
    }

    for (const limit of ["0", "-1", "abc", "1.5"]) {
      const res = await api(`${a.base}&page=cursor&limit=${limit}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.type).toBe(
        "invalid_request",
      );
    }
    // Over-large limits are clamped, not rejected.
    const clamped = await api(`${a.base}&page=cursor&limit=99999`);
    expect(clamped.status).toBe(200);
  });

  it("an unknown session pages to an empty, complete result", async () => {
    const { projectPath } = await seed("empty");
    const body = (await (
      await api(
        `/api/v1/sessions/nope?path=${encodeURIComponent(projectPath)}&page=cursor`,
      )
    ).json()) as Paged;
    expect(body.messages).toEqual([]);
    expect(body.next_cursor).toBeNull();
    expect(body.message_count).toBe(0);
  });
});
