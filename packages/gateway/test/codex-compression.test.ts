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
import { zstdCompressSync } from "node:zlib";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
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
});
