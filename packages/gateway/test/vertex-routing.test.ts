/**
 * Integration test: `X-Lore-Provider: vertex` routes Claude to Google Vertex AI
 * over the `:rawPredict` path with a GCP OAuth2 bearer.
 *
 * The provider route carries `protocol: "vertex"` (url null — the region URL is
 * built at request time), so the request takes pipeline.ts's self-URL-building
 * vertex branch: reuse the Anthropic body, then strip `model`/`stream`, inject
 * `anthropic_version: "vertex-2023-10-16"`, and swap the client key for a GCP
 * bearer. A test seam provides the token (CI has no GCP credentials).
 *
 * We drive a non-streaming Anthropic client request with `X-Lore-Provider:
 * vertex` and assert: (1) the upstream body carries `anthropic_version` and has
 * NO `model`/`stream` (proof the vertex transform fired), and (2) the
 * UpstreamSnapshot records protocol "vertex" + the regional Vertex base URL
 * (the single source of truth workers/warmer/idle consume).
 */
import { describe, test, expect, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";

/** A non-streaming Anthropic message response (Vertex returns native shape). */
function vertexJSONResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_vertex",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi from vertex" }],
      model: "claude-opus-4-8",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let teardownFn: (() => void) | undefined;

afterEach(() => {
  teardownFn?.();
  teardownFn = undefined;
});

describe("X-Lore-Provider: vertex routing (Vertex AI Claude)", () => {
  test("routes to Vertex over the rawPredict path with a transformed body", async () => {
    const dbPath = `/tmp/lore-vertex-route-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    // Port 0 = OS-assigned ephemeral port (avoids EADDRINUSE flake, #931).
    process.env.LORE_LISTEN_PORT = "0";
    // GCP project for the rawPredict URL (no ADC project lookup in CI).
    process.env.GOOGLE_CLOUD_PROJECT = "test-vertex-project";
    // Region default is "global"; pin it so the snapshot URL is deterministic.
    process.env.GOOGLE_CLOUD_REGION = "global";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const { setUpstreamInterceptor, resetPipelineState, getActiveSessions } =
      await import("../src/pipeline");
    const { startServer } = await import("../src/server");
    const { loadConfig } = await import("../src/config");
    const { _setTestVertexTokenProvider } = await import("../src/vertex-auth");
    const { close: closeDB } = await import("@loreai/core");

    // Inject a fake GCP token so the vertex branch never hits real ADC.
    _setTestVertexTokenProvider(() => Promise.resolve("test-vertex-token"));

    closeDB();
    await resetPipelineState();

    let capturedBody: Record<string, unknown> | undefined;
    let capturedModel: string | undefined;
    setUpstreamInterceptor(async (body, model) => {
      capturedBody = body as Record<string, unknown>;
      capturedModel = model;
      return vertexJSONResponse();
    });

    const config = loadConfig();
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = () => {
      server.stop();
      closeDB();
      setUpstreamInterceptor(undefined);
      _setTestVertexTokenProvider(null);
      delete process.env.GOOGLE_CLOUD_PROJECT;
      delete process.env.GOOGLE_CLOUD_REGION;
      for (const suffix of ["", "-shm", "-wal"]) {
        const f = `${dbPath}${suffix}`;
        try {
          if (existsSync(f)) unlinkSync(f);
        } catch {
          // best-effort
        }
      }
    };

    const resp = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-key-ignored-for-vertex",
        "anthropic-version": "2023-06-01",
        // X-Lore-Provider: vertex is THE path under test.
        "x-lore-provider": "vertex",
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(resp.ok).toBe(true);

    // The OUTGOING body must be the Vertex shape — proof the vertex branch ran.
    expect(capturedBody).toBeDefined();
    expect(capturedBody?.anthropic_version).toBe("vertex-2023-10-16");
    // model + stream are removed (model is in the URL; the verb selects stream).
    expect("model" in (capturedBody ?? {})).toBe(false);
    expect("stream" in (capturedBody ?? {})).toBe(false);
    // req.model (client-facing id) is unchanged for session/cache tracking.
    expect(capturedModel).toBe("claude-opus-4-8");

    const text = await resp.text();
    expect(text).toContain("hi from vertex");

    // The UpstreamSnapshot must record protocol "vertex" + the Vertex base URL.
    // Region "global" → the BARE aiplatform host (NOT global-aiplatform, which
    // 404s on rawPredict — verified live).
    const vertexBase = "https://aiplatform.googleapis.com";
    let snapshotProtocol: string | undefined;
    let snapshotUrl: string | undefined;
    for (let i = 0; i < 20; i++) {
      for (const s of getActiveSessions().values()) {
        if (s.lastUpstream?.url === vertexBase) {
          snapshotProtocol = s.lastUpstream.protocol;
          snapshotUrl = s.lastUpstream.url;
        }
      }
      if (snapshotUrl) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(snapshotProtocol).toBe("vertex");
    expect(snapshotUrl).toBe(vertexBase);
  });
});
