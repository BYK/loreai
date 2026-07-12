/**
 * Pipeline context-capability note (system[1]).
 *
 * Verifies that Lore injects a short, STATIC capability note into the stable
 * system block so the agent knows Lore manages the context window and needn't
 * hedge over context-length concerns. The note must be present from turn 1 even
 * with no knowledge/entities, and must be static (no token counts / layer names)
 * so it never busts the cache the way the removed per-turn "Context health" note
 * did (issue #741; see context-health-note.test.ts + cache-stability.e2e).
 *
 * The upstream interceptor captures the built Anthropic request body so the
 * test can assert on the system blocks the gateway actually sends upstream.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_SYSTEM } from "./helpers/fixtures";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  LORE_CONTEXT_CAPABILITY_NOTE,
  setUpstreamInterceptor,
} from "../src/pipeline";

function makeBody(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
  };
}

interface Sink {
  body?: Record<string, unknown>;
}

function captureInterceptor(sink: Sink) {
  return async (requestBody: unknown): Promise<Response> => {
    sink.body = requestBody as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "msg_capture",
        type: "message",
        role: "assistant",
        model: DEFAULT_MODEL,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

describe("context-capability note is static (#741 guardrail)", () => {
  it("carries no per-layer adjective or token count", () => {
    const n = LORE_CONTEXT_CAPABILITY_NOTE;
    expect(n).not.toContain("aggressively compressed");
    expect(n).not.toContain("emergency compressed");
    expect(n).not.toContain("[Context health:");
    // No digits — a token count / layer number would make it vary per turn and
    // bust the frozen system[1] cache.
    expect(/\d/.test(n)).toBe(false);
  });
});

describe("Pipeline — context-capability note injection (system[1])", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("injects the capability note into system[1] on turn 1 with no knowledge", async () => {
    harness = await createHarness({ fixtures: [] });

    const sink: Sink = {};
    setUpstreamInterceptor(captureInterceptor(sink));

    const resp = await harness.chat(makeBody("hello"));
    expect(resp.status).toBe(200);
    await resp.text();

    const sys = JSON.stringify(sink.body?.system ?? "");
    // Present even though no entities/preferences/knowledge were seeded — the
    // note is always-present so the agent sees it from the first turn.
    expect(sys).toContain("effective context is far larger than it looks");
    expect(sys).toContain("take on large, multi-step tasks directly");
  });
});
