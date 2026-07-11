/**
 * Integration test: an Anthropic-protocol client that requests `stream: true`
 * whose UPSTREAM speaks OpenAI (e.g. GitHub Copilot serving a Claude model via
 * OpenCode's Anthropic SDK, #1052).
 *
 * Non-Anthropic upstreams (OpenAI / Responses / Gemini) are BUFFERED — the
 * gateway accumulates the full response, then re-emits it in the client's wire
 * format. The bug: for an Anthropic client the re-emission returned a
 * NON-STREAMING JSON body even when the client had opened the request with
 * `stream: true`. The client's SDK sat waiting for an SSE stream it never got,
 * so the response "reached the gateway but never made it to the UI".
 *
 * We drive an Anthropic `/v1/messages` request (stream:true) with a model
 * (`gpt-4o`) that routes the upstream to the OpenAI protocol, and an upstream
 * interceptor returning OpenAI SSE (with Copilot's empty-`choices` preamble
 * chunk, plus a text delta AND a tool_call). We assert the CLIENT response is
 * `text/event-stream` (not `application/json`) and preserves both the text and
 * the tool_use.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// Copilot-style OpenAI chat-completions SSE: an Azure content-filter preamble
// with EMPTY choices, a role chunk, a text delta, a tool_call, then a
// finish chunk with usage.
function openAICopilotStream(): Response {
  const body =
    sseChunk({
      id: "chatcmpl-cop",
      model: "gpt-4o",
      choices: [],
      prompt_filter_results: [],
    }) +
    sseChunk({
      id: "chatcmpl-cop",
      model: "gpt-4o",
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    }) +
    sseChunk({
      id: "chatcmpl-cop",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: { content: "Reading the file." },
          finish_reason: null,
        },
      ],
    }) +
    sseChunk({
      id: "chatcmpl-cop",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_read1",
                type: "function",
                function: { name: "read", arguments: '{"path":"a.txt"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    sseChunk({
      id: "chatcmpl-cop",
      model: "gpt-4o",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 50, completion_tokens: 8 },
    }) +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

let teardownFn: (() => void) | undefined;

afterEach(() => {
  teardownFn?.();
  teardownFn = undefined;
});

describe("Anthropic client + OpenAI upstream (streaming re-emission, #1052)", () => {
  test("re-emits a buffered OpenAI upstream as an Anthropic SSE stream (not JSON)", async () => {
    const dbPath = `/tmp/lore-anthropic-openai-stream-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    // Query expansion off so recall never makes a real LLM call.
    const projectDir = mkdtempSync(join(tmpdir(), "lore-ao-stream-proj-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    const { setUpstreamInterceptor, resetPipelineState } =
      await import("../src/pipeline");
    const { startServer } = await import("../src/server");
    const { loadConfig } = await import("../src/config");
    const { close: closeDB, load: loadLoreConfig } =
      await import("@loreai/core");

    closeDB();
    await resetPipelineState();
    await loadLoreConfig(projectDir);

    setUpstreamInterceptor(async () => openAICopilotStream());

    const config = loadConfig();
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = () => {
      server.stop();
      closeDB();
      setUpstreamInterceptor(undefined);
      for (const suffix of ["", "-shm", "-wal"]) {
        const f = `${dbPath}${suffix}`;
        try {
          if (existsSync(f)) unlinkSync(f);
        } catch {
          // best-effort
        }
      }
      try {
        rmSync(projectDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };

    const resp = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        // Force a primary (conversation) turn — otherwise the small request is
        // treated as a meta request and takes the passthrough path.
        "x-lore-agent": "coder",
        "x-lore-project": projectDir,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1024,
        stream: true,
        tools: [
          {
            name: "read",
            description: "read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        messages: [{ role: "user", content: "read a.txt please" }],
      }),
    });

    expect(resp.ok).toBe(true);

    // THE FIX: a stream:true Anthropic client must get an SSE stream, never a
    // non-streaming JSON body (which left OpenCode's SDK hanging with no output).
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const sse = await resp.text();
    // Well-formed Anthropic streaming lifecycle.
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("event: message_stop");
    // The assistant text survived the OpenAI→Anthropic re-emission…
    expect(sse).toContain("Reading the file.");
    // …and so did the tool_use (a text-only synthesis would have dropped it,
    // breaking the coding agent's turn).
    expect(sse).toContain('"name":"read"');
    expect(sse).toContain("a.txt");
  });
});
