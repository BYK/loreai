/**
 * End-to-end regression for issue #1032.
 *
 * Codex (and any client) may zstd-compress request bodies (`Content-Encoding:
 * zstd`). Before the fix the gateway read the raw compressed bytes and returned
 * `400 "Invalid JSON body"` on every turn. These tests drive a real gateway
 * (isolated harness + replay interceptor) with a compressed body and assert the
 * body is decoded, runs the full pipeline, and the decoded content is forwarded
 * upstream.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { setUpstreamInterceptor } from "../src/pipeline";
import {
  makeConversationFixtures,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";

function anthropicBody(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: STANDARD_TOOLS,
  };
}

describe("zstd-compressed request bodies (issue #1032)", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("decodes a zstd /v1/messages body through the full pipeline and forwards the decoded content", async () => {
    const marker = "What is the zstd capital of France?";
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: marker, assistantText: "Paris is the answer." },
      ]),
    });

    const compressed = zstdCompressSync(
      Buffer.from(JSON.stringify(anthropicBody(marker))),
    );
    const resp = await fetch(`${harness.baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "x-lore-project": process.cwd(),
      },
      body: compressed,
    });

    // Decoded + parsed + ran the full pipeline → normal 200 (NOT the 400
    // "Invalid JSON body" the compressed bytes used to produce).
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toContain("Paris");

    // The decoded user message actually reached the upstream forwarding path.
    const upstream = harness.upstreamBodies();
    expect(upstream.length).toBe(1);
    expect(upstream[0]).toContain(marker);
  });

  it("does not reject a zstd /v1/responses body (the Codex path) as Invalid JSON", async () => {
    const marker = "zstd-responses-marker-abc123";
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: marker, assistantText: "acknowledged." },
      ]),
    });

    const responsesBody = {
      model: "gpt-5-codex",
      stream: false,
      instructions: DEFAULT_SYSTEM,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: marker }],
        },
      ],
      tools: [],
    };
    const compressed = zstdCompressSync(
      Buffer.from(JSON.stringify(responsesBody)),
    );
    const resp = await fetch(`${harness.baseURL}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
        authorization: "Bearer test-key",
        "x-lore-project": process.cwd(),
      },
      body: compressed,
    });

    // Decode succeeded → never the parse-failure 400. (Response translation of
    // the synthetic fixture may differ, but it is never the invalid-JSON path.)
    expect(resp.status).not.toBe(400);

    // The decoded body reached the upstream forwarding path with its content.
    const upstream = harness.upstreamBodies();
    expect(upstream.length).toBe(1);
    expect(upstream[0]).toContain(marker);
  });

  it("re-compresses the transformed body with the client's Content-Encoding before forwarding upstream", async () => {
    // The replay interceptor short-circuits before `makeReal()`, so it never
    // exercises the bytes actually written to the wire. Stand up a real mock
    // upstream, route the gateway at it via `x-lore-upstream-url`, and override
    // the interceptor to genuinely call `makeReal()` — then inspect what the
    // upstream received: zstd-compressed bytes plus a matching
    // `content-encoding` header (NOT the uncompressed JSON). This is the guard
    // for the re-compression wiring in `forwardToUpstream`.
    const marker = "recompress-upstream-marker-7f3a";
    let captured: { encoding: string | undefined; raw: Buffer } | undefined;
    const upstream: Server = await new Promise((resolve) => {
      const s = createServer((r, res) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => {
          captured = {
            encoding: r.headers["content-encoding"] as string | undefined,
            raw: Buffer.concat(chunks),
          };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "msg_recompress",
              type: "message",
              role: "assistant",
              model: DEFAULT_MODEL,
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
        });
      });
      s.listen(0, () => resolve(s));
    });
    const upstreamPort = (upstream.address() as { port: number }).port;

    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: marker, assistantText: "ok" },
      ]),
    });
    // Replace the harness replay interceptor with one that actually forwards to
    // the (mock) upstream, so the real `upstreamFetch(body)` path runs.
    setUpstreamInterceptor((_body, _model, _streaming, makeReal) => makeReal());

    const compressed = zstdCompressSync(
      Buffer.from(JSON.stringify(anthropicBody(marker))),
    );
    try {
      await fetch(`${harness.baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "zstd",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
          "x-lore-project": process.cwd(),
          "x-lore-upstream-url": `http://127.0.0.1:${upstreamPort}`,
        },
        body: compressed,
      });

      expect(captured).toBeDefined();
      const cap = captured as { encoding: string | undefined; raw: Buffer };
      // Gateway re-applied the client's zstd encoding to the upstream request.
      expect(cap.encoding).toBe("zstd");
      // The upstream body is genuinely zstd (decodes back to the transformed
      // request containing the marker) — not the uncompressed JSON string.
      const decoded = zstdDecompressSync(cap.raw).toString("utf8");
      expect(decoded).toContain(marker);
      // Belt-and-suspenders: the raw bytes are NOT plain JSON.
      expect(() => JSON.parse(cap.raw.toString("utf8"))).toThrow();
    } finally {
      upstream.close();
    }
  });
});
