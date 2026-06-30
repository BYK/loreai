/**
 * Wire-level e2e for the #1032 re-compression SCOPING (the distrust branch).
 *
 * The decision unit-tests (http-body.test.ts) lock `mayReencodeUpstream`, but
 * they never exercise the construction of the route context inside
 * `forwardToUpstream` — the exact wiring the adversarial review flagged: a
 * call-site mutation (e.g. passing `req.protocol` instead of `effectiveProtocol`,
 * or the wrong upstream base) fully disables the feature yet ships green, because
 * the only other wire e2e (codex-compression Test 3) is double-trusted
 * (`x-lore-upstream-url` + same protocol).
 *
 * These tests drive a real gateway and capture the ACTUAL bytes written upstream
 * for a model that AUTO-routes (no `x-lore-upstream-url` / `x-lore-provider`
 * override) to a host the client never targeted. Capturing those bytes without
 * `x-lore-upstream-url` (which would force the trusted path) needs the upstream
 * destination — a hardcoded `https://` model-route URL — to resolve in-process.
 * We do that with an undici `MockAgent` injected via `setUpstreamDispatcherForTest`
 * (upstreamFetch passes an explicit dispatcher, so `setGlobalDispatcher` can't
 * intercept it). Fully hermetic: no real network, DNS/hosts, or TLS.
 */
import { describe, it, expect, afterEach } from "vitest";
import { MockAgent } from "undici";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { setUpstreamInterceptor } from "../src/pipeline";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import { makeConversationFixtures } from "./helpers/fixtures";

interface Captured {
  headers: Record<string, string>;
  body: Buffer;
}

function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(String(body ?? ""));
}

describe("upstream re-compression scoping (#1032 follow-up, wire-level)", () => {
  let harness: Harness | undefined;
  let mock: MockAgent | undefined;

  afterEach(async () => {
    setUpstreamDispatcherForTest(null);
    await mock?.close();
    mock = undefined;
    harness?.teardown();
    harness = undefined;
  });

  /**
   * Send a zstd-compressed OpenAI chat-completions request for `model` (which
   * model-prefix routes to `origin`) through a real gateway, and return what the
   * gateway actually wrote to that upstream origin.
   */
  async function forwardZstdChat(
    model: string,
    origin: string,
    marker: string,
  ): Promise<Captured | undefined> {
    let captured: Captured | undefined;

    mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(origin)
      .intercept({ path: () => true, method: "POST" })
      .reply((opts) => {
        captured = {
          headers: (opts.headers ?? {}) as Record<string, string>,
          body: toBuffer(opts.body),
        };
        return {
          statusCode: 200,
          data: JSON.stringify({
            id: "chatcmpl-scope",
            object: "chat.completion",
            created: 0,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .persist();
    setUpstreamDispatcherForTest(mock);

    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: marker, assistantText: "ok" },
      ]),
    });
    // Genuinely forward to the (mocked) upstream so the real upstreamFetch path
    // — and thus the real route-context construction — runs.
    setUpstreamInterceptor((_body, _model, _streaming, makeReal) => makeReal());

    const compressed = zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          model,
          stream: false,
          messages: [{ role: "user", content: marker }],
        }),
      ),
    );
    await fetch(`${harness.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
        authorization: "Bearer test-key",
        "x-lore-project": process.cwd(),
      },
      body: compressed,
    });

    return captured;
  }

  it("forwards UNCOMPRESSED when auto-routing to a different provider host (openai → deepseek)", async () => {
    // deepseek-* model-prefix routes to api.deepseek.com on the SAME (openai)
    // wire protocol — a host the client never targeted. The protocol-only
    // predicate wrongly trusted this; the origin-aware predicate distrusts it.
    const marker = "scope-distrust-marker-9c1f";
    const cap = await forwardZstdChat(
      "deepseek-chat",
      "https://api.deepseek.com",
      marker,
    );

    expect(cap).toBeDefined();
    const c = cap as Captured;
    // No content-encoding replayed to the foreign host.
    expect(c.headers["content-encoding"]).toBeUndefined();
    // The body is genuinely plain JSON (decodes as JSON, contains the marker),
    // NOT zstd.
    const text = c.body.toString("utf8");
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain(marker);
  });

  it("re-compresses (zstd) when forwarding to the client's native provider host (openai → openai)", async () => {
    // gpt-* routes to api.openai.com — the openai ingress's native upstream. A
    // true native passthrough, so the client's zstd encoding is replayed.
    const marker = "scope-trust-marker-4a7e";
    const cap = await forwardZstdChat(
      "gpt-4o",
      "https://api.openai.com",
      marker,
    );

    expect(cap).toBeDefined();
    const c = cap as Captured;
    // The gateway re-applied the client's zstd encoding.
    expect(c.headers["content-encoding"]).toBe("zstd");
    // Raw bytes are genuine zstd (decode back to JSON containing the marker),
    // NOT plain JSON.
    expect(() => JSON.parse(c.body.toString("utf8"))).toThrow();
    expect(zstdDecompressSync(c.body).toString("utf8")).toContain(marker);
  });
});
