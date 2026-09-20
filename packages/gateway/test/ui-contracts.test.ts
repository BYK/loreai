/**
 * UI-03 contract test: every route the SPA calls is fetched from a real
 * gateway (isolated temp DB, same setup as api.test.ts), validated against
 * the ArkType contracts the browser uses (`packages/ui/src/contracts` —
 * imported by relative path; the root vitest has no `~` alias), and
 * snapshot-recorded into `packages/ui/test/fixtures/`. Volatile values
 * (uuids, epoch-ms, absolute paths) are normalised deterministically before
 * snapshotting.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loopbackRequest,
  type LoopbackRequestInit,
} from "./helpers/loopback-request";

import {
  accountStatus,
  apiErrorBody,
  cursorPage,
  distillationDetail,
  distillationList,
  knowledgeEntry,
  knowledgeList,
  knowledgeVersionHistory,
  projectList,
  isApiError,
  isContractError,
  parseContract,
  safeParseContract,
  sessionDetail,
  sessionList,
  sessionPage,
  sharingStatus,
  syncStatus,
  teamList,
} from "../../ui/src/contracts";

// ---------------------------------------------------------------------------
// Test-scoped server setup (mirrors api.test.ts)
// ---------------------------------------------------------------------------

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;

const SEEDED = {
  projectPath: "",
  projectId: "",
  knowledgeId: "",
  secondKnowledgeId: "",
  sessionId: "",
};

beforeAll(async () => {
  dbPath = `/tmp/lore-ui-contracts-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.LORE_DB_PATH = dbPath;
  process.env.LORE_LISTEN_PORT = "0";
  process.env.LORE_DEBUG = "false";

  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  const { close, ensureProject, ltm, temporal, db } =
    await import("@loreai/core");
  closeDB = close;
  close();

  SEEDED.projectPath = "/test/ui-contracts/project";
  SEEDED.projectId = ensureProject(SEEDED.projectPath, "ui-contracts");
  db()
    .query("UPDATE projects SET git_remote = ? WHERE id = ?")
    .run("git@github.com:test/ui-contracts.git", SEEDED.projectId);

  SEEDED.sessionId = "ui-contracts-session";
  SEEDED.knowledgeId = ltm.create({
    projectPath: SEEDED.projectPath,
    category: "decision",
    title: "Contracts are validated at the edge",
    content:
      "Every /api/v1 response is parsed by the UI contracts before it reaches a view.",
    session: SEEDED.sessionId,
    scope: "project",
  });
  SEEDED.secondKnowledgeId = ltm.create({
    projectPath: SEEDED.projectPath,
    category: "pattern",
    title: "Cursor pages are opaque tokens",
    content:
      "Cursor values are server-issued tokens and should be passed back unchanged.",
    session: SEEDED.sessionId,
    scope: "project",
  });

  for (const i of [0, 1]) {
    temporal.store({
      projectPath: SEEDED.projectPath,
      info: {
        sessionID: SEEDED.sessionId,
        id: `msg-${i}`,
        role: "user",
        agent: "test",
        model: { providerID: "anthropic", modelID: "claude-test" },
        time: { created: 1_700_000_000_000 + i * 1000 },
      },
      parts: [{ type: "text", text: `message ${i} body` }],
    });
  }

  // One distillation row (raw insert — storeDistillation is module-private).
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, r_compression, c_norm, call_type)
       VALUES (?, ?, ?, '', '[]', ?, ?, 0, 42, 1700000005000, 0.4, 0.9, 'batch')`,
    )
    .run(
      "d-ui-contracts",
      SEEDED.projectId,
      SEEDED.sessionId,
      "distilled observations",
      '["msg-0","msg-1"]',
    );

  const config = loadConfig();
  config.remoteGateway = false;
  config.hostedMode = false;
  server = await startServer(config);
  baseURL = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.stop();
  if (closeDB) closeDB();
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = `${dbPath}${suffix}`;
    try {
      await rm(file, { force: true });
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** Deterministic normalisation of volatile values; keeps key order and types. */
function makeNormaliser() {
  const uuids = new Map<string, string>();
  const paths = new Map<string, string>();
  const tmIds = new Map<string, string>();
  let uuidN = 0;
  let epochN = 0;
  let pathN = 0;
  let tmN = 0;

  function norm(value: unknown): unknown {
    if (typeof value === "string") {
      if (value.startsWith("lore_tm_v1_")) {
        let tag = tmIds.get(value);
        if (!tag) tmIds.set(value, (tag = `<tm-${tmN++}>`));
        return tag;
      }
      if (UUID_RE.test(value)) {
        let tag = uuids.get(value);
        if (!tag) uuids.set(value, (tag = `<uuid-${uuidN++}>`));
        return tag;
      }
      if (value === SEEDED.projectPath || value.startsWith("/test/")) {
        let tag = paths.get(value);
        if (!tag) paths.set(value, (tag = `/tmp/<project-${pathN++}>`));
        return tag;
      }
      // JSON-encoded string fields (e.g. source_ids, metadata): replace with
      // a placeholder — the snapshot writer emits raw inner quotes, which
      // would make the fixture file itself invalid JSON.
      if ((value.startsWith("[") || value.startsWith("{")) && isJson(value)) {
        return "<json>";
      }
      return value;
    }
    if (typeof value === "number" && Number.isInteger(value) && value >= 1e12) {
      return 1_700_000_000_000 + epochN++ * 1000;
    }
    if (Array.isArray(value)) return value.map(norm);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] =
          k === "next_cursor" && typeof v === "string" ? "<cursor>" : norm(v);
      }
      return out;
    }
    return value;
  }
  return norm;
}

