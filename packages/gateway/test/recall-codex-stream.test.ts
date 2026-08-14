/**
 * Integration test: recall follow-up on the `openai-responses` streaming path
 * (including the `openai-codex` / ChatGPT case).
 *
 * The recall follow-up is issued STREAMING (`stream: true`) for all
 * `openai-responses` clients. This unifies two requirements:
 *  - `openai-codex` (ChatGPT) MANDATES streaming: its
 *    `/backend-api/codex/responses` backend rejects a non-streaming request
 *    with `400 {"detail":"Stream must be set to true"}`.
 *  - The true-streaming resume avoids the header-timeout hang on slow
 *    reasoning-heavy upstreams (opencode's 10s `ProviderHeaderTimeoutError`):
 *    a *buffered* `stream:false` follow-up re-introduces the wait.
 *
 * We drive a Codex ingress request (`POST /v1/codex/responses`, Responses wire
 * format) whose upstream interceptor mimics ChatGPT: it returns
 * `400 {"detail":"Stream must be set to true"}` for ANY non-streaming upstream
 * request. The first (streaming) call returns a `recall` function_call; the
 * follow-up must ALSO be streamed to get the final answer. A second test
 * drives the standard `/v1/responses` path and asserts its follow-up is also
 * streamed (unified behavior).
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

/** One Responses-API SSE event (`event:` + `data:` framing). */
function sseEvent(event: string, data: unknown): string {
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? { type: event, ...(data as Record<string, unknown>) }
      : data;
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Responses SSE stream emitting a single `recall` function_call. */
function codexRecallStream(): Response {
  const body =
    sseEvent("response.created", {
      response: { id: "resp_recall", model: "gpt-5.5" },
    }) +
    sseEvent("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_recall",
        call_id: "call_recall1",
        name: "recall",
      },
    }) +
    sseEvent("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_recall",
      arguments: JSON.stringify({ query: "decide" }),
    }) +
    sseEvent("response.output_item.done", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_recall",
        call_id: "call_recall1",
        name: "recall",
        arguments: JSON.stringify({ query: "decide" }),
        status: "completed",
      },
    }) +
    sseEvent("response.completed", {
      response: {
        id: "resp_recall",
        model: "gpt-5.5",
        status: "completed",
        // ChatGPT may replace streamed items with terminal references. The
        // output_item lifecycle above is the authoritative response content.
        output: [{ type: "item_reference", id: "fc_recall" }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    }) +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Responses SSE stream emitting a final text answer. */
function codexFinalStream(): Response {
  const body =
    sseEvent("response.created", {
      response: { id: "resp_final", model: "gpt-5.5" },
    }) +
    sseEvent("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: "msg_final", role: "assistant" },
    }) +
    sseEvent("response.output_text.done", {
      output_index: 0,
      item_id: "msg_final",
      content_index: 0,
      text: "Here is the answer.",
    }) +
    sseEvent("response.output_item.done", {
      output_index: 0,
      item: {
        type: "message",
        id: "msg_final",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Here is the answer." }],
      },
    }) +
    sseEvent("response.completed", {
      response: {
        id: "resp_final",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "item_reference", id: "msg_final" }],
        usage: { input_tokens: 120, output_tokens: 5 },
      },
    }) +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Mimic ChatGPT's backend rejecting a non-streaming request. */
function codexStreamRequiredError(): Response {
  return new Response(
    JSON.stringify({ detail: "Stream must be set to true" }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    },
  );
}

let teardownFn: (() => void) | undefined;

afterEach(() => {
  teardownFn?.();
  teardownFn = undefined;
});

