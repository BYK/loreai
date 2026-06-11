/**
 * Pipeline streaming-response coverage (Anthropic conversation turns).
 *
 * The harness's replay interceptor now emits Anthropic SSE for streaming
 * requests (see test/helpers/replay.ts), so a `stream: true` turn exercises
 * the streaming path end-to-end: buildStreamingResponse parses the upstream
 * SSE, forwards it to the client, and accumulates in parallel for
 * postResponse storage.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import type { FixtureEntry } from "../src/recorder";
import {
  makeConversationFixtures,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";

function makeStreamBody(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: true,
    system: DEFAULT_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: STANDARD_TOOLS,
  };
}

async function readSSE(resp: Response): Promise<string> {
  return resp.text();
}

describe("Pipeline — streaming responses", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("streams an Anthropic SSE response containing the assistant text", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "Stream please", assistantText: "Streamed answer." },
      ]),
    });

    const resp = await harness.chat(makeStreamBody("Stream please"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const sse = await readSSE(resp);
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("event: content_block_delta");
    expect(sse).toContain("Streamed answer.");
    expect(sse).toContain("event: message_stop");
  });

  it("persists the streamed turn to temporal storage", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "Persist this stream", assistantText: "Done." },
      ]),
    });

    const resp = await harness.chat(makeStreamBody("Persist this stream"));
    expect(resp.status).toBe(200);
    // Drain the stream so postResponse runs.
    await readSSE(resp);
    await new Promise((r) => setTimeout(r, 200));

    const rows = harness.queryDB<{ n: number }>(
      "SELECT COUNT(*) as n FROM temporal_messages WHERE role='assistant'",
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("streams a tool_use response (text + tool_use blocks)", async () => {
    const toolFixture: FixtureEntry = {
      seq: 0,
      ts: Date.now(),
      request: {},
      response: {
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: DEFAULT_MODEL,
        content: [
          { type: "text", text: "Running it now." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "ls -la" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 8 },
      },
      wasStreaming: false,
      model: DEFAULT_MODEL,
    };

    harness = await createHarness({ fixtures: [toolFixture] });

    const resp = await harness.chat(makeStreamBody("List files"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const sse = await readSSE(resp);
    expect(sse).toContain("Running it now.");
    expect(sse).toContain('"type":"tool_use"');
    expect(sse).toContain('"name":"bash"');
    expect(sse).toContain("ls -la");
    expect(sse).toContain("event: message_stop");
  });
});
