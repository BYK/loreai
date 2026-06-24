/**
 * Integration test: recall follow-up on the `openai-codex` (ChatGPT) path.
 *
 * Regression for the bug where the recall follow-up was always issued
 * non-streaming (`runRecallFollowUpJSON` hardcodes `stream: false`). The
 * `openai-codex` provider routes to ChatGPT's `/backend-api/codex/responses`
 * backend, which MANDATES streaming and rejects a non-streaming request with
 * `400 {"detail":"Stream must be set to true"}`. The initial request streams
 * fine (so the model loads and calls `recall` at startup), but the follow-up
 * was forced to `stream: false` and the backend 400'd — surfacing as
 * `[lore] recall follow-up upstream error: 400 {"detail":"Stream must be set
 * to true"}`. The continuation was lost and the conversation stalled right
 * after the first recall.
 *
 * We drive a Codex ingress request (`POST /v1/codex/responses`, Responses wire
 * format) whose upstream interceptor mimics ChatGPT: it returns
 * `400 {"detail":"Stream must be set to true"}` for ANY non-streaming upstream
 * request. The first (streaming) call returns a `recall` function_call; the
 * follow-up must ALSO be streamed (forced by the fix) to get the final answer.
 * We assert the follow-up was streamed and the client received the answer.
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

/** One Responses-API SSE event (`event:` + `data:` framing). */
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
      arguments: JSON.stringify({ query: "decide" }),
    }) +
    sseEvent("response.completed", {
      response: {
        id: "resp_recall",
        model: "gpt-5.5",
        status: "completed",
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
      item: { type: "message" },
    }) +
    sseEvent("response.output_text.done", {
      output_index: 0,
      text: "Here is the answer.",
    }) +
    sseEvent("response.completed", {
      response: {
        id: "resp_final",
        model: "gpt-5.5",
        status: "completed",
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

/** Non-streaming Responses-API JSON with a final text answer. */
function responsesFinalJSON(): Response {
  const body = {
    id: "resp_final",
    model: "gpt-5.5",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Here is the answer." }],
      },
    ],
    usage: { input_tokens: 120, output_tokens: 5 },
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
    await loadLoreConfig(projectDir);

    // Mimic the ChatGPT Codex backend: it ONLY accepts streaming requests.
    // First streaming call → recall tool_use; follow-up (also streamed by the
    // fix) → final text. A non-streaming upstream request always 400s, exactly
    // like the real backend.
    let upstreamCalls = 0;
    let followUpStreamFlag: boolean | undefined;
    setUpstreamInterceptor(async (upstreamBody) => {
      const streaming = (upstreamBody as { stream?: unknown }).stream === true;
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

    const resp = await fetch(`${baseURL}/v1/codex/responses`, {
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

    // The continuation must reach the client — proving the follow-up succeeded
    // instead of falling back to the bare recall marker.
    expect(bodyText).toContain("Here is the answer.");
    // The recall tool_use must NOT leak to the client.
    expect(bodyText).not.toContain('"name":"recall"');
    expect(bodyText).not.toContain('"name": "recall"');
  });

  // Guard the gate direction: the forced-streaming follow-up is keyed on the
  // `codex` flag, NOT the `openai-responses` protocol. The standard OpenAI
  // Responses API (`/v1/responses`) accepts `stream: false`, so its recall
  // follow-up MUST stay on the non-streaming JSON path. This kills any mutation
  // that widens the gate (e.g. "always force streaming" or "force when protocol
  // === openai-responses"), which would needlessly change non-codex behavior.
  test("non-codex openai-responses keeps the non-streaming JSON follow-up", async () => {
    const dbPath = `/tmp/lore-recall-resp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-recall-resp-proj-"));
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
    await loadLoreConfig(projectDir);

    // Initial streaming call → recall tool_use. Follow-up MUST be non-streaming
    // (stream:false) for standard Responses, so we return JSON for it. If the
    // gate were widened to force streaming here, the follow-up would arrive
    // streamed and we'd return SSE — but assertJSONResponse expects JSON, so
    // the followUpStreamFlag assertion below catches the regression directly.
    let upstreamCalls = 0;
    let followUpStreamFlag: boolean | undefined;
    setUpstreamInterceptor(async (upstreamBody) => {
      const streaming = (upstreamBody as { stream?: unknown }).stream === true;
      upstreamCalls++;
      if (upstreamCalls === 1) return codexRecallStream();
      followUpStreamFlag = streaming;
      return responsesFinalJSON();
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

    const resp = await fetch(`${baseURL}/v1/responses`, {
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

    // The follow-up was issued NON-streaming (stream:false) — the standard
    // Responses path is unchanged by the codex fix.
    expect(upstreamCalls).toBe(2);
    expect(followUpStreamFlag).toBe(false);

    // The continuation still reaches the client.
    expect(bodyText).toContain("Here is the answer.");
    expect(bodyText).not.toContain('"name":"recall"');
    expect(bodyText).not.toContain('"name": "recall"');
  });
});
