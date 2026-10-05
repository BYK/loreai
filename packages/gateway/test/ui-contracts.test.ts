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
  apiPath,
  cursorPage,
  crossProjectKnowledgeEntry,
  distillationDetail,
  distillationList,
  entityDetail,
  entityListPage,
  entityRebuildStatus,
  importListPage,
  knowledgeEntry,
  knowledgeList,
  knowledgeSearchResponse,
  knowledgeVersionHistory,
  projectList,
  recallResponse,
  isApiError,
  isContractError,
  parseContract,
  safeParseContract,
  sessionDetail,
  sessionList,
  sessionPage,
  sessionSearchPage,
  sharingStatus,
  syncStatus,
  teamList,
  costsSnapshot,
  dedupPreviewResponse,
  projectClearResult,
  projectRenameResult,
  projectsMergeResult,
  sessionsMoveResult,
  warmingSnapshot,
} from "../../ui/src/contracts";
import { createTestDatabasePath } from "../../core/test/helpers/test-db-path";

/** `/api/v1/...` built with the same URL builder the SPA client uses. */
const v1 = (...args: Parameters<typeof apiPath>) =>
  `/api/v1${apiPath(...args)}`;

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
  entityId: "",
  dedupProjectPath: "",
  dedupProjectId: "",
};

