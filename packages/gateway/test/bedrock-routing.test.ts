/**
 * Integration test: X-Lore-Provider routing actually reaches the Bedrock branch.
 *
 * Regression for the routing bug found in adversarial review of PR #898:
 * `providerRouteUsable` nulled out any provider route whose `url` is null
 * unless an X-Lore-Upstream-URL was also present. The `bedrock` PROVIDER_ROUTES
 * entry has `url: null` (the Bedrock branch self-builds the region URL), so
 * `X-Lore-Provider: bedrock` fell through to the model-prefix route — a
 * claude-* model resolves to api.anthropic.com — and silently bypassed Bedrock
 * entirely (wrong auth, no SigV4).
 *
 * We drive a non-streaming Anthropic-format client request with
 * `X-Lore-Provider: bedrock` and assert the UPSTREAM body the interceptor
 * receives is Bedrock-shaped (`anthropic_version: "bedrock-2023-05-31"`),
 * proving effectiveProtocol resolved to "bedrock". On the pre-fix code this
 * body would be the native-Anthropic shape (no bedrock sentinel).
 */
import { describe, test, expect, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";

/** A non-streaming Bedrock (InvokeModel) JSON response — Anthropic message shape. */
function bedrockJSONResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_bedrock",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi from bedrock" }],
      model: "claude-3-5-sonnet-20241022",
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

describe("X-Lore-Provider: bedrock routing", () => {
  test("routes to the Bedrock branch (upstream body is Bedrock-shaped)", async () => {
    const dbPath = `/tmp/lore-bedrock-route-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = String(
      20000 + Math.floor(Math.random() * 30000),
    );
    process.env.LORE_BEDROCK_REGION = "us-east-1";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const { setUpstreamInterceptor, resetPipelineState, getActiveSessions } =
      await import("../src/pipeline");
    const { _setTestCredentialProviders } = await import("../src/bedrock-auth");
    const { startServer } = await import("../src/server");
    const { loadConfig } = await import("../src/config");
    const { close: closeDB } = await import("@loreai/core");

    closeDB();
    await resetPipelineState();

    // Deterministic AWS creds so SigV4 signing (runs before the interceptor)
    // succeeds without touching the real credential chain / IMDS.
    _setTestCredentialProviders([
      async () => ({ accessKeyId: "AKIATEST", secretAccessKey: "secret" }),
    ]);

    let capturedBody: Record<string, unknown> | undefined;
    let capturedModel: string | undefined;
    setUpstreamInterceptor(async (body, model) => {
      capturedBody = body as Record<string, unknown>;
      capturedModel = model;
      return bedrockJSONResponse();
    });

    const config = loadConfig();
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = () => {
      server.stop();
      closeDB();
      setUpstreamInterceptor(undefined);
      _setTestCredentialProviders(null);
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
        "x-api-key": "test-key",
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

    // The interceptor must have been called with a BEDROCK-shaped body —
    // proof that routing resolved effectiveProtocol === "bedrock" rather than
    // falling through to the native Anthropic path.
    expect(capturedBody).toBeDefined();
    expect(capturedBody?.anthropic_version).toBe("bedrock-2023-05-31");
    // Bedrock body never carries a `stream` field (endpoint controls streaming).
    expect("stream" in (capturedBody ?? {})).toBe(false);
    expect(capturedModel).toBe("claude-3-5-sonnet-20241022");

    // And the client gets the decoded Bedrock response back.
    const text = await resp.text();
    expect(text).toContain("hi from bedrock");

    // The UpstreamSnapshot (single source of truth for workers/warmer/idle,
    // set in postResponse) must ALSO record protocol "bedrock" — postResponse
    // has its own route-usability check that must mirror forwardToUpstream.
    // Poll briefly in case postResponse settles just after the body is read.
    let snapshotProtocol: string | undefined;
    let snapshotUrl: string | undefined;
    for (let i = 0; i < 20; i++) {
      for (const s of getActiveSessions().values()) {
        if (s.lastUpstream?.protocol === "bedrock") {
          snapshotProtocol = s.lastUpstream.protocol;
          snapshotUrl = s.lastUpstream.url;
        }
      }
      if (snapshotProtocol) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(snapshotProtocol).toBe("bedrock");
    expect(snapshotUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
  });
});