describe("recall follow-up — openai-codex (ChatGPT) path", () => {
  test("forces the follow-up to stream so ChatGPT does not 400", async () => {
    const dbPath = `/tmp/lore-recall-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    // Port 0 = OS-assigned ephemeral port (avoids EADDRINUSE flakes, #931).
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    // Isolated project dir with query expansion disabled so executeRecall
    // never makes a real LLM call (which would 401/time out in tests).
    const projectDir = mkdtempSync(join(tmpdir(), "lore-recall-codex-proj-"));
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

    // Mimic the ChatGPT Codex backend: it ONLY accepts streaming requests.
    // First streaming call → recall tool_use; follow-up (also streamed by the
    // fix) → final text. A non-streaming upstream request always 400s, exactly
    // like the real backend.
    let upstreamCalls = 0;
    let followUpStreamFlag: boolean | undefined;
    const parallelToolCallFlags: unknown[] = [];
    setUpstreamInterceptor(async (upstreamBody) => {
      const body = upstreamBody as {
        stream?: unknown;
        parallel_tool_calls?: unknown;
      };
      const streaming = body.stream === true;
      parallelToolCallFlags.push(body.parallel_tool_calls);
      upstreamCalls++;
      if (upstreamCalls === 1) {
        // Initial request — Pi's codex provider always streams.
        return streaming ? codexRecallStream() : codexStreamRequiredError();
      }
      // Recall follow-up — record the stream flag the gateway sent upstream.
      followUpStreamFlag = streaming;
      return streaming ? codexFinalStream() : codexStreamRequiredError();
    });

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

    const resp = await loopbackRequest(`${baseURL}/v1/codex/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
        // Force a primary (conversation) turn so recall injection/interception
        // runs — without this the small request is treated as a meta request.
        "x-lore-agent": "coder",
        "x-lore-project": projectDir,
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        parallel_tool_calls: true,
        input: "what did we decide?",
        // Non-empty tools so the gateway injects the recall tool.
        tools: [
          {
            type: "function",
            name: "read",
            description: "read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });

    expect(resp.ok).toBe(true);
    const bodyText = await resp.text();

    // The follow-up must have been issued AND streamed (the fix). Pre-fix it
    // was sent with stream:false and ChatGPT 400'd.
    expect(upstreamCalls).toBe(2);
    expect(followUpStreamFlag).toBe(true);
    expect(parallelToolCallFlags).toEqual([false, false]);

    // The continuation must reach the client — proving the follow-up succeeded
    // instead of falling back to the bare recall marker.
    expect(bodyText).toContain("Here is the answer.");
    // The recall tool_use must NOT leak to the client.
    expect(bodyText).not.toContain('"name":"recall"');
    expect(bodyText).not.toContain('"name": "recall"');

    const requestWithoutTools = async (
      path: "/v1/codex/responses" | "/v1/responses",
      upstream: Response,
    ): Promise<string> => {
      setUpstreamInterceptor(async () => upstream);
      const response = await loopbackRequest(`${baseURL}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-lore-agent": "coder",
          "x-lore-project": projectDir,
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: true,
          input: "plain",
        }),
      });
      return response.text();
    };
    const sparse = new Response(
      sseEvent("response.output_item.added", {
        item: { type: "message", id: "msg_sparse_real" },
      }) +
        sseEvent("response.output_text.done", {
          item_id: "msg_sparse_real",
          text: "sparse real caller",
        }) +
        sseEvent("response.output_item.done", {
          item: {
            type: "message",
            id: "msg_sparse_real",
            content: [{ type: "output_text", text: "sparse real caller" }],
          },
        }) +
        sseEvent("response.completed", {
          response: {
            status: "completed",
            output: [{ type: "item_reference", id: "msg_sparse_real" }],
          },
        }),
    );
    const sparseCodex = await requestWithoutTools(
      "/v1/codex/responses",
      sparse,
    );
    expect(sparseCodex).toContain("sparse real caller");
    expect(sparseCodex).not.toContain("server_error");

    const sparsePublic = await requestWithoutTools(
      "/v1/responses",
      new Response(
        sseEvent("response.output_item.added", {
          item: { type: "message", id: "public-mismatch" },
        }),
      ),
    );
    expect(sparsePublic).not.toContain("public-mismatch");
    expect(sparsePublic).toContain("response.failed");

    const malformed = await requestWithoutTools(
      "/v1/codex/responses",
      new Response("event: response.created\ndata: {bad}\n\n"),
    );
    expect(malformed).not.toContain("{bad}");
    expect(malformed).toContain("response.failed");

    const duplicate = await requestWithoutTools(
      "/v1/codex/responses",
      new Response(
        sseEvent("response.output_item.added", {
          item: {
            type: "function_call",
            id: "one",
            call_id: "duplicate",
            name: "one",
            arguments: "{}",
          },
        }) +
          sseEvent("response.output_item.added", {
            item: {
              type: "function_call",
              id: "two",
              call_id: "duplicate",
              name: "two",
              arguments: "{}",
            },
          }),
      ),
    );
    expect(duplicate).toContain('"id":"one"');
    expect(duplicate).not.toContain('"id":"two"');
    expect(duplicate).toContain("response.failed");

    const failure = await requestWithoutTools(
      "/v1/codex/responses",
      new Response(
        sseEvent("response.failed", {
          response: {
            status: "failed",
            error: { type: "server_error", message: "provider terminal" },
          },
        }),
      ),
    );
    expect(failure.match(/event: response\.failed/g)).toHaveLength(1);
    expect(failure).toContain("provider terminal");
  });

  test("non-codex openai-responses also streams the follow-up", async () => {
    const dbPath = `/tmp/lore-recall-resp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-recall-resp-proj-"));
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

    // Initial streaming call → recall tool_use. Follow-up is ALSO streamed for
    // standard Responses (unified streaming resume — fixes the header-timeout
    // hang on slow reasoning-heavy upstreams), so we return an SSE stream for
    // it. The standard Responses API accepts stream:true; only ChatGPT's codex
    // backend MANDATES it, but the unified behavior is identical from the
    // client's perspective.
    let upstreamCalls = 0;
    let followUpStreamFlag: boolean | undefined;
    const parallelToolCallFlags: unknown[] = [];
    setUpstreamInterceptor(async (upstreamBody) => {
      const body = upstreamBody as {
        stream?: unknown;
        parallel_tool_calls?: unknown;
      };
      const streaming = body.stream === true;
      parallelToolCallFlags.push(body.parallel_tool_calls);
      upstreamCalls++;
      if (upstreamCalls === 1) return codexRecallStream();
      followUpStreamFlag = streaming;
      return codexFinalStream();
    });

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

    const resp = await loopbackRequest(`${baseURL}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
        "x-lore-agent": "coder",
        "x-lore-project": projectDir,
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        parallel_tool_calls: true,
        input: "what did we decide?",
        tools: [
          {
            type: "function",
            name: "read",
            description: "read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });

    expect(resp.ok).toBe(true);
    const bodyText = await resp.text();

    // The follow-up was ALSO issued streaming — standard Responses now uses
    // the same streaming resume as codex (unified behavior; the client sees an
    // identical continuation either way).
    expect(upstreamCalls).toBe(2);
    expect(followUpStreamFlag).toBe(true);
    expect(parallelToolCallFlags).toEqual([false, false]);

    // The continuation still reaches the client.
    expect(bodyText).toContain("Here is the answer.");
    expect(bodyText).not.toContain('"name":"recall"');
    expect(bodyText).not.toContain('"name": "recall"');
  });
});
