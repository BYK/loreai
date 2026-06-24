/**
 * Integration test: `X-Lore-Provider: bedrock` routes to the bedrock-mantle
 * endpoint over the native Anthropic protocol.
 *
 * Bedrock is reached via `bedrock-mantle.<region>.api.aws/anthropic` (the native
 * Anthropic Messages API). The provider route carries `bedrockMantle: true` with
 * `protocol: "anthropic"`, so the request rides the normal Anthropic path — the
 * only Bedrock-specific transforms are the region-built base URL and the model
 * remap (`claude-… → anthropic.claude-…`) on the OUTGOING body.
 *
 * We drive a non-streaming Anthropic client request with `X-Lore-Provider:
 * bedrock` and assert: (1) the upstream body carries the mantle model id, and
 * (2) the UpstreamSnapshot records protocol "anthropic" + the mantle URL (the
 * single source of truth that workers/warmer/idle consume). Both have their own
 * route-usability check that must recognize the `bedrockMantle` self-URL route.
 */
import { describe, test, expect, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";

/** A non-streaming Anthropic message response (mantle returns native shape). */
function mantleJSONResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_bedrock",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi from bedrock" }],
      model: "anthropic.claude-3-5-sonnet-20241022",
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

describe("X-Lore-Provider: bedrock routing (bedrock-mantle)", () => {
  test("routes to mantle over the Anthropic protocol with a remapped model id", async () => {
    const dbPath = `/tmp/lore-bedrock-route-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    // Port 0 = OS-assigned ephemeral port; server.port returns the actual
    // bound port. Avoids EADDRINUSE flakes from random-port collisions (#931).
    process.env.LORE_LISTEN_PORT = "0";
    process.env.LORE_BEDROCK_REGION = "us-east-1";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const { setUpstreamInterceptor, resetPipelineState, getActiveSessions } =
      await import("../src/pipeline");
    const { startServer } = await import("../src/server");
    const { loadConfig } = await import("../src/config");
    const { close: closeDB } = await import("@loreai/core");

    closeDB();
    await resetPipelineState();

    let capturedBody: Record<string, unknown> | undefined;
    let capturedModel: string | undefined;
    setUpstreamInterceptor(async (body, model) => {
      capturedBody = body as Record<string, unknown>;
      capturedModel = model;
      return mantleJSONResponse();
    });

    const config = loadConfig();
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = () => {
      server.stop();
      closeDB();
      setUpstreamInterceptor(undefined);
      delete process.env.LORE_BEDROCK_REGION;
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
        "x-api-key": "bedrock-api-key-test",
        "anthropic-version": "2023-06-01",
        // X-Lore-Provider: bedrock is THE path under test.
        "x-lore-provider": "bedrock",
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(resp.ok).toBe(true);

    // The OUTGOING body must carry the mantle model id — proof that the bedrock
    // route resolved (anthropic protocol) AND the model remap fired. A native
    // Anthropic body would keep the bare `claude-…` id.
    expect(capturedBody).toBeDefined();
    expect(capturedBody?.model).toBe("anthropic.claude-3-5-sonnet-20241022");
    // It is plain Anthropic — NOT the runtime InvokeModel sentinel.
    expect("anthropic_version" in (capturedBody ?? {})).toBe(false);
    // req.model (the client-facing id) is unchanged for session/cache tracking.
    expect(capturedModel).toBe("claude-3-5-sonnet-20241022");

    // The client gets the response back.
    const text = await resp.text();
    expect(text).toContain("hi from bedrock");

    // The UpstreamSnapshot (single source of truth for workers/warmer/idle)
    // must record protocol "anthropic" + the regional mantle base URL.
    let snapshotProtocol: string | undefined;
    let snapshotUrl: string | undefined;
    for (let i = 0; i < 20; i++) {
      for (const s of getActiveSessions().values()) {
        if (
          s.lastUpstream?.url ===
          "https://bedrock-mantle.us-east-1.api.aws/anthropic"
        ) {
          snapshotProtocol = s.lastUpstream.protocol;
          snapshotUrl = s.lastUpstream.url;
        }
      }
      if (snapshotUrl) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(snapshotProtocol).toBe("anthropic");
    expect(snapshotUrl).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    );
  });
});
