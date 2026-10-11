/**
 * Route tests for the consented Model Tides upload endpoints (#2026 PR3).
 * The gateway's global fetch is stubbed (and a local stub server is used for
 * the whole-journey cases) so no real network traffic happens.
 */
import { createServer, type Server } from "node:http";
import { brotliDecompressSync } from "node:zlib";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { loopbackRequest } from "./helpers/loopback-request";
import { createTestDatabasePath } from "../../core/test/helpers/test-db-path";
import {
  offloadAllOrTimeout,
  READ_JOB_TIMED_OUT,
} from "../../core/src/read-offload";
import * as core from "@loreai/core";

vi.mock("../../core/src/read-offload", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../core/src/read-offload")>();
  return {
    ...original,
    offloadAllOrTimeout: vi.fn(original.offloadAllOrTimeout),
  };
});

const OWNER_ID = "7b2f9a3e-1c4d-7e5f-8a6b-0c1d2e3f4a5b";
const OWNER_TOKEN = "A".repeat(43);
const ROTATED_TOKEN = "B".repeat(43);

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;
let projectId: string;

const DAY1 = Date.UTC(2025, 2, 3) + 60_000; // 2025-03-03 (week of 2025-03-03)

interface StubCall {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let stub: Server;
let stubCalls: StubCall[] = [];
let stubBaseURL = "";
let stubState: {
  created: boolean;
  published: boolean;
  inAggregate: boolean;
  revision: number;
  deleted: boolean;
};

function stubCounts(): { week: string; model: string; count: number }[] {
  return [
    { week: "2025-03-03", model: "anthropic/claude-sonnet-4", count: 1 },
    { week: "2025-03-03", model: "openai/gpt-5", count: 1 },
  ];
}

function stubReport(overrides: Record<string, unknown> = {}): object {
  return {
    id: OWNER_ID,
    published: stubState.published,
    inAggregate: stubState.inAggregate,
    revision: stubState.revision,
    metricVersion: 2,
    counts: stubCounts(),
    ...overrides,
  };
}

async function readBody(req: NodeJS.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function json(res: NodeJS.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function resetStubState(): void {
  stubState = {
    created: true,
    published: true,
    inAggregate: false,
    revision: 1,
    deleted: false,
  };
}

async function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    void stubHandle(req, res);
  });

  async function stubHandle(
    req: NodeJS.IncomingMessage,
    res: NodeJS.ServerResponse,
  ): Promise<void> {
    const raw = await readBody(req);
    const url = req.url ?? "";
    stubCalls.push({
      method: req.method ?? "",
      url,
      headers: req.headers,
      body:
        (req.headers["content-encoding"] as string) === "br"
          ? JSON.parse(brotliDecompressSync(raw).toString())
          : raw.length
            ? JSON.parse(raw.toString())
            : null,
    });
    if (req.method === "POST" && url === "/api/contributions/personal-v2") {
      stubState.created = true;
      return json(res, {
        id: OWNER_ID,
        published: true,
        inAggregate: false,
        metricVersion: 2,
        token: OWNER_TOKEN,
        url: `http://127.0.0.1:${(stub.address() as { port: number }).port}/u/${OWNER_ID}`,
      });
    }
    const idMatch = url.match(/^\/api\/contributions\/([^/]+)(\/.*)?$/);
    const id = idMatch?.[1];
    const tail = idMatch?.[2] ?? "";
    if (!id || id !== OWNER_ID) {
      return json(res, { error: "not found" }, 404);
    }
    if (req.method === "GET" && tail === "") {
      return stubState.deleted
        ? json(res, { error: "gone" }, 410)
        : json(res, stubReport());
    }
    if (req.method === "DELETE" && tail === "") {
      stubState.deleted = true;
      return res.writeHead(200).end();
    }
    if (req.method === "POST" && tail === "/rotate") {
      return json(res, { token: ROTATED_TOKEN });
    }
    if (req.method === "POST" && tail === "/share") {
      stubState.published = true;
      stubState.revision += 1;
      return json(res, {
        id: OWNER_ID,
        published: true,
        url: `http://127.0.0.1:${(stub.address() as { port: number }).port}/u/${OWNER_ID}`,
      });
    }
    if (req.method === "POST" && tail === "/unshare") {
      stubState.published = false;
      return json(res, { id: OWNER_ID, published: false });
    }
    if (req.method === "POST" && tail === "/contribute") {
      stubState.inAggregate = true;
      stubState.revision += 1;
      return json(res, { id: OWNER_ID, inAggregate: true });
    }
    if (req.method === "POST" && tail === "/withdraw") {
      stubState.inAggregate = false;
      return json(res, { id: OWNER_ID, inAggregate: false });
    }
    if (req.method === "PUT" && tail === "") {
      stubState.revision += 1;
      return json(res, {
        id: OWNER_ID,
        published: stubState.published,
        inAggregate: stubState.inAggregate,
        metricVersion: 2,
      });
    }
    if (req.method === "PUT" && tail === "/migrate-v2") {
      return json(res, {
        id: OWNER_ID,
        published: stubState.published,
        inAggregate: stubState.inAggregate,
        metricVersion: 2,
      });
    }
    return json(res, { error: "no stub route" }, 404);
  }
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubBaseURL = `http://127.0.0.1:${(stub.address() as { port: number }).port}/api/contributions`;
}

