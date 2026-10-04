/**
 * Contract tests for session titles + title search (#1921): the legacy
 * `GET /projects/:id/sessions` array and the cursor page carry the derived
 * `title`/`title_source`, `?q=` filters by title/id (and opts into cursor
 * mode), and `GET /sessions/:id` reports the title in both response shapes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loopbackRequest } from "./helpers/loopback-request";
import type { LoreMessage } from "@loreai/core";
import { createTestDatabasePath } from "../../core/test/helpers/test-db-path";

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let remotePeer: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;

beforeAll(async () => {
  dbPath = createTestDatabasePath("api-session-titles");
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
  // Same non-loopback peer seam as management-access.test.ts.
  remotePeer = await startServer(config, {
    peerAddressForRequest: () => "192.0.2.10",
  });
});

afterAll(async () => {
  if (server) await server.stop();
  if (remotePeer) await remotePeer.stop();
  if (closeDB) closeDB();
  if (resetPipelineState) await resetPipelineState();
});

function api(path: string): Promise<Response> {
  return loopbackRequest(`${baseURL}${path}`);
}

function remoteApi(path: string): Promise<Response> {
  return loopbackRequest(`http://127.0.0.1:${remotePeer!.port}${path}`);
}

function userMsg(id: string, sid: string, created: number): LoreMessage {
  return {
    id,
    sessionID: sid,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "anthropic", modelID: "m" },
  };
}

type Item = {
  session_id: string;
  title: string;
  title_source: string;
  last_message_at: number;
  match?: "exact" | "fuzzy";
};

async function seed(tag: string) {
  const { ensureProject, temporal, db } = await import("@loreai/core");
  const projectPath = `/test/api/session-titles/${tag}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const projectId = ensureProject(projectPath, `session-titles-${tag}`);
  const text = (sid: string, id: string, body: string) =>
    temporal.store({
      projectPath,
      info: userMsg(id, sid, 1000),
      parts: [
        {
          id: `part-${id}`,
          sessionID: sid,
          messageID: id,
          type: "text",
          text: body,
          time: { start: 0, end: 0 },
        },
      ],
    });
  // s-alpha: plain text first message → first_message title.
  text("s-alpha", "a1", "Deploy the payment service");
  // s-beta: tool-only first message, then a distillation → distillation title.
  temporal.store({
    projectPath,
    info: userMsg("b1", "s-beta", 2000),
    parts: [
      {
        id: "part-b1",
        sessionID: "s-beta",
        messageID: "b1",
        type: "tool",
        tool: "bash",
        state: { status: "completed", output: "cmd output" },
        time: { start: 0, end: 0 },
      },
    ],
  });
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, r_compression, c_norm, call_type)
       VALUES (?, ?, 's-beta', '# Beta pipeline summary', '[]', 'obs', '["b1"]', 0, 12, 7500, 0.4, 0.9, 'batch')`,
    )
    .run(`d-${tag}-${projectId}`, projectId);
  // s-gamma: tool-only, no distillation → id fallback.
  temporal.store({
    projectPath,
    info: userMsg("c1", "s-gamma", 3000),
    parts: [
      {
        id: "part-c1",
        sessionID: "s-gamma",
        messageID: "c1",
        type: "tool",
        tool: "bash",
        state: { status: "completed", output: "out" },
        time: { start: 0, end: 0 },
      },
    ],
  });
  const listBase = `/api/v1/projects/${encodeURIComponent(projectId)}/sessions`;
  return { projectPath, projectId, listBase };
}

describe("GET /api/v1/projects/:id/sessions — titles", () => {
  it("legacy array carries title and title_source", async () => {
    const { listBase } = await seed("legacy");
    const res = await api(listBase);
    expect(res.status).toBe(200);
    const items = (await res.json()) as Item[];
    const byId = new Map(items.map((i) => [i.session_id, i]));
    expect(byId.get("s-alpha")).toMatchObject({
      title: "Deploy the payment service",
      title_source: "first_message",
    });
    expect(byId.get("s-beta")).toMatchObject({
      title: "Beta pipeline summary",
      title_source: "distillation",
    });
    expect(byId.get("s-gamma")).toMatchObject({
      title: "s-gamma",
      title_source: "id",
    });
  });

  it("cursor page carries title and title_source", async () => {
    const { listBase } = await seed("cursor");
    const res = await api(`${listBase}?page=cursor&limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Item[]; next_cursor: unknown };
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(item.title).toBeTruthy();
      expect(item.title_source).toBeTruthy();
    }
  });
});

describe("GET /api/v1/projects/:id/sessions?q= — title search", () => {
  it("non-empty q implies cursor mode and filters by title", async () => {
    const { listBase } = await seed("search");
    const res = await api(`${listBase}?q=payment`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Item[]; next_cursor: null };
    expect(body.items.map((i) => i.session_id)).toEqual(["s-alpha"]);
    expect(body.next_cursor).toBeNull();
  });

  it("flags approximate tail hits with match on exact and fuzzy items (#1948)", async () => {
    const { listBase } = await seed("search-fuzzy");
    // "Deploy the payment service" contains "deploy"; nothing else does.
    const res = await api(`${listBase}?q=deploy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Item[]; next_cursor: null };
    const byId = new Map(body.items.map((i) => [i.session_id, i]));
    expect(byId.get("s-alpha")?.match).toBe("exact");
    for (const item of body.items) {
      expect(item.match === "exact" || item.match === "fuzzy").toBe(true);
    }
    // A pure typo query: no literal hit at all — only fuzzy items come back.
    const typo = await api(`${listBase}?q=deplpy`);
    const typoBody = (await typo.json()) as { items: Item[] };
    expect(typoBody.items).toHaveLength(1);
    expect(typoBody.items[0]).toMatchObject({
      session_id: "s-alpha",
      match: "fuzzy",
    });
  });

  it("matches a session-id prefix", async () => {
    const { listBase } = await seed("search-prefix");
    const res = await api(`${listBase}?q=s-be`);
    const body = (await res.json()) as { items: Item[] };
    expect(body.items.map((i) => i.session_id)).toEqual(["s-beta"]);
  });

  it("pages with cursor while q is re-sent", async () => {
    const { listBase } = await seed("search-paged");
    const p1res = await api(`${listBase}?q=s-&limit=2`);
    const p1 = (await p1res.json()) as {
      items: Item[];
      next_cursor: string | null;
    };
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2res = await api(
      `${listBase}?q=s-&limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`,
    );
    const p2 = (await p2res.json()) as { items: Item[]; next_cursor: null };
    const seen = [...p1.items, ...p2.items].map((i) => i.session_id);
    expect(seen.sort()).toEqual(["s-alpha", "s-beta", "s-gamma"]);
    expect(p2.next_cursor).toBeNull();
  });

  it("q longer than 512 chars is a 400 invalid_request", async () => {
    const { listBase } = await seed("search-long");
    const res = await api(`${listBase}?q=${"x".repeat(513)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { type: string };
    };
    expect(body.error.type).toBe("invalid_request");
  });

  it("empty q behaves as no filter (legacy array)", async () => {
    const { listBase } = await seed("search-empty");
    const res = await api(`${listBase}?q=`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Item[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);
  });

  it("an invalid cursor under q is a 400 invalid_cursor", async () => {
    const { listBase } = await seed("search-badcursor");
    const res = await api(`${listBase}?q=s-&cursor=not-a-cursor`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_cursor");
  });

  it("is hidden (bodyless 404) for a non-loopback peer", async () => {
    const { listBase } = await seed("search-remote");
    const res = await remoteApi(`${listBase}?q=payment`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

describe("GET /api/v1/sessions/:id — title", () => {
  it("legacy shape includes title and title_source", async () => {
    const { projectPath } = await seed("show-legacy");
    const res = await api(
      `/api/v1/sessions/s-alpha?path=${encodeURIComponent(projectPath)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string;
      title_source: string;
      messages: unknown[];
    };
    expect(body.title).toBe("Deploy the payment service");
    expect(body.title_source).toBe("first_message");
  });

  it("cursor shape (?page=cursor) includes title and title_source", async () => {
    const { projectPath } = await seed("show-cursor");
    const res = await api(
      `/api/v1/sessions/s-beta?path=${encodeURIComponent(projectPath)}&page=cursor`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string;
      title_source: string;
      next_cursor: string | null;
    };
    expect(body.title).toBe("Beta pipeline summary");
    expect(body.title_source).toBe("distillation");
  });

  it("a tool-only session without distillation falls back to the id", async () => {
    const { projectPath } = await seed("show-id");
    const res = await api(
      `/api/v1/sessions/s-gamma?path=${encodeURIComponent(projectPath)}`,
    );
    const body = (await res.json()) as { title: string; title_source: string };
    expect(body.title).toBe("s-gamma");
    expect(body.title_source).toBe("id");
  });
});
