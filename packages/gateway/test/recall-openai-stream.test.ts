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
import { describe, test, expect, afterEach } from "vitest";
import {
  unlinkSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopbackRequest } from "./helpers/loopback-request";
import { createTestDatabasePath } from "../../core/test/helpers/test-db-path";
import { RECALL_TOOL_NAME } from "../src/recall";

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
                  name: RECALL_TOOL_NAME,
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

let teardownFn: (() => Promise<void>) | undefined;

afterEach(async () => {
  await teardownFn?.();
  teardownFn = undefined;
});

describe("recall interception — OpenAI streaming path", () => {
  test("does not leak recall tool_use to the client", async () => {
    const dbPath = createTestDatabasePath("recall-openai");
    process.env.LORE_DB_PATH = dbPath;
    // Port 0 = OS-assigned ephemeral port; server.port returns the actual
    // bound port. Avoids EADDRINUSE flakes from random-port collisions (#931).
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    // Isolated project dir with query expansion disabled so executeRecall
    // never makes a real LLM call (which would 401/time out in tests).
    const projectDir = mkdtempSync(join(tmpdir(), "lore-recall-proj-"));
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
    // Load the project config (disables query expansion) into the core singleton.
    await loadLoreConfig(projectDir);

    // First upstream call → recall tool_use; follow-up call → final text.
    let call = 0;
    setUpstreamInterceptor(async () => {
      call++;
      return call === 1 ? openAIRecallStream() : openAIFinalJSON();
    });

    const config = loadConfig();
    config.remoteGateway = false;
    config.hostedMode = false;
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = async () => {
      await server.stop();
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

    const resp = await loopbackRequest(`${baseURL}/v1/messages`, {
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
    expect(bodyText).not.toContain(
      `"name":${JSON.stringify(RECALL_TOOL_NAME)}`,
    );
    expect(bodyText).not.toContain(
      `"name": ${JSON.stringify(RECALL_TOOL_NAME)}`,
    );

    // The recall follow-up should have been issued (2 upstream calls).
    expect(call).toBe(2);
  });

  test("expands recall budget on >64K-token OpenAI streaming turn, recovers from parallel follow-up recall, and logs sanitized 400 diagnostics", async () => {
    const dbPath = createTestDatabasePath("recall-openai-large");
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-recall-large-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    const { setUpstreamInterceptor, resetPipelineState } =
      await import("../src/pipeline");
    const { _setModelDataForTest } = await import("../src/worker-model");
    const { startServer } = await import("../src/server");
    const { loadConfig } = await import("../src/config");
    const {
      close: closeDB,
      load: loadLoreConfig,
      log,
    } = await import("@loreai/core");

    closeDB();
    await resetPipelineState();
    await loadLoreConfig(projectDir);
    _setModelDataForTest(
      {
        "gemini-4-argon": {
          id: "gemini-4-argon",
          limit: { context: 1_000_000, output: 32_000 },
        },
      },
      {
        "github-copilot/gemini-4-argon": {
          id: "gemini-4-argon",
          limit: { context: 1_000_000, output: 32_000 },
        },
      },
    );

    const errors: string[] = [];
    log.registerSink({
      info: () => {},
      warn: () => {},
      error: (msg) => errors.push(msg),
      captureException: () => {},
    });

    let call = 0;
    const seenBodies: Array<Record<string, unknown>> = [];
    setUpstreamInterceptor(async (body) => {
      call++;
      seenBodies.push((body ?? {}) as Record<string, unknown>);
      if (call === 1) {
        // Principal streaming turn with 70K input tokens (> 64K half of 128K floor)
        const sseBody =
          sseChunk({
            id: "chatcmpl-p1",
            model: "gemini-4-argon",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_r1",
                      type: "function",
                      function: {
                        name: RECALL_TOOL_NAME,
                        arguments: JSON.stringify({ query: "jenkins" }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }) +
          sseChunk({
            id: "chatcmpl-p1",
            model: "gemini-4-argon",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 70_000, completion_tokens: 50 },
          }) +
          "data: [DONE]\n\n";
        return new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (call === 2) {
        // Follow-up 1 returns parallel recall tool calls (with 72K tokens; 70K + 72K = 142K > 128K)
        return new Response(
          JSON.stringify({
            id: "chatcmpl-f1",
            model: "gemini-4-argon",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_r2a",
                      type: "function",
                      function: {
                        name: RECALL_TOOL_NAME,
                        arguments: JSON.stringify({ query: "a" }),
                      },
                    },
                    {
                      id: "call_r2b",
                      type: "function",
                      function: {
                        name: RECALL_TOOL_NAME,
                        arguments: JSON.stringify({ query: "b" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 72_000, completion_tokens: 40 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Call 3: recovery synthesis request (recall tool removed)
      return new Response(
        JSON.stringify({
          id: "chatcmpl-rec",
          model: "gemini-4-argon",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Recovered answer after parallel follow-up recall.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 73_000, completion_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const config = loadConfig();
    config.remoteGateway = false;
    config.hostedMode = false;
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = async () => {
      await server.stop();
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

    const resp = await loopbackRequest(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-lore-provider": "github-copilot",
        "x-lore-agent": "coder",
        "x-lore-project": projectDir,
      },
      body: JSON.stringify({
        model: "gemini-4-argon",
        max_tokens: 1024,
        stream: true,
        stream_options: { include_usage: true },
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "read a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        messages: [{ role: "user", content: "how does jenkins work?" }],
      }),
    });

    expect(resp.status).toBe(200);
    const bodyText = await resp.text();
    expect(bodyText).toContain("Recovered ");
    expect(bodyText).toContain("answer aft");
    expect(call).toBe(3);
    // Principal stream request forwards stream_options; non-stream follow-up and recovery omit it.
    expect(seenBodies[0]?.stream).toBe(true);
    expect(seenBodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(seenBodies[1]?.stream).toBe(false);
    expect(seenBodies[1]?.stream_options).toBeUndefined();
    expect(seenBodies[2]?.stream).toBe(false);
    expect(seenBodies[2]?.stream_options).toBeUndefined();

    // Verify sanitized 400 diagnostic logging on follow-up error without leaking raw body
    setUpstreamInterceptor(async () => {
      call++;
      if (call === 4) {
        const sseBody =
          sseChunk({
            id: "chatcmpl-p2",
            model: "gemini-4-argon",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_r4",
                      type: "function",
                      function: {
                        name: RECALL_TOOL_NAME,
                        arguments: JSON.stringify({ query: "deploy" }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }) +
          sseChunk({
            id: "chatcmpl-p2",
            model: "gemini-4-argon",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 70_000, completion_tokens: 50 },
          }) +
          "data: [DONE]\n\n";
        return new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (call === 5) {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_request_body",
              message: "PRIVATE_SECRET stream_options: unknown field",
              param: "stream_options",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-rec2",
          model: "gemini-4-argon",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Recovered from 400." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 71_000, completion_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const resp2 = await loopbackRequest(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-lore-provider": "github-copilot",
        "x-lore-agent": "coder",
        "x-lore-project": projectDir,
      },
      body: JSON.stringify({
        model: "gemini-4-argon",
        max_tokens: 1024,
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "read a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        messages: [{ role: "user", content: "how does deploy work?" }],
      }),
    });

    expect(resp2.status).toBe(502);
    expect(errors).toContain(
      "recall follow-up upstream error: 400 (body=json code=invalid_request_body hints=none message=string param=stream_options fields=stream_options checks=unknown_field)",
    );
    expect(errors.join("\n")).not.toContain("PRIVATE_SECRET");
  });
});