function seed(db: {
  query: (q: string) => { run: (...p: unknown[]) => unknown };
}): void {
  const insert = db.query(
    `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
     VALUES (?, ?, ?, 'assistant', 'content', 10, 0, ?, ?)`,
  );
  const meta = (modelID: string, providerID = "anthropic") =>
    JSON.stringify({ modelID, providerID });
  insert.run("muu-1", projectId, "s1", DAY1, meta("claude-sonnet-4"));
  insert.run("muu-2", projectId, "s2", DAY1 + 60_000, meta("gpt-5", "openai"));
}

beforeAll(async () => {
  await startStub();
  resetStubState();
  dbPath = createTestDatabasePath("model-usage-upload-api");
  process.env.LORE_DB_PATH = dbPath;
  process.env.LORE_LISTEN_PORT = "0";
  process.env.LORE_DEBUG = "false";
  process.env.LORE_MODEL_TIDES_ENDPOINT = stubBaseURL;

  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  const { resetPipelineState: reset } = await import("../src/pipeline");
  closeDB = core.close;
  resetPipelineState = reset;
  closeDB();
  await resetPipelineState();

  projectId = core.ensureProject("/test/model-usage-upload-api/a");
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
  stub.close();
  delete process.env.LORE_MODEL_TIDES_ENDPOINT;
});

function api(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return loopbackRequest(`${baseURL}${path}`, {
    method: init.method ?? "GET",
    ...(init.body === undefined
      ? {}
      : {
          body: JSON.stringify(init.body),
          headers: { "content-type": "application/json" },
        }),
  });
}

function ownerFromKV(): { id: string; token: string } | null {
  return core.modelUsage.loadOwner();
}

describe("GET /api/v1/model-usage/upload", () => {
  it("returns snapshot + sha + os with no report when no owner exists", async () => {
    core.modelUsage.deleteOwner();
    const res = await api("/api/v1/model-usage/upload");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshot.format).toBe("model-tides-weekly");
    expect(body.snapshot.version).toBe(2);
    expect(body.snapshot.weeks).toEqual([
      {
        week: "2025-03-03",
        models: { "anthropic/claude-sonnet-4": 1, "openai/gpt-5": 1 },
      },
    ]);
    expect(body.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.upload_os).toBe("linux");
    expect(body.report).toBeNull();
  });

  it("reports report_error when the remote GET fails but keeps the snapshot", async () => {
    core.modelUsage.saveOwner({ id: OWNER_ID, token: OWNER_TOKEN });
    stubState.deleted = true;
    const res = await api("/api/v1/model-usage/upload");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report).toBeNull();
    expect(body.report_error).toContain("No sharing change was started");
    expect(body.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain(OWNER_TOKEN);
    core.modelUsage.deleteOwner();
    stubState.deleted = false;
  });

  it("503s when the read pool cannot serve the aggregate", async () => {
    const mock = vi.mocked(offloadAllOrTimeout);
    mock.mockResolvedValueOnce(READ_JOB_TIMED_OUT);
    const res = await api("/api/v1/model-usage/upload");
    expect(res.status).toBe(503);
  });
});

