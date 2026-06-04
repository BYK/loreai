/**
 * Tests for WebSocket-upgrade rejection.
 *
 * Clients like Codex (OpenAI Responses API) optimistically try to open a
 * WebSocket to `/v1/responses` before falling back to HTTP. The gateway is an
 * HTTP-only translating proxy, so it must reject the upgrade with a definitive
 * response (426) rather than a misleading `404 No route for GET /v1/responses`,
 * which caused repeated upgrade attempts and noisy logs.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";

let baseURL: string;
let dbPath: string;
let server: { stop: () => void; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;

beforeAll(async () => {
  dbPath = `/tmp/lore-ws-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.LORE_DB_PATH = dbPath;
  process.env.LORE_LISTEN_PORT = String(
    20000 + Math.floor(Math.random() * 30000),
  );
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
  server = startServer(config);
  baseURL = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) server.stop();
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

// A WS upgrade arrives as a GET with Upgrade/Connection headers. We send a raw
// HTTP request (not the WebSocket() API) so we can inspect the gateway's
// rejection response directly.
async function sendUpgrade(
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseURL}${path}`, {
    method: "GET",
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...headers,
    },
  });
}

describe("WebSocket upgrade rejection", () => {
  it("rejects WS upgrade on /v1/responses with 426 (not 404)", async () => {
    const resp = await sendUpgrade("/v1/responses");
    expect(resp.status).toBe(426);
    const body = (await resp.json()) as {
      error?: { type?: string; message?: string };
    };
    expect(body.error?.type).toBe("websocket_not_supported");
    expect(body.error?.message).toContain("/v1/responses");
    // Must NOT be the misleading "No route" 404.
    expect(body.error?.message).not.toContain("No route");
  });

  it("rejects WS upgrade regardless of endpoint path", async () => {
    const resp = await sendUpgrade("/v1/messages");
    expect(resp.status).toBe(426);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("websocket_not_supported");
  });

  it("handles a comma-separated Connection header (keep-alive, Upgrade)", async () => {
    const resp = await sendUpgrade("/v1/responses", {
      Connection: "keep-alive, Upgrade",
    });
    expect(resp.status).toBe(426);
  });

  it("does NOT treat a normal GET (no Upgrade header) as a WS upgrade", async () => {
    // /health is a normal GET route — must still work, returning 200.
    const resp = await fetch(`${baseURL}/health`);
    expect(resp.status).toBe(200);
  });

  it("does NOT treat an Upgrade header without Connection:upgrade as WS", async () => {
    // A stray Upgrade header without a matching Connection token is not a
    // valid WS handshake — should fall through to normal routing (404 here,
    // since GET /v1/responses has no HTTP route).
    const resp = await fetch(`${baseURL}/v1/responses`, {
      method: "GET",
      headers: { Upgrade: "websocket", Connection: "keep-alive" },
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("No route");
  });
});
