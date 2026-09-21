/**
 * Contract tests for `GET /api/v1/sessions/:id/search` (#1857): the
 * in-session finder over `temporal_fts`. The route is additive — the legacy
 * `GET /sessions/:id` shape is untouched (covered by api-session-paging) —
 * and pages newest-first with the same keyset, limits and cursor binding as
 * message paging.
 *
 * Same server bootstrap as api-session-paging.test.ts, kept in its own file
 * so parallel work on those suites rebases cleanly.
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
  dbPath = `/tmp/lore-api-session-search-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

type Hit = {
  message_id: string;
  created_at: number;
  role: string;
  snippet: string;
  rank: number;
};
type SearchPage = {
  hits: Hit[];
  terms: string[];
  mode: "phrase" | "terms";
  total: number;
  next_cursor: string | null;
};
type ApiError = { type: "error"; error: { type: string; message: string } };

function messageInfo(id: string, sid: string, created: number): LoreMessage {
  const user = Number(id.slice(1)) % 2 === 1;
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

/**
 * Session "s1" stored in scrambled order with a run of equal timestamps
 * (m3..m5 at 3000); "s2" and a second project carry the same words so the
 * tests can prove scoping. Message `mK` mentions `needle-K`.
 */
async function seed(tag: string) {
  const { ensureProject, temporal } = await import("@loreai/core");
  const projectPath = `/test/api/session-search/${tag}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const projectId = ensureProject(projectPath, `session-search-${tag}`);
  const plan: Array<[string, string, number, string]> = [
    ["s1", "m5", 3000, "needle-5: portability is a requirement"],
    ["s1", "m1", 1000, "needle-1 opens the session"],
    ["s1", "m7", 7000, "needle-7 closes it; SQLite stays the store"],
    ["s1", "m3", 3000, "needle-3 and SQLite stays"],
    ["s1", "m6", 6000, "needle-6 has\u001fseveral\u001fparts and the store"],
    ["s1", "m2", 2000, "needle-2 says the store is SQLite"],
    ["s1", "m4", 3000, "needle-4, another tie"],
    ["s2", "x1", 500, "needle-3 in another session; SQLite stays"],
    ["s2", "x2", 9000, "needle-7 in another session"],
  ];
  for (const [sid, id, created, text] of plan) {
    temporal.store({
      projectPath,
      info: messageInfo(id, sid, created),
      parts: [
        {
          id: `part-${id}`,
          sessionID: sid,
          messageID: id,
          type: "text",
          text,
          time: { start: 0, end: 0 },
        },
      ],
    });
  }
  // Stored ids are derived; map source id → stored id for assertions.
  const byId = new Map<string, string>();
  for (const m of temporal.bySession(projectPath, "s1")) {
    if (m.source_id) byId.set(m.id, m.source_id);
  }
  const src = (hits: Hit[]) => hits.map((h) => byId.get(h.message_id));
  const sorted = (xs: (string | undefined)[]) =>
    [...xs].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
  return {
    sorted,
    projectPath,
    projectId,
    src,
    base: `/api/v1/sessions/s1/search?path=${encodeURIComponent(projectPath)}`,
  };
}

describe("GET /api/v1/sessions/:id/search", () => {
  it("answers the ids of matching messages with a snippet, scoped to the session and project", async () => {
    const a = await seed("scope");
    // Same words in another project.
    const b = await seed("scope-other");
    const res = await api(`${a.base}&q=needle-3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchPage;
    expect(Object.keys(body).sort()).toEqual(
      ["hits", "mode", "next_cursor", "terms", "total"].sort(),
    );
    expect(body.terms).toEqual(["needle", "3"]);
    expect(body.mode).toBe("phrase");
    expect(body.total).toBe(1);
    expect(body.next_cursor).toBeNull();
    expect(a.src(body.hits)).toEqual(["m3"]);
    const hit = body.hits[0];
    expect(Object.keys(hit).sort()).toEqual(
      ["created_at", "message_id", "rank", "role", "snippet"].sort(),
    );
    expect(hit.created_at).toBe(3000);
    expect(hit.role).toBe("user");
    expect(hit.snippet).toContain("needle-3");
    expect(typeof hit.rank).toBe("number");
    // The stored id is what `GET /sessions/:id` serves, so a reader can
    // address the block.
    const { temporal } = await import("@loreai/core");
    expect(
      temporal
        .bySession(a.projectPath, "s1")
        .some((m) => m.id === hit.message_id),
    ).toBe(true);
    // The other project's own s1 only sees its own message.
    const other = (await (
      await api(`${b.base}&q=needle-3`)
    ).json()) as SearchPage;
    expect(other.total).toBe(1);
    expect(other.hits[0].message_id).not.toBe(hit.message_id);
  });

  it("keeps stop words and short tokens literal, and joins multi-part content", async () => {
    const { base, src, sorted } = await seed("literal");
    const stop = (await (
      await api(`${base}&q=the+store`)
    ).json()) as SearchPage;
    expect(stop.mode).toBe("phrase");
    expect(sorted(src(stop.hits))).toEqual(["m2", "m6", "m7"]);
    const parts = (await (
      await api(`${base}&q=several+parts`)
    ).json()) as SearchPage;
    expect(src(parts.hits)).toEqual(["m6"]);
    expect(parts.hits[0].snippet).not.toContain("\u001f");
    expect(parts.hits[0].snippet).toContain("several parts");
  });

  it("falls back to every-term-anywhere when the phrase is absent, and says so", async () => {
    const { base, src, sorted } = await seed("terms");
    const body = (await (
      await api(`${base}&q=store+needle`)
    ).json()) as SearchPage;
    expect(body.mode).toBe("terms");
    expect(sorted(src(body.hits))).toEqual(["m2", "m6", "m7"]);
    const none = (await (
      await api(`${base}&q=needle+zzzz`)
    ).json()) as SearchPage;
    expect(none).toEqual({
      hits: [],
      terms: ["needle", "zzzz"],
      mode: "terms",
      total: 0,
      next_cursor: null,
    });
  });

  it("treats FTS5 syntax as literal text and reports an unsearchable query honestly", async () => {
    const { base } = await seed("syntax");
    for (const q of [
      'needle-3 OR "needle-1"',
      "needle NEAR(3)",
      "needle* -3",
      "col:needle",
      '""""',
      "(needle) AND {3}",
      "^needle",
      "needle-3 needle-1",
    ]) {
      const res = await api(`${base}&q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    // `OR` is a word, not a union: nothing contains "or".
    const or = (await (
      await api(`${base}&q=${encodeURIComponent("needle-3 OR needle-1")}`)
    ).json()) as SearchPage;
    expect(or.total).toBe(0);
    // Operator-only input has no searchable term — 200 with `terms: []`.
    const empty = (await (
      await api(`${base}&q=${encodeURIComponent('* " ( ) -')}`)
    ).json()) as SearchPage;
    expect(empty).toEqual({
      hits: [],
      terms: [],
      mode: "phrase",
      total: 0,
      next_cursor: null,
    });
  });

  it("requires q and a project, bounds q and validates limit like message paging", async () => {
    const { base, projectPath } = await seed("validate");
    for (const missing of [base, `${base}&q=`, `${base}&q=%20%20`]) {
      const res = await api(missing);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.type).toBe(
        "invalid_request",
      );
    }
    const noProject = await api("/api/v1/sessions/s1/search?q=needle");
    expect(noProject.status).toBe(400);
    expect(((await noProject.json()) as ApiError).error.message).toMatch(
      /identify the project/,
    );
    const tooLong = await api(`${base}&q=${"a".repeat(513)}`);
    expect(tooLong.status).toBe(400);
    for (const limit of ["0", "-1", "abc", "1.5"]) {
      const res = await api(`${base}&q=needle&limit=${limit}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.type).toBe(
        "invalid_request",
      );
    }
    const clamped = await api(`${base}&q=needle&limit=99999`);
    expect(clamped.status).toBe(200);
    // Unknown session: empty, complete, not an error.
    const unknown = (await (
      await api(
        `/api/v1/sessions/nope/search?path=${encodeURIComponent(projectPath)}&q=needle`,
      )
    ).json()) as SearchPage;
    expect(unknown.hits).toEqual([]);
    expect(unknown.total).toBe(0);
    expect(unknown.next_cursor).toBeNull();
  });

  it("pages newest-first across a tie without skips or repeats, chronological within a page", async () => {
    const { base, src } = await seed("walk");
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const qs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const res = await api(`${base}&q=needle&limit=2${qs}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as SearchPage;
      expect(page.total).toBe(7);
      expect(page.mode).toBe("phrase");
      const times = page.hits.map((h) => h.created_at);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      seen.unshift(...(src(page.hits) as string[]));
      pages++;
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe("m1");
    expect(seen[seen.length - 1]).toBe("m7");
  });

  it("a cursor pins the mode and is bound to its project and session", async () => {
    const a = await seed("bind-a");
    const b = await seed("bind-b");
    // "store needle" is a terms-mode query; its cursor carries mode=terms.
    const p1 = (await (
      await api(`${a.base}&q=store+needle&limit=2`)
    ).json()) as SearchPage;
    expect(p1.mode).toBe("terms");
    expect(p1.next_cursor).not.toBeNull();
    const cursor = encodeURIComponent(p1.next_cursor!);
    const p2 = (await (
      await api(`${a.base}&q=store+needle&limit=2&cursor=${cursor}`)
    ).json()) as SearchPage;
    expect(p2.mode).toBe("terms");
    expect(a.src(p2.hits)).toEqual(["m2"]);
    expect(p2.next_cursor).toBeNull();

    const otherSession = await api(
      `/api/v1/sessions/s2/search?path=${encodeURIComponent(a.projectPath)}&q=needle&cursor=${cursor}`,
    );
    expect(otherSession.status).toBe(400);
    expect(((await otherSession.json()) as ApiError).error.type).toBe(
      "invalid_cursor",
    );
    const otherProject = await api(`${b.base}&q=needle&cursor=${cursor}`);
    expect(otherProject.status).toBe(400);
    expect(((await otherProject.json()) as ApiError).error.type).toBe(
      "invalid_cursor",
    );
    // A message-paging cursor is not a search cursor.
    const paging = (await (
      await api(
        `/api/v1/sessions/s1?path=${encodeURIComponent(a.projectPath)}&page=cursor&limit=2`,
      )
    ).json()) as { next_cursor: string };
    const wrongKind = await api(
      `${a.base}&q=needle&cursor=${encodeURIComponent(paging.next_cursor)}`,
    );
    expect(wrongKind.status).toBe(400);
    for (const bad of ["nope!", "AAAA", "e30", "e30-"]) {
      const res = await api(`${a.base}&q=needle&cursor=${bad}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.type).toBe(
        "invalid_cursor",
      );
    }
  });
});
