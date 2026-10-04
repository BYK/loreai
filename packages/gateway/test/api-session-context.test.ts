/**
 * Contract tests for `GET /api/v1/sessions/:id/context` (#1924): the session's
 * real context window as Lore assembled it. The route is additive — the legacy
 * `GET /sessions/:id` shape is untouched (asserted below for the same session).
 *
 * Same server bootstrap as api-session-search.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loopbackRequest } from "./helpers/loopback-request";
import type { LoreMessage, LorePart } from "@loreai/core";
import { createTestDatabasePath } from "../../core/test/helpers/test-db-path";

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;

beforeAll(async () => {
  dbPath = createTestDatabasePath("api-session-context");
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
});

function api(path: string): Promise<Response> {
  return loopbackRequest(`${baseURL}${path}`);
}

type ApiError = { type: "error"; error: { type: string; message: string } };

type ContextBody = {
  session_id: string;
  layer: number | null;
  history: { message_count: number; token_estimate: number };
  distilled_prefix: { token_count: number; distillations: unknown[] };
  knowledge: {
    cache_text: string | null;
    cache_tokens: number | null;
    pin_tokens: number | null;
    stable_tokens: number | null;
    injections: unknown[];
  };
  prompt_deltas: unknown[];
  turns: Array<{
    message_id: string;
    layer: number;
    raw_tokens: number;
    total_tokens: number;
    distilled_tokens: number;
    usage: {
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
    } | null;
  }>;
};

function userMsg(sid: string, id: string, created: number): LoreMessage {
  return {
    id,
    sessionID: sid,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "anthropic", modelID: "m" },
  };
}

function assistantMsg(
  sid: string,
  id: string,
  created: number,
  gradient?: {
    layer: number;
    rawTokens: number;
    totalTokens: number;
    distilledTokens: number;
  },
): LoreMessage {
  return {
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
      input: 11,
      output: 7,
      reasoning: 0,
      cache: { read: 3, write: 2 },
    },
    ...(gradient ? { gradient } : {}),
  };
}

function parts(sid: string, id: string): LorePart[] {
  return [
    {
      id: `part-${id}`,
      sessionID: sid,
      messageID: id,
      type: "text",
      text: `text ${id}`,
      time: { start: 0, end: 0 },
    },
  ];
}

async function seed(tag: string) {
  const {
    ensureProject,
    temporal,
    db,
    ltm,
    saveSessionTracking,
    appendSessionPromptDelta,
  } = await import("@loreai/core");
  const projectPath = `/test/api/session-context/${tag}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const projectId = ensureProject(projectPath, `session-context-${tag}`);
  const sid = `s1-${tag}`;

  temporal.store({
    projectPath,
    info: userMsg(sid, "m1", 1000),
    parts: parts(sid, "m1"),
  });
  temporal.store({
    projectPath,
    info: assistantMsg(sid, "a1", 2000, {
      layer: 1,
      rawTokens: 100,
      totalTokens: 150,
      distilledTokens: 50,
    }),
    parts: parts(sid, "a1"),
  });
  temporal.store({
    projectPath,
    info: assistantMsg(sid, "a2", 3000),
    parts: parts(sid, "a2"),
  });

  db()
    .query(
      `INSERT INTO distillations
         (id, project_id, session_id, narrative, facts, observations,
          source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, '', '', ?, '', ?, ?, ?, ?)`,
    )
    .run(`d1-${tag}`, projectId, sid, "obs-d1", 0, 40, 0, 500);
  db()
    .query(
      `INSERT INTO distillations
         (id, project_id, session_id, narrative, facts, observations,
          source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, '', '', ?, '', ?, ?, ?, ?)`,
    )
    .run(`d-arch-${tag}`, projectId, sid, "obs-arch", 0, 70, 1, 600);

  const entry = ltm.create({
    id: `019e18ec-0000-7000-8000-${tag.padEnd(12, "0").slice(0, 12)}`,
    projectPath,
    scope: "project",
    category: "decision",
    title: "Ctx entry",
    content: "content",
  });
  const logical = ltm.logicalIdOf(entry);
  db()
    .query(
      `INSERT INTO knowledge_session_injections
         (session_id, logical_id, project_id, created_at, credited, verdict)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sid, logical, projectId, 111, 1, "pass");

  // One well-formed delta + one pre-v100 row (raw INSERT, no created_at).
  appendSessionPromptDelta({
    sessionID: sid,
    projectID: projectId,
    selector: JSON.stringify({
      target: "messages",
      insertAt: 3,
      mut: { changed: [{ id: logical, h: "abc" }], removed: ["gone-id"] },
      debounceAt: 1000 + 60_000,
    }),
    content: JSON.stringify([
      { role: "user", content: [{ type: "text", text: "delta body one" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1" },
          { type: "text", text: "delta body two" },
        ],
      },
    ]),
    createdAt: 1000,
  });
  db()
    .query(
      `INSERT INTO session_prompt_deltas (session_id, seq, project_id, selector, content)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sid, 1, projectId, "{not json", "not json either");

  saveSessionTracking(sid, {
    ltmCacheText: "cached ltm text",
    ltmCacheTokens: 123,
    ltmPinTokens: 45,
    stableLtmTokens: 67,
    lastAcceptedProvenanceLayer: 2,
  });

  return {
    projectPath,
    projectId,
    sid,
    logical,
    base: `/api/v1/sessions/${sid}/context?path=${encodeURIComponent(projectPath)}`,
  };
}

describe("GET /api/v1/sessions/:id/context", () => {
  it("400s without a project param, 404s unknown project and unknown session", async () => {
    const { base, projectPath } = await seed("errors");
    const noProject = await api("/api/v1/sessions/s1/context");
    expect(noProject.status).toBe(400);
    const err = (await noProject.json()) as ApiError;
    expect(err.error.type).toBe("invalid_request");
    expect(err.error.message).toMatch(/identify the project/);

    const noSession = await api(
      `/api/v1/sessions/never-seen/context?path=${encodeURIComponent(projectPath)}`,
    );
    expect(noSession.status).toBe(404);
    expect(((await noSession.json()) as ApiError).error.type).toBe("not_found");

    const unknownProject = await api(
      "/api/v1/sessions/s1/context?path=/test/api/session-context/definitely-absent",
    );
    expect(unknownProject.status).toBe(400); // resolve fails like session show
    expect(base).toContain("context");
  });

  it("returns the full context shape for a seeded session", async () => {
    const { base, sid, projectPath, logical } = await seed("full");
    const res = await api(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextBody;

    expect(Object.keys(body).sort()).toEqual(
      [
        "session_id",
        "layer",
        "history",
        "distilled_prefix",
        "knowledge",
        "prompt_deltas",
        "turns",
      ].sort(),
    );
    expect(body.session_id).toBe(sid);
    expect(body.layer).toBe(2);
    expect(body.history.message_count).toBe(3);
    expect(typeof body.history.token_estimate).toBe("number");

    expect(body.distilled_prefix.token_count).toBe(40);
    expect(body.distilled_prefix.distillations).toEqual([
      {
        id: "d1-full",
        generation: 0,
        token_count: 40,
        created_at: 500,
        observations: "obs-d1",
      },
    ]);

    expect(body.knowledge.cache_text).toBe("cached ltm text");
    expect(body.knowledge.cache_tokens).toBe(123);
    expect(body.knowledge.pin_tokens).toBe(45);
    expect(body.knowledge.stable_tokens).toBe(67);
    expect(body.knowledge.injections).toEqual([
      {
        logical_id: logical,
        title: "Ctx entry",
        category: "decision",
        confidence: 1,
        created_at: 111,
        credited: true,
        verdict: "pass",
      },
    ]);

    expect(body.prompt_deltas).toHaveLength(2);
    expect(body.prompt_deltas[0]).toEqual({
      seq: 0,
      insert_at: 3,
      applied_at: 1000,
      changed: [{ id: logical, title: "Ctx entry" }],
      removed: ["gone-id"],
      text: ["delta body one", "delta body two"],
    });
    // Malformed selector/content degrade to nulls/empties, not a 500.
    expect(body.prompt_deltas[1]).toEqual({
      seq: 1,
      insert_at: null,
      applied_at: null,
      changed: [],
      removed: [],
      text: [],
    });

    expect(body.turns).toHaveLength(1);
    const turn = body.turns[0];
    expect(turn.layer).toBe(1);
    expect(turn.raw_tokens).toBe(100);
    expect(turn.usage).toEqual({
      input: 11,
      output: 7,
      cache_read: 3,
      cache_write: 2,
    });
    const { temporal } = await import("@loreai/core");
    expect(
      temporal
        .bySession(projectPath, sid)
        .some((m) => m.id === turn.message_id),
    ).toBe(true);
  });

  it("leaves the legacy GET /sessions/:id body unchanged for the same session", async () => {
    const { projectPath, sid } = await seed("legacy");
    const res = await api(
      `/api/v1/sessions/${sid}?path=${encodeURIComponent(projectPath)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: unknown[];
      distillations: unknown[];
    };
    const { data, temporal } = await import("@loreai/core");
    expect(body).toEqual({
      messages: temporal.bySession(projectPath, sid),
      distillations: data.listDistillations(projectPath, { sessionId: sid }),
    });
  });

  it("scopes the read to the resolved project", async () => {
    const a = await seed("iso-a");
    const b = await seed("iso-b");
    const resA = await api(a.base);
    const resB = await api(
      `/api/v1/sessions/${a.sid}/context?path=${encodeURIComponent(b.projectPath)}`,
    );
    expect(resA.status).toBe(200);
    // session_state is keyed by session_id globally, so B's project still
    // resolves the session — but every project-scoped section is empty.
    expect(resB.status).toBe(200);
    const scoped = (await resB.json()) as ContextBody;
    expect(scoped.history).toEqual({ message_count: 0, token_estimate: 0 });
    expect(scoped.distilled_prefix).toEqual({
      token_count: 0,
      distillations: [],
    });
    expect(scoped.knowledge.injections).toEqual([]);
    expect(scoped.prompt_deltas).toEqual([]);
    expect(scoped.turns).toEqual([]);
  });
});
