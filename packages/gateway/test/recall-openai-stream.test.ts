/**
 * Integration test: recall interception on the OpenAI-protocol STREAMING path.
 *
 * Regression for the bug where OpenAI / openai-responses streaming responses
 * bypassed the recall interception loop (the dispatch returned early via
 * nonStreamHttpResponse before the loop ran). A gateway-injected `recall`
 * tool_use therefore leaked straight to the client, which rejected it with
 * "Model tried to call unavailable tool 'recall'".
 *
 * We drive the pipeline with an Anthropic-format client request whose model
 * (`gpt-4o`) routes the UPSTREAM to the OpenAI protocol. The upstream
 * interceptor returns OpenAI-format SSE: the first call emits a `recall`
 * tool_use, the follow-up returns a final text answer. We assert the
 * client-facing response contains NO `recall` tool_use block.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  unlinkSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SSE chunk for OpenAI chat-completions streaming.
function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function openAIRecallStream(): Response {
  const body =
    sseChunk({
      id: "chatcmpl-recall",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_recall1",
                type: "function",
                function: {
                  name: "recall",
                  arguments: JSON.stringify({ query: "test" }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    sseChunk({
      id: "chatcmpl-recall",
      model: "gpt-4o",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }) +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// The recall follow-up request is issued non-streaming, so the gateway parses
// the upstream body as OpenAI JSON (not SSE).
function openAIFinalJSON(): Response {
  const body = {
    id: "chatcmpl-final",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Here is the answer." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 5 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let teardownFn: (() => void) | undefined;

afterEach(() => {
  teardownFn?.();
  teardownFn = undefined;
});

describe("recall interception — OpenAI streaming path", () => {
  test("does not leak recall tool_use to the client", async () => {
    const dbPath = `/tmp/lore-recall-openai-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = String(
      20000 + Math.floor(Math.random() * 30000),
    );
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    // Isolated project dir with query expansion disabled so executeRecall
    // never makes a real LLM call (which would 401/time out in tests).
    const projectDir = mkdtempSync(join(tmpdir(), "lore-recall-proj-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    const { setUpstreamInterceptor, resetPipelineState } = await import(
      "../src/pipeline"
    );
    const { startServer } = await import("../src/server");
    const { loadConfig } = await import("../src/config");
    const { close: closeDB, load: loadLoreConfig } = await import(
      "@loreai/core"
    );

    closeDB();
    await resetPipelineState();
    // Load the project config (disables query expansion) into the core singleton.
    await loadLoreConfig(projectDir);

    // First upstream call → recall tool_use; follow-up call → final text.
    let call = 0;
    setUpstreamInterceptor(async () => {
      call++;
      return call === 1 ? openAIRecallStream() : openAIFinalJSON();
    });

    const config = loadConfig();
    const server = startServer(config);
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
        // Force a primary (conversation) turn so recall injection/interception
        // runs — without this the small request is treated as a meta request.
        "x-lore-agent": "coder",
        "x-lore-project": projectDir,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1024,
        stream: true,
        // Non-empty tools so the gateway injects the recall tool.
        tools: [
          {
            name: "read",
            description: "read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        messages: [{ role: "user", content: "what did we decide?" }],
      }),
    });

    expect(resp.ok).toBe(true);
    const bodyText = await resp.text();

    // The recall tool_use must NOT appear in the client-facing response.
    expect(bodyText).not.toContain('"name":"recall"');
    expect(bodyText).not.toContain('"name": "recall"');

    // The recall follow-up should have been issued (2 upstream calls).
    expect(call).toBe(2);
  });
});