beforeAll(async () => {
  dbPath = createTestDatabasePath("ui-contracts");
  process.env.LORE_DB_PATH = dbPath;
  process.env.LORE_LISTEN_PORT = "0";
  process.env.LORE_DEBUG = "false";

  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  const { close, ensureProject, entities, ltm, temporal, db } =
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
  SEEDED.dedupProjectPath = "/test/ui-contracts/dedup-preview";
  SEEDED.dedupProjectId = ensureProject(
    SEEDED.dedupProjectPath,
    "ui-contracts-dedup",
  );
  ltm.create({
    id: crypto.randomUUID(),
    projectPath: SEEDED.dedupProjectPath,
    category: "gotcha",
    title: "Gateway cache warming threshold configuration",
    content: "The cache warming threshold is configured per project.",
    session: "ui-contracts-dedup-session",
    scope: "project",
  });
  ltm.create({
    id: crypto.randomUUID(),
    projectPath: SEEDED.dedupProjectPath,
    category: "gotcha",
    title: "Cache warming threshold configuration",
    content: "Duplicate threshold configuration.",
    session: "ui-contracts-dedup-session",
    scope: "project",
  });
  // A private entry that duplicates a promoted (shared) entry of another
  // project — produces a `pool: "project_shared"` preview group.
  const otherDedupPath = "/test/ui-contracts/dedup-preview-other";
  ensureProject(otherDedupPath, "ui-contracts-dedup-other");
  ltm.create({
    id: crypto.randomUUID(),
    projectPath: SEEDED.dedupProjectPath,
    category: "gotcha",
    title: "Tenant quota eviction ordering rule across projects",
    content: "Evict lowest-quota tenants first.",
    session: "ui-contracts-dedup-session",
    scope: "project",
  });
  ltm.create({
    id: crypto.randomUUID(),
    projectPath: otherDedupPath,
    category: "gotcha",
    title: "Tenant quota eviction ordering rule across projects shared",
    content: "Evict lowest-quota tenants first, everywhere.",
    session: "ui-contracts-dedup-session",
    scope: "project",
    crossProject: true,
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

  SEEDED.entityId = entities.create({
    projectPath: SEEDED.projectPath,
    entityType: "person",
    canonicalName: "Ada Contract",
    aliases: [
      { type: "email", value: "ada.lovelace@analytical-engines.example.com" },
    ],
    metadata: { role: "engineer", notes: "Writes the contract fixtures." },
  }).id;
  entities.linkKnowledge(SEEDED.knowledgeId, SEEDED.entityId);

  // Two conversation-import rows for the project imports contract fixture.
  db()
    .query(
      `INSERT INTO import_history
       (id, project_id, agent_name, source_id, source_hash, entries_created, entries_updated, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "imp-ui-contracts-1",
      SEEDED.projectId,
      "claude",
      "claude-session-2026-04",
      "hash-1",
      12,
      3,
      1_700_000_000_000,
    );
  db()
    .query(
      `INSERT INTO import_history
       (id, project_id, agent_name, source_id, source_hash, entries_created, entries_updated, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "imp-ui-contracts-2",
      SEEDED.projectId,
      "codex",
      "codex-thread-77",
      "hash-2",
      4,
      0,
      1_700_000_500_000,
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
  const groupIds = new Map<string, string>();
  const groupCounts = new Map<string, number>();
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
      const groupMatch = /^(project_shared|project|global):[0-9a-f]{16}$/.exec(
        value,
      );
      if (groupMatch) {
        const scope = groupMatch[1];
        if (scope) {
          let tag = groupIds.get(value);
          if (!tag) {
            const index = groupCounts.get(scope) ?? 0;
            tag = `${scope}:group-${index}`;
            groupIds.set(value, tag);
            groupCounts.set(scope, index + 1);
          }
          return tag;
        }
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
>(
  fixture: string,
  route: string,
  path: string,
  schema: Schema,
  init?: LoopbackRequestInit,
): Promise<void> {
  const res = await api(path, init);
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
      v1(["projects", SEEDED.projectId, "knowledge"]),
      knowledgeList,
    );
  });

  it("POST /projects/:id/dedup (preview)", async () => {
    await contractRoute(
      "dedup-preview.json",
      `/projects/${SEEDED.dedupProjectId}/dedup`,
      v1(["projects", SEEDED.dedupProjectId, "dedup"]),
      dedupPreviewResponse,
      { method: "POST", ...JSON_BODY({}) },
    );
    // The seed includes a private entry duplicating another project's
    // promoted entry — the preview must surface it as a project_shared group
    // that also parses against the contract (checked by contractRoute above).
    const res = await api(v1(["projects", SEEDED.dedupProjectId, "dedup"]), {
      method: "POST",
      ...JSON_BODY({}),
    });
    const preview = (await res.json()) as {
      groups: Array<{
        pool: string;
        scope: string;
        candidates: Array<{ scope: string }>;
        suggested_keep_id: string;
      }>;
    };
    const sharedGroup = preview.groups.find(
      (group) => group.pool === "project_shared",
    );
    expect(sharedGroup).toBeDefined();
    expect(sharedGroup?.scope).toBe("project");
    expect(
      sharedGroup?.candidates.some((candidate) => candidate.scope === "shared"),
    ).toBe(true);
  });

  it("GET /knowledge first cross-project page", async () => {
    await contractRoute(
      "knowledge-all-page.json",
      "/knowledge",
      v1(["knowledge"], { limit: 1 }),
      cursorPage(crossProjectKnowledgeEntry),
    );
  });

  it("GET /knowledge with a project filter", async () => {
    await contractRoute(
      "knowledge-all-project.json",
      "/knowledge",
      v1(["knowledge"], { project: SEEDED.projectId, limit: 1 }),
      cursorPage(crossProjectKnowledgeEntry),
    );
  });

  it("GET /knowledge/search?q=SQLite", async () => {
    await contractRoute(
      "knowledge-search.json",
      "/knowledge/search",
      v1(["knowledge", "search"], { q: "SQLite", limit: 20 }),
      knowledgeSearchResponse,
    );
  });

  it("GET /recall", async () => {
    await contractRoute(
      "recall.json",
      "/recall",
      v1(["recall"], { q: "SQLite", path: SEEDED.projectPath, expand: false }),
      recallResponse,
    );
  });

  it("GET /knowledge/:id", async () => {
    await contractRoute(
      "knowledge-entry.json",
      `/knowledge/${SEEDED.knowledgeId}`,
      v1(["knowledge", SEEDED.knowledgeId]),
      knowledgeEntry,
    );
  });

  it("GET cursor knowledge page", async () => {
    const path = v1(["projects", SEEDED.projectId, "knowledge"], {
      page: "cursor",
      limit: 1,
    });
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
    const firstPath = v1(["projects", SEEDED.projectId, "knowledge"], {
      page: "cursor",
      limit: 1,
    });
    const first = (await (await api(firstPath)).json()) as {
      next_cursor: string | null;
    };
    const token = first.next_cursor;
    expect(token).toEqual(expect.any(String));
    if (typeof token !== "string")
      throw new Error("cursor page did not continue");
    const path = v1(["projects", SEEDED.projectId, "knowledge"], {
      cursor: token,
      limit: 1,
    });
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
      v1(["knowledge", SEEDED.knowledgeId, "versions"]),
      knowledgeVersionHistory,
    );
  });

  it("GET /projects/:id/sessions", async () => {
    await contractRoute(
      "sessions-list.json",
      `/projects/${SEEDED.projectId}/sessions`,
      v1(["projects", SEEDED.projectId, "sessions"]),
      sessionList,
    );
  });

  it("GET /sessions/:id?path=…", async () => {
    await contractRoute(
      "session-detail.json",
      `/sessions/${SEEDED.sessionId}`,
      v1(["sessions", SEEDED.sessionId], { path: SEEDED.projectPath }),
      sessionDetail,
    );
  });

  it("GET /sessions/:id?path=…&page=cursor", async () => {
    await contractRoute(
      "session-page.json",
      `/sessions/${SEEDED.sessionId}?page=cursor`,
      v1(["sessions", SEEDED.sessionId], {
        path: SEEDED.projectPath,
        page: "cursor",
        limit: 1,
      }),
      sessionPage,
    );
  });

  it("GET /sessions/:id/search?path=…&q=…", async () => {
    await contractRoute(
      "session-search.json",
      `/sessions/${SEEDED.sessionId}/search`,
      v1(["sessions", SEEDED.sessionId, "search"], {
        path: SEEDED.projectPath,
        q: "body",
        limit: 1,
      }),
      sessionSearchPage,
    );
  });

  it("GET /projects/:id/imports", async () => {
    await contractRoute(
      "project-imports.json",
      `/projects/${SEEDED.projectId}/imports`,
      v1(["projects", SEEDED.projectId, "imports"]),
      importListPage,
    );
  });

  it("GET /projects/:id/distillations", async () => {
    await contractRoute(
      "distillations-list.json",
      `/projects/${SEEDED.projectId}/distillations`,
      v1(["projects", SEEDED.projectId, "distillations"]),
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
      v1(["projects", SEEDED.projectId, "sharing"]),
      sharingStatus,
    );
  });

  it("GET /entities", async () => {
    await contractRoute(
      "entities-list.json",
      "/entities",
      "/api/v1/entities",
      entityListPage,
    );
  });

  it("GET /entities/:id", async () => {
    await contractRoute(
      "entity-detail.json",
      `/entities/${SEEDED.entityId}`,
      `/api/v1/entities/${SEEDED.entityId}`,
      entityDetail,
    );
  });

  it("GET /entities/rebuild", async () => {
    await contractRoute(
      "entity-rebuild-status.json",
      "/entities/rebuild",
      "/api/v1/entities/rebuild",
      entityRebuildStatus,
    );
  });

  const JSON_BODY = (body: unknown): LoopbackRequestInit => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("PATCH /projects/:id (rename)", async () => {
    await contractRoute(
      "project-rename.json",
      `/projects/${SEEDED.projectId}`,
      v1(["projects", SEEDED.projectId]),
      projectRenameResult,
      {
        method: "PATCH",
        ...JSON_BODY({ name: "ui-contracts-renamed" }),
      },
    );
  });

  it("POST /sessions/move", async () => {
    const { ensureProject, temporal } = await import("@loreai/core");
    const sourcePath = "/test/ui-contracts/move-source";
    const sourceId = ensureProject(sourcePath, "move-source");
    temporal.store({
      projectPath: sourcePath,
      info: {
        sessionID: "ui-contracts-move-session",
        id: "move-msg-0",
        role: "user",
        agent: "test",
        model: { providerID: "anthropic", modelID: "claude-test" },
        time: { created: 1_700_000_010_000 },
      },
      parts: [{ type: "text", text: "a session to move" }],
    });
    await contractRoute(
      "sessions-move.json",
      "/sessions/move",
      "/api/v1/sessions/move",
      sessionsMoveResult,
      {
        method: "POST",
        ...JSON_BODY({
          session_ids: ["ui-contracts-move-session"],
          from_project_id: sourceId,
          to_project: { id: SEEDED.projectId },
        }),
      },
    );
  });

  it("POST /projects/:id/clear", async () => {
    const { ensureProject, ltm } = await import("@loreai/core");
    const path = "/test/ui-contracts/clear";
    const id = ensureProject(path, "clear-me");
    ltm.create({
      projectPath: path,
      category: "decision",
      title: "Disposable entry",
      content: "Cleared by the contract test.",
      scope: "project",
    });
    await contractRoute(
      "project-clear.json",
      `/projects/${id}/clear`,
      v1(["projects", id, "clear"]),
      projectClearResult,
      { method: "POST", ...JSON_BODY({}) },
    );
  });

  it("POST /projects/merge", async () => {
    await contractRoute(
      "projects-merge.json",
      "/projects/merge",
      "/api/v1/projects/merge",
      projectsMergeResult,
      { method: "POST" },
    );
  });

  it("GET /warming", async () => {
    const response = await api("/api/v1/warming");
    expect(response.status).toBe(200);
    expect(
      parseContract("/warming", warmingSnapshot, await response.json()),
    ).toMatchObject({
      enabled: expect.any(Boolean),
      sessions: expect.any(Array),
      histograms: expect.any(Array),
    });
  });

  it("GET /costs", async () => {
    const response = await api("/api/v1/costs");
    expect(response.status).toBe(200);
    expect(
      parseContract("/costs", costsSnapshot, await response.json()),
    ).toMatchObject({
      live: { session_count: expect.any(Number) },
      historical: { session_count: expect.any(Number) },
      daily: { entries: expect.any(Array) },
    });
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
