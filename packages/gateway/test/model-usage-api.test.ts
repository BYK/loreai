/**
 * Route tests for the model-usage endpoints (#2026): document shape,
 * Cache-Control, export Content-Disposition filename derivation, filter
 * errors, and the project filter.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loopbackRequest } from "./helpers/loopback-request";
import { createTestDatabasePath } from "../../core/test/helpers/test-db-path";

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;
let projectId: string;
let otherProjectId: string;

const DAY1 = Date.UTC(2025, 2, 1) + 60_000; // 2025-03-01
const DAY2 = Date.UTC(2025, 2, 2) + 60_000; // 2025-03-02

function seed(db: {
  query: (q: string) => { run: (...p: unknown[]) => unknown };
}): void {
  const insert = db.query(
    `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
     VALUES (?, ?, ?, 'assistant', 'content', 10, 0, ?, ?)`,
  );
  const meta = (modelID: string, providerID = "anthropic") =>
    JSON.stringify({ modelID, providerID });
  insert.run("mu-1", projectId, "s1", DAY1, meta("claude-sonnet-4"));
  insert.run("mu-2", projectId, "s1", DAY1 + 60_000, meta("claude-sonnet-4"));
  insert.run("mu-3", projectId, "s1", DAY2, meta("claude-sonnet-4"));
  insert.run("mu-4", otherProjectId, "s2", DAY1, meta("gpt-5", "openai"));
}

beforeAll(async () => {
  dbPath = createTestDatabasePath("model-usage-api");
  process.env.LORE_DB_PATH = dbPath;
  process.env.LORE_LISTEN_PORT = "0";
  process.env.LORE_DEBUG = "false";

  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  const { resetPipelineState: reset } = await import("../src/pipeline");
  const core = await import("@loreai/core");
  closeDB = core.close;
  resetPipelineState = reset;
  closeDB();
  await resetPipelineState();

  projectId = core.ensureProject("/test/model-usage-api/a");
  otherProjectId = core.ensureProject("/test/model-usage-api/b");
  seed(core.db());

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

describe("GET /api/v1/model-usage", () => {
  it("returns the model-tides daily document with no-store", async () => {
    const res = await api("/api/v1/model-usage");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const doc = await res.json();
    expect(doc.format).toBe("model-tides-daily");
    expect(doc.version).toBe(2);
    expect(doc.source).toBe("lore");
    expect(doc.days).toEqual([
      {
        day: "2025-03-01",
        models: { "anthropic/claude-sonnet-4": 1, "openai/gpt-5": 1 },
      },
      { day: "2025-03-02", models: { "anthropic/claude-sonnet-4": 1 } },
    ]);
  });

  it("scopes to a project filter", async () => {
    const res = await api(`/api/v1/model-usage?project=${otherProjectId}`);
    const doc = await res.json();
    expect(doc.days).toEqual([
      { day: "2025-03-01", models: { "openai/gpt-5": 1 } },
    ]);
  });

  it("applies from/to bounds", async () => {
    const res = await api("/api/v1/model-usage?from=2025-03-02&to=2025-03-02");
    const doc = await res.json();
    expect(doc.days).toEqual([
      { day: "2025-03-02", models: { "anthropic/claude-sonnet-4": 1 } },
    ]);
  });

  it("400s on a bad date and 404s on an unknown project", async () => {
    const bad = await api("/api/v1/model-usage?from=2026-02-30");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.type).toBe("invalid_request");
    const missing = await api(
      "/api/v1/model-usage?project=00000000-0000-0000-0000-000000000000",
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.type).toBe("not_found");
  });
});

describe("GET /api/v1/model-usage/export", () => {
  it("attaches a JSON file named from the explicit range", async () => {
    const res = await api(
      "/api/v1/model-usage/export?from=2025-03-01&to=2025-03-02",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="lore-model-usage-2025-03-01-2025-03-02.json"',
    );
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).days).toHaveLength(2);
  });

  it("derives the filename from the document range when no filter", async () => {
    const res = await api("/api/v1/model-usage/export");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="lore-model-usage-2025-03-01-2025-03-02.json"',
    );
  });

  it("derives the filename from the filtered document range", async () => {
    const res = await api("/api/v1/model-usage/export?from=2025-03-02");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="lore-model-usage-2025-03-02-2025-03-02.json"',
    );
  });
});