const FIXTURES = fileURLToPath(
  new URL("../../ui/test/fixtures", import.meta.url),
);

async function contractRoute<
  Schema extends Parameters<typeof safeParseContract>[1],
>(fixture: string, route: string, path: string, schema: Schema): Promise<void> {
  const res = await api(path);
  const body: unknown = await res.json();
  const parsed = safeParseContract(route, schema, body);
  if (!parsed.ok) {
    console.error(`${fixture} contract issues:`, parsed.error.issues);
  }
  expect(parsed.ok).toBe(true);
  const normalised = makeNormaliser()(body);
  // Snapshot a stringified document: the object serializer's style
  // (trailing commas) drifts between vitest configs and gets reformatted
  // by oxfmt, breaking the comparison. A plain string is written verbatim.
  await expect(JSON.stringify(normalised, null, 2) + "\n").toMatchFileSnapshot(
    `${FIXTURES}/${fixture}`,
  );
}

it("reports contract failures as API errors", () => {
  const input = {
    type: "error",
    error: { type: 42, message: "bad error" },
  };
  const valid = {
    type: "error",
    error: { type: "not_found", message: "missing" },
  };
  expect(parseContract("/valid", apiErrorBody, valid)).toEqual(valid);
  const parsed = safeParseContract("/broken", apiErrorBody, input);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(isContractError(parsed.error)).toBe(true);
    expect(isApiError(parsed.error)).toBe(true);
    expect(parsed.error.kind).toBe("invalid");
    expect(parsed.error.status).toBe(200);
    expect(parsed.error.route).toBe("/broken");
    expect(parsed.error.issues[0]?.path).toContain("error.type");
  }
  expect(() => parseContract("/broken", apiErrorBody, input)).toThrow(
    /does not match the UI contract/,
  );
});

