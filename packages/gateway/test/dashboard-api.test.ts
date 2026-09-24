/**
 * Tests for the UI-08 dashboard routes (`/api/v1/entities*`) served by the
 * `dashboard` route module on top of `src/dashboard-api.ts`.
 *
 * Same harness as api.test.ts: a real gateway on an ephemeral port with an
 * isolated temp DB. No upstream interceptor — these endpoints never call LLMs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
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
  dbPath = `/tmp/lore-dashboard-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

async function seedEntity(input: {
  entityType: "person" | "org" | "service" | "tool" | "repo" | "infra";
  canonicalName: string;
  metadata?: Record<string, unknown>;
  aliases?: Array<{ type: "name" | "email"; value: string }>;
}): Promise<{ id: string }> {
  const { entities } = await import("@loreai/core");
  return entities.create(input);
}

async function seedContradictionPair(prefix: string): Promise<{
  a: string;
  b: string;
  projectId: string;
}> {
  const { ensureProject, ltm } = await import("@loreai/core");
  const projectPath = "/test/dashboard/contradictions/" + prefix;
  const projectId = ensureProject(projectPath, prefix);
  const a = ltm.create({
    projectPath,
    category: "decision",
    title: prefix + " rule A",
    content: "Follow rule A.",
    scope: "project",
    id: randomUUID(),
  });
  const b = ltm.create({
    projectPath,
    category: "decision",
    title: prefix + " rule B",
    content: "Follow rule B.",
    scope: "project",
    id: randomUUID(),
  });
  ltm.recordContradiction({
    logicalIdA: a,
    logicalIdB: b,
    projectId,
    similarity: 0.94,
    rationale: "The two recorded directives cannot both be followed.",
  });
  return { a, b, projectId };
}

interface ListBody {
  entities: Array<{
    id: string;
    entity_type: string;
    canonical_name: string;
    aliases: string[];
  }>;
  next_cursor: string | null;
  total: number;
}

describe("GET /api/v1/entities", () => {
  it("lists entities ordered by (entity_type, canonical_name, id)", async () => {
    await seedEntity({ entityType: "repo", canonicalName: "zeta-repo" });
    await seedEntity({ entityType: "person", canonicalName: "Zoe" });
    await seedEntity({ entityType: "person", canonicalName: "Amy" });
    await seedEntity({ entityType: "org", canonicalName: "Acme" });

    const body = await apiJSON<ListBody>("/api/v1/entities");
    expect(body.total).toBeGreaterThanOrEqual(4);
    const names = body.entities.map((e) => e.canonical_name);
    // org < person < repo alphabetically by entity_type.
    const acme = names.indexOf("Acme");
    const amy = names.indexOf("Amy");
    const zoe = names.indexOf("Zoe");
    const zeta = names.indexOf("zeta-repo");
    expect(acme).toBeGreaterThanOrEqual(0);
    expect(acme).toBeLessThan(amy);
    expect(amy).toBeLessThan(zoe);
    expect(zoe).toBeLessThan(zeta);
  });

  it("pages keyset-style across 3 pages without duplicates", async () => {
    // Fresh type so no other tests' rows interleave.
    for (const name of ["ea", "eb", "ec", "ed", "ee"]) {
      await seedEntity({ entityType: "infra", canonicalName: name });
    }
    const page1 = await apiJSON<ListBody>(
      "/api/v1/entities?type=infra&limit=2",
    );
    expect(page1.entities.map((e) => e.canonical_name)).toEqual(["ea", "eb"]);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await apiJSON<ListBody>(
      `/api/v1/entities?type=infra&limit=2&page=${encodeURIComponent(page1.next_cursor!)}`,
    );
    expect(page2.entities.map((e) => e.canonical_name)).toEqual(["ec", "ed"]);

    const page3 = await apiJSON<ListBody>(
      `/api/v1/entities?type=infra&limit=2&page=${encodeURIComponent(page2.next_cursor!)}`,
    );
    expect(page3.entities.map((e) => e.canonical_name)).toEqual(["ee"]);
    expect(page3.next_cursor).toBeNull();

    // A cursor from a since-deleted last row still pages (keyset, not offset).
    const { entities } = await import("@loreai/core");
    entities.remove(page1.entities[1].id);
    const afterDelete = await apiJSON<ListBody>(
      `/api/v1/entities?type=infra&limit=2&page=${encodeURIComponent(page1.next_cursor!)}`,
    );
    expect(afterDelete.entities.map((e) => e.canonical_name)).toEqual([
      "ec",
      "ed",
    ]);
  });

  it("filters by type and returns an empty page for an unknown type", async () => {
    const orgs = await apiJSON<ListBody>("/api/v1/entities?type=org");
    expect(orgs.entities.every((e) => e.entity_type === "org")).toBe(true);
    expect(orgs.entities.map((e) => e.canonical_name)).toContain("Acme");

    const none = await apiJSON<ListBody>("/api/v1/entities?type=bogus");
    expect(none.entities).toEqual([]);
    expect(none.total).toBe(0);
    expect(none.next_cursor).toBeNull();
  });

  it("rejects malformed cursors and limits with 400", async () => {
    for (const path of [
      "/api/v1/entities?page=not!!!base64",
      "/api/v1/entities?page=bm90LWpzb24", // base64url("not-json")
      "/api/v1/entities?limit=abc",
      "/api/v1/entities?limit=0",
      "/api/v1/entities?limit=-3",
    ]) {
      const res = await api(path);
      expect(res.status, path).toBe(400);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("invalid_request");
    }
  });
});

describe("GET /api/v1/entities/:id", () => {
  it("returns detail with metadata, relations and knowledge", async () => {
    const { entities, ltm, ensureProject } = await import("@loreai/core");
    const a = await seedEntity({
      entityType: "person",
      canonicalName: "Grace Hopper",
      metadata: { role: "admiral", extra: "keepme" },
      aliases: [{ type: "email", value: "grace@example.com" }],
    });
    const b = await seedEntity({ entityType: "org", canonicalName: "US Navy" });
    entities.addRelation(a.id, b.id, "colleague");

    const projectPath = "/test/dashboard/project";
    ensureProject(projectPath, "dash-project");
    const kid = ltm.create({
      projectPath,
      category: "decision",
      title: "Entity knowledge",
      content: "Grace worked on compilers",
      session: "s",
      scope: "project",
    });
    entities.linkKnowledge(kid, a.id);

    const body = await apiJSON<{
      entity: {
        id: string;
        canonical_name: string;
        aliases: string[];
        metadata: Record<string, unknown>;
      };
      relations: Array<{ other_id: string; other_name: string }>;
      knowledge: Array<{ id: string; title: string }>;
    }>(`/api/v1/entities/${a.id}`);

    expect(body.entity.id).toBe(a.id);
    expect(body.entity.metadata).toEqual({ role: "admiral", extra: "keepme" });
    expect(body.entity.aliases).toContain("grace@example.com");
    expect(body.relations.some((r) => r.other_name === "US Navy")).toBe(true);
    expect(body.knowledge.some((k) => k.title === "Entity knowledge")).toBe(
      true,
    );
  });

  it("returns 404 for an unknown id", async () => {
    const res = await api("/api/v1/entities/no-such-entity");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "not_found",
    );
  });

  it("rejects malformed URL encoding in an entity id", async () => {
    const res = await api("/api/v1/entities/%E0%A4%A");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "invalid_request",
    );
  });

  it("reports metadata:null for malformed stored JSON", async () => {
    const { db } = await import("@loreai/core");
    const e = await seedEntity({ entityType: "tool", canonicalName: "borked" });
    db()
      .query("UPDATE entities SET metadata = ? WHERE id = ?")
      .run("{not json", e.id);
    const body = await apiJSON<{ entity: { metadata: unknown } }>(
      `/api/v1/entities/${e.id}`,
    );
    expect(body.entity.metadata).toBeNull();
  });

  it("round-trips malicious content verbatim", async () => {
    const e = await seedEntity({
      entityType: "person",
      canonicalName: "<img src=x onerror=alert(1)>",
      metadata: { description: '<a href="javascript:alert(1)">click</a>' },
    });
    const body = await apiJSON<{
      entity: { canonical_name: string; metadata: { description: string } };
    }>(`/api/v1/entities/${e.id}`);
    expect(body.entity.canonical_name).toBe("<img src=x onerror=alert(1)>");
    expect(body.entity.metadata.description).toBe(
      '<a href="javascript:alert(1)">click</a>',
    );
    const list = await apiJSON<ListBody>("/api/v1/entities?type=person");
    expect(
      list.entities.some(
        (x) => x.canonical_name === "<img src=x onerror=alert(1)>",
      ),
    ).toBe(true);
  });
});

describe("PATCH /api/v1/entities/:id", () => {
  it("updates role/description/notes and preserves other metadata keys", async () => {
    const e = await seedEntity({
      entityType: "person",
      canonicalName: "Patch Me",
      metadata: { role: "old", mood: "calm" },
    });
    const res = await api(`/api/v1/entities/${e.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "new role", notes: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entity: { metadata: Record<string, unknown> };
    };
    expect(body.entity.metadata).toEqual({
      role: "new role",
      mood: "calm",
      notes: "hello",
    });
  });

  it("removes keys on null or empty and rejects invalid bodies", async () => {
    const e = await seedEntity({
      entityType: "person",
      canonicalName: "Remove Me",
      metadata: { role: "r", notes: "n" },
    });
    const res = await api(`/api/v1/entities/${e.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: null, notes: "   " }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entity: { metadata: Record<string, unknown> | null };
    };
    expect(body.entity.metadata).toBeNull();

    for (const payload of [
      { role: "x".repeat(2001) },
      { bogus: "key" },
      { role: 42 },
      ["role"],
      "string",
      42,
    ]) {
      const bad = await api(`/api/v1/entities/${e.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(bad.status, JSON.stringify(payload)).toBe(400);
    }
    const notJson = await api(`/api/v1/entities/${e.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(notJson.status).toBe(400);
  });

  it("rejects oversized decoded metadata bodies before parsing them", async () => {
    const e = await seedEntity({
      entityType: "tool",
      canonicalName: "large patch",
    });
    const body = gzipSync(JSON.stringify({ notes: "x".repeat(16 * 1024) }));
    const res = await api(`/api/v1/entities/${e.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "invalid_request",
    );
  });

  it("404s when the entity was deleted between load and save", async () => {
    const { entities } = await import("@loreai/core");
    const e = await seedEntity({ entityType: "tool", canonicalName: "gone" });
    entities.remove(e.id);
    const res = await api(`/api/v1/entities/${e.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("is refused in hosted mode with 403 forbidden", async () => {
    const { enableHostedMode, _resetHostedModeForTest, entities } =
      await import("@loreai/core");
    const e = await seedEntity({ entityType: "tool", canonicalName: "hosted" });
    enableHostedMode();
    try {
      const res = await api(`/api/v1/entities/${e.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "x" }),
      });
      expect(res.status).toBe(403);
      expect(
        ((await res.json()) as { error: { type: string } }).error.type,
      ).toBe("forbidden");
      // Untouched.
      expect(entities.get(e.id)?.metadata ?? "").not.toContain('"x"');
    } finally {
      _resetHostedModeForTest();
    }
  });
});

describe("DELETE /api/v1/entities/:id", () => {
  it("deletes and then 404s", async () => {
    const e = await seedEntity({ entityType: "tool", canonicalName: "del me" });
    const res = await api(`/api/v1/entities/${e.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    const again = await api(`/api/v1/entities/${e.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("is refused in hosted mode with 403 forbidden", async () => {
    const { enableHostedMode, _resetHostedModeForTest, entities } =
      await import("@loreai/core");
    const e = await seedEntity({ entityType: "tool", canonicalName: "stay" });
    enableHostedMode();
    try {
      const res = await api(`/api/v1/entities/${e.id}`, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(
        ((await res.json()) as { error: { type: string } }).error.type,
      ).toBe("forbidden");
      expect(entities.get(e.id)).not.toBeNull();
    } finally {
      _resetHostedModeForTest();
    }
  });
});

describe("GET /api/v1/entities/rebuild", () => {
  it("reports inactive when no rebuild is running", async () => {
    const body = await apiJSON<{ active: boolean }>("/api/v1/entities/rebuild");
    expect(body).toEqual({ active: false });
  });
});

describe("GET/PATCH /api/v1/contradictions", () => {
  it("shows the newest 25 pairs and exposes the next older after a decision", async () => {
    const baseTime = Date.now();
    let detectionTime = baseTime;
    const dateNow = vi
      .spyOn(Date, "now")
      .mockImplementation(() => detectionTime);
    const pairs: Array<{ a: string; b: string; projectId: string }> = [];
    try {
      for (let index = 0; index < 26; index++) {
        detectionTime = baseTime + index * 1_000;
        pairs.push(await seedContradictionPair(`list-${baseTime}-${index}`));
      }
    } finally {
      dateNow.mockRestore();
    }
    const body = await apiJSON<{
      contradictions: Array<{
        id_a: string;
        id_b: string;
        title_a: string;
        title_b: string;
        similarity: number;
        rationale: string | null;
        detected_at: number;
      }>;
      total: number;
    }>("/api/v1/contradictions");
    const pairKey = (a: string, b: string) =>
      a <= b ? `${a}:${b}` : `${b}:${a}`;
    const responseKeys = body.contradictions.map((row) =>
      pairKey(row.id_a, row.id_b),
    );
    const newestFirst = pairs.map((pair) => pairKey(pair.a, pair.b)).reverse();
    const row = body.contradictions.find(
      (candidate) => pairKey(candidate.id_a, candidate.id_b) === newestFirst[0],
    );
    expect(row).toMatchObject({
      title_a: expect.any(String),
      title_b: expect.any(String),
      similarity: 0.94,
      rationale: "The two recorded directives cannot both be followed.",
    });
    expect(body.total).toBe(26);
    expect(body.contradictions).toHaveLength(25);
    expect(responseKeys).toEqual(newestFirst.slice(0, 25));

    const newest = pairs.at(-1);
    if (!newest) throw new Error("the newest contradiction pair is missing");
    const dismissed = await api(
      `/api/v1/contradictions/${newest.a}/${newest.b}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "keep-both" }),
      },
    );
    expect(dismissed.status).toBe(200);

    const afterDecision = await apiJSON<typeof body>("/api/v1/contradictions");
    expect(afterDecision.total).toBe(25);
    expect(
      afterDecision.contradictions.map((row) => pairKey(row.id_a, row.id_b)),
    ).toEqual(newestFirst.slice(1));
  });

  it.each(["keep-a", "keep-b"] as const)(
    "keeps the requested side for %s",
    async (decision) => {
      const { ltm } = await import("@loreai/core");
      const pair = await seedContradictionPair(decision + "-" + Date.now());
      const res = await api("/api/v1/contradictions/" + pair.a + "/" + pair.b, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "resolved",
        kept_id: decision === "keep-a" ? pair.a : pair.b,
      });
      expect(
        ltm.getByLogical(decision === "keep-a" ? pair.a : pair.b),
      ).not.toBeNull();
      expect(
        ltm.getByLogical(decision === "keep-a" ? pair.b : pair.a),
      ).toBeNull();
      expect(ltm.contradictionExists(pair.a, pair.b)).toBe(false);
    },
  );

  it("keeps both and persists the dismissal so it is not re-judged", async () => {
    const { ltm } = await import("@loreai/core");
    const pair = await seedContradictionPair("keep-both-" + Date.now());
    const res = await api("/api/v1/contradictions/" + pair.a + "/" + pair.b, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "keep-both" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "dismissed", kept_id: null });
    expect(ltm.getByLogical(pair.a)).not.toBeNull();
    expect(ltm.getByLogical(pair.b)).not.toBeNull();
    expect(
      ltm
        .listOpenContradictions()
        .some((row) => row.logicalIdA === pair.a && row.logicalIdB === pair.b),
    ).toBe(false);
    expect(
      ltm.recordContradiction({
        logicalIdA: pair.a,
        logicalIdB: pair.b,
        projectId: pair.projectId,
        similarity: 0.99,
        rationale: "redetected",
      }),
    ).toBe(false);
  });

  it("rejects invalid decisions and never becomes a generic delete endpoint", async () => {
    const { ltm } = await import("@loreai/core");
    const pair = await seedContradictionPair("invalid-" + Date.now());
    for (const body of [
      JSON.stringify({ decision: "delete" }),
      JSON.stringify({ decision: "keep-a", extra: true }),
      "{",
    ]) {
      const res = await api("/api/v1/contradictions/" + pair.a + "/" + pair.b, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }

    const unknown = await api(
      "/api/v1/contradictions/" + pair.a + "/not-a-pair",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "keep-a" }),
      },
    );
    expect(unknown.status).toBe(404);
    expect(ltm.getByLogical(pair.a)).not.toBeNull();
    expect(ltm.getByLogical(pair.b)).not.toBeNull();
  });

  it("refuses review writes in hosted mode", async () => {
    const { enableHostedMode, _resetHostedModeForTest, ltm } =
      await import("@loreai/core");
    const pair = await seedContradictionPair("hosted-" + Date.now());
    enableHostedMode();
    try {
      const res = await api("/api/v1/contradictions/" + pair.a + "/" + pair.b, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "keep-a" }),
      });
      expect(res.status).toBe(403);
      expect(
        ((await res.json()) as { error: { type: string } }).error.type,
      ).toBe("forbidden");
      expect(ltm.getByLogical(pair.a)).not.toBeNull();
      expect(ltm.getByLogical(pair.b)).not.toBeNull();
    } finally {
      _resetHostedModeForTest();
    }
  });
});

describe("management boundary", () => {
  it("hides the dashboard routes from non-loopback peers", async () => {
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
      for (const init of [
        { path: "/api/v1/contradictions", init: {} },
        {
          path: "/api/v1/contradictions/a/b",
          init: {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision: "keep-a" }),
          },
        },
        { path: "/api/v1/entities", init: {} },
        { path: "/api/v1/entities/rebuild", init: {} },
        { path: "/api/v1/entities/x", init: {} },
        {
          path: "/api/v1/entities/x",
          init: {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "x" }),
          },
        },
        { path: "/api/v1/entities/x", init: { method: "DELETE" } },
      ] as Array<{ path: string; init: LoopbackRequestInit }>) {
        const res = await loopbackRequest(
          `${remoteBase}${init.path}`,
          init.init,
        );
        // Hidden management route: bodyless 404, indistinguishable from
        // a server without the route at all.
        expect(res.status, `${init.init.method ?? "GET"} ${init.path}`).toBe(
          404,
        );
        expect(await res.text()).toBe("");
      }
    } finally {
      await remote.stop();
    }
  });
});