describe("POST /api/v1/model-usage/upload", () => {
  it("rejects an unconfirmed body", async () => {
    const res = await api("/api/v1/model-usage/upload", {
      method: "POST",
      body: { confirm: "no", snapshot_sha256: "x" },
    });
    expect(res.status).toBe(400);
  });

  it("409s when the snapshot changed since review", async () => {
    const res = await api("/api/v1/model-usage/upload", {
      method: "POST",
      body: { confirm: "YES", snapshot_sha256: "0".repeat(64) },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.type).toBe("stale_review");
  });

  it("creates a report: POST personal-v2 brotli weekly-v2, stores the credential, never leaks the token", async () => {
    core.modelUsage.deleteOwner();
    stubCalls = [];
    const get = await api("/api/v1/model-usage/upload");
    const { snapshot, snapshot_sha256 } = await get.json();
    const res = await api("/api/v1/model-usage/upload", {
      method: "POST",
      body: { confirm: "YES", snapshot_sha256 },
    });
    expect(res.status).toBe(200);
    const create = stubCalls.find(
      (c) => c.method === "POST" && c.url === "/api/contributions/personal-v2",
    );
    expect(create).toBeDefined();
    expect(create!.headers["content-type"]).toBe(
      "application/vnd.model-tides.weekly+json",
    );
    expect(create!.headers["content-encoding"]).toBe("br");
    expect(create!.headers["x-model-tides-schema"]).toBe("weekly-v2");
    expect(create!.headers["x-model-tides-report"]).toBe("personal-v2");
    expect(create!.headers["x-model-tides-upload-os"]).toBe("linux");
    expect(create!.body).toEqual(JSON.parse(JSON.stringify(snapshot)));
    // Decompressed bytes hash to the reviewed sha.
    expect(
      core.modelUsage.snapshotSha256(
        create!.body as core.modelUsage.WeeklySnapshot,
      ),
    ).toBe(snapshot_sha256);
    const owner = ownerFromKV();
    expect(owner).toEqual({ id: OWNER_ID, token: OWNER_TOKEN });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(OWNER_TOKEN);
    expect(body.id).toBe(OWNER_ID);
    core.modelUsage.deleteOwner();
  });

  it("replaces an existing report via PUT with expected-state headers", async () => {
    core.modelUsage.saveOwner({ id: OWNER_ID, token: OWNER_TOKEN });
    resetStubState();
    stubCalls = [];
    const get = await api("/api/v1/model-usage/upload");
    const { snapshot_sha256 } = await get.json();
    const res = await api("/api/v1/model-usage/upload", {
      method: "POST",
      body: { confirm: "YES", snapshot_sha256 },
    });
    expect(res.status).toBe(200);
    const put = stubCalls.find(
      (c) => c.method === "PUT" && c.url === `/api/contributions/${OWNER_ID}`,
    );
    expect(put).toBeDefined();
    expect(put!.headers.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(put!.headers["x-model-tides-expected-visibility"]).toBe("public");
    expect(put!.headers["x-model-tides-expected-aggregate"]).toBe("excluded");
    expect(put!.headers["x-model-tides-schema"]).toBe("weekly-v2");
    core.modelUsage.deleteOwner();
  });

  it("502s when the upstream upload fails", async () => {
    core.modelUsage.saveOwner({ id: OWNER_ID, token: OWNER_TOKEN });
    const get = await api("/api/v1/model-usage/upload");
    const { snapshot_sha256 } = await get.json();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : input.url;
      if (
        url.endsWith(`/api/contributions/${OWNER_ID}`) &&
        init?.method === "PUT"
      ) {
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await api("/api/v1/model-usage/upload", {
        method: "POST",
        body: { confirm: "YES", snapshot_sha256 },
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.message).toContain(
        "Upload failed (HTTP 500). No successful upload was confirmed; your local history is unchanged.",
      );
      expect(JSON.stringify(body)).not.toContain(OWNER_TOKEN);
    } finally {
      globalThis.fetch = realFetch;
    }
    core.modelUsage.deleteOwner();
  });
});

describe("upload actions", () => {
  it("share requires YES and a fresh reviewed_revision; unshare posts without it", async () => {
    core.modelUsage.saveOwner({ id: OWNER_ID, token: OWNER_TOKEN });
    resetStubState();
    const bad = await api("/api/v1/model-usage/upload/share", {
      method: "POST",
      body: { confirm: "YES", reviewed_revision: 999 },
    });
    expect(bad.status).toBe(409);
    expect((await bad.json()).error.type).toBe("stale_review");

    const res = await api("/api/v1/model-usage/upload/share", {
      method: "POST",
      body: { confirm: "YES", reviewed_revision: 1 },
    });
    expect(res.status).toBe(200);
    const share = stubCalls
      .filter((c) => c.url === `/api/contributions/${OWNER_ID}/share`)
      .pop();
    expect(share!.headers["x-model-tides-reviewed-revision"]).toBe("1");

    const unshare = await api("/api/v1/model-usage/upload/unshare", {
      method: "POST",
      body: { confirm: "YES" },
    });
    expect(unshare.status).toBe(200);
    core.modelUsage.deleteOwner();
  });

  it("contribute/withdraw hit the aggregate endpoints", async () => {
    core.modelUsage.saveOwner({ id: OWNER_ID, token: OWNER_TOKEN });
    resetStubState();
    const res = await api("/api/v1/model-usage/upload/contribute", {
      method: "POST",
      body: { confirm: "YES", reviewed_revision: 1 },
    });
    expect(res.status).toBe(200);
    const call = stubCalls
      .filter((c) => c.url === `/api/contributions/${OWNER_ID}/contribute`)
      .pop();
    expect(call!.headers["x-model-tides-reviewed-revision"]).toBe("1");
    const withdraw = await api("/api/v1/model-usage/upload/withdraw", {
      method: "POST",
      body: { confirm: "YES" },
    });
    expect(withdraw.status).toBe(200);
    core.modelUsage.deleteOwner();
  });

  it("actions 409 no_report without an owner", async () => {
    core.modelUsage.deleteOwner();
    const res = await api("/api/v1/model-usage/upload/share", {
      method: "POST",
      body: { confirm: "YES", reviewed_revision: 1 },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.type).toBe("no_report");
  });
});

describe("rotate + delete", () => {
  it("rotate stores the new token atomically and returns no token", async () => {
    core.modelUsage.saveOwner({ id: OWNER_ID, token: OWNER_TOKEN });
    const res = await api("/api/v1/model-usage/upload/rotate", {
      method: "POST",
      body: { confirm: "YES" },
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(ROTATED_TOKEN);
    expect(ownerFromKV()!.token).toBe(ROTATED_TOKEN);
    core.modelUsage.deleteOwner();
  });

  it("delete removes the remote report then the local credential", async () => {
    core.modelUsage.saveOwner({ id: OWNER_ID, token: OWNER_TOKEN });
    stubState.deleted = false;
    const res = await api("/api/v1/model-usage/upload", {
      method: "DELETE",
      body: { confirm: "YES" },
    });
    expect(res.status).toBe(200);
    expect(stubState.deleted).toBe(true);
    expect(ownerFromKV()).toBeNull();
  });

  it("delete keeps the credential when the remote delete fails", async () => {
    core.modelUsage.saveOwner({ id: OWNER_ID, token: OWNER_TOKEN });
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : input.url;
      if (
        url.endsWith(`/api/contributions/${OWNER_ID}`) &&
        init?.method === "DELETE"
      ) {
        return Promise.resolve(new Response("nope", { status: 500 }));
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await api("/api/v1/model-usage/upload", {
        method: "DELETE",
        body: { confirm: "YES" },
      });
      expect(res.status).toBe(502);
      expect(ownerFromKV()).not.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
    core.modelUsage.deleteOwner();
  });
});