// ---------------------------------------------------------------------------
// Routes the SPA calls
// ---------------------------------------------------------------------------
describe("ui contracts against the real gateway", () => {
  it("GET /projects", async () => {
    await contractRoute(
      "projects.json",
      "/projects",
      "/api/v1/projects",
      projectList,
    );
  });

  it("GET /projects/:id/knowledge", async () => {
    await contractRoute(
      "knowledge-list.json",
      `/projects/${SEEDED.projectId}/knowledge`,
      `/api/v1/projects/${SEEDED.projectId}/knowledge`,
      knowledgeList,
    );
  });

  it("GET /knowledge/:id", async () => {
    await contractRoute(
      "knowledge-entry.json",
      `/knowledge/${SEEDED.knowledgeId}`,
      `/api/v1/knowledge/${SEEDED.knowledgeId}`,
      knowledgeEntry,
    );
  });

  it("GET cursor knowledge page", async () => {
    const path = `/api/v1/projects/${SEEDED.projectId}/knowledge?page=cursor&limit=1`;
    await contractRoute(
      "cursor/knowledge-page.json",
      `/projects/${SEEDED.projectId}/knowledge`,
      path,
      cursorPage(knowledgeEntry),
    );
    const body = (await (await api(path)).json()) as {
      next_cursor: string | null;
    };
    expect(body.next_cursor).toEqual(expect.any(String));
  });

  it("GET last cursor knowledge page", async () => {
    const firstPath = `/api/v1/projects/${SEEDED.projectId}/knowledge?page=cursor&limit=1`;
    const first = (await (await api(firstPath)).json()) as {
      next_cursor: string | null;
    };
    const token = first.next_cursor;
    expect(token).toEqual(expect.any(String));
    if (typeof token !== "string")
      throw new Error("cursor page did not continue");
    const path = `/api/v1/projects/${SEEDED.projectId}/knowledge?cursor=${encodeURIComponent(token)}&limit=1`;
    await contractRoute(
      "cursor/knowledge-page-last.json",
      `/projects/${SEEDED.projectId}/knowledge`,
      path,
      cursorPage(knowledgeEntry),
    );
    const body = (await (await api(path)).json()) as {
      next_cursor: string | null;
    };
    expect(body.next_cursor).toBeNull();
  });

  it("GET knowledge versions", async () => {
    await contractRoute(
      "cursor/knowledge-versions.json",
      `/knowledge/${SEEDED.knowledgeId}/versions`,
      `/api/v1/knowledge/${SEEDED.knowledgeId}/versions`,
      knowledgeVersionHistory,
    );
  });

  it("GET /projects/:id/sessions", async () => {
    await contractRoute(
      "sessions-list.json",
      `/projects/${SEEDED.projectId}/sessions`,
      `/api/v1/projects/${SEEDED.projectId}/sessions`,
      sessionList,
    );
  });

  it("GET /sessions/:id?path=…", async () => {
    await contractRoute(
      "session-detail.json",
      `/sessions/${SEEDED.sessionId}`,
      `/api/v1/sessions/${SEEDED.sessionId}?path=${encodeURIComponent(SEEDED.projectPath)}`,
      sessionDetail,
    );
  });

  it("GET /sessions/:id?path=…&page=cursor", async () => {
    await contractRoute(
      "session-page.json",
      `/sessions/${SEEDED.sessionId}?page=cursor`,
      `/api/v1/sessions/${SEEDED.sessionId}?path=${encodeURIComponent(SEEDED.projectPath)}&page=cursor&limit=1`,
      sessionPage,
    );
  });

  it("GET /projects/:id/distillations", async () => {
    await contractRoute(
      "distillations-list.json",
      `/projects/${SEEDED.projectId}/distillations`,
      `/api/v1/projects/${SEEDED.projectId}/distillations`,
      distillationList,
    );
  });

  it("GET /distillations/:id", async () => {
    await contractRoute(
      "distillation-detail.json",
      "/distillations/d-ui-contracts",
      "/api/v1/distillations/d-ui-contracts",
      distillationDetail,
    );
  });

  it("GET /account", async () => {
    await contractRoute(
      "folk-account.json",
      "/account",
      "/api/v1/account",
      accountStatus,
    );
  });

  it("GET /teams", async () => {
    await contractRoute("folk-teams.json", "/teams", "/api/v1/teams", teamList);
  });

  it("GET /sync/status", async () => {
    await contractRoute(
      "folk-sync-status.json",
      "/sync/status",
      "/api/v1/sync/status",
      syncStatus,
    );
  });

  it("GET /projects/:id/sharing", async () => {
    await contractRoute(
      "folk-sharing.json",
      `/projects/${SEEDED.projectId}/sharing`,
      `/api/v1/projects/${SEEDED.projectId}/sharing`,
      sharingStatus,
    );
  });

  it("404 error envelope", async () => {
    const res = await api("/api/v1/knowledge/does-not-exist");
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    const parsed = safeParseContract("/knowledge/:id", apiErrorBody, body);
    if (!parsed.ok) console.error("api-error issues:", parsed.error.issues);
    expect(parsed.ok).toBe(true);
    await expect(JSON.stringify(body, null, 2) + "\n").toMatchFileSnapshot(
      `${FIXTURES}/api-error.json`,
    );
  });
});
