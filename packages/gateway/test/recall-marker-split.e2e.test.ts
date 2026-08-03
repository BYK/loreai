/**
 * End-to-end tests for the streaming recall marker emission seam
 * (`buildStreamingResponse`'s `clientSpeaksAnthropic` gate).
 *
 * Drives the full HTTP path: the upstream interceptor returns an Anthropic
 * SSE stream that calls `recall`, the gateway intercepts the call, and we
 * assert the bytes the client receives.
 *
 * Two protocols are exercised:
 *   1. Anthropic native (`req.protocol === "anthropic"`) — the marker is an
 *      inline text block inside the single legal message envelope.
 *   2. OpenAI Chat Completions (`req.protocol === "openai"`) — the marker
 *      is emitted as an inline synthetic `content_block_start`/`delta`/`stop`
 *      triple in the Anthropic SSE, which the OpenAI translator forwards as
 *      a `delta.content` chunk.
 *
 * Why this file exists: the previous round of unit tests for
 * `buildSSEMarkerMessage` (recall-stream.test.ts) exercised the helper in
 * isolation but NEVER drove the `clientSpeaksAnthropic` gate at the actual
 * emission seam — leaving 4 mutations (gate deletion, prefix rename, marker
 * drop, offset regression) all undetected. This file pins each of them.
 */
import { describe, test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers: build Anthropic SSE events for fixtures
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Anthropic SSE upstream stream: preamble text + recall tool_use. */
function anthropicRecallStream(query: string): Response {
  const body =
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_upstream_001",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-20250514",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Let me search memory first." },
    }) +
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_recall_001",
        name: "recall",
        input: {},
      },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ query }),
      },
    }) +
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 1,
    }) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    sseEvent("message_stop", { type: "message_stop" });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Anthropic SSE continuation: a final text answer. */
function anthropicFinalStream(text: string): Response {
  const body =
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_final_001",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-20250514",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }) +
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    sseEvent("message_stop", { type: "message_stop" });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let teardownFn: (() => void) | undefined;

afterEach(() => {
  teardownFn?.();
  teardownFn = undefined;
});

async function spinUpGateway(projectDir: string) {
  const { setUpstreamInterceptor, resetPipelineState } =
    await import("../src/pipeline");
  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  const { close: closeDB, load: loadLoreConfig } = await import("@loreai/core");

  closeDB();
  await resetPipelineState();
  // Disable query expansion so executeRecall never makes a real LLM call.
  await loadLoreConfig(projectDir);

  const config = loadConfig();
  const server = await startServer(config);
  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    setUpstreamInterceptor,
    server,
    closeDB,
  };
}

function teardownAll(
  dbPath: string,
  projectDir: string,
  server: { stop: () => void },
  closeDB: () => void,
  setUpstreamInterceptor: (i: undefined) => void,
) {
  server.stop();
  closeDB();
  setUpstreamInterceptor(undefined);
  for (const suffix of ["", "-shm", "-wal"]) {
    const f = `${dbPath}${suffix}`;
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* best-effort */
    }
  }
  try {
    rmSync(projectDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Streaming recall marker — Anthropic native (single envelope)", () => {
  test("keeps the marker inline and suppresses continuation message_start", async () => {
    const dbPath = `/tmp/lore-marker-split-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-marker-split-proj-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    let call = 0;
    const { baseURL, setUpstreamInterceptor, server, closeDB } =
      await spinUpGateway(projectDir);
    setUpstreamInterceptor(async () => {
      call++;
      return call === 1
        ? anthropicRecallStream("patterns")
        : anthropicFinalStream("Based on the search: pattern X.");
    });

    teardownFn = () =>
      teardownAll(dbPath, projectDir, server, closeDB, setUpstreamInterceptor);

    const resp = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "x-lore-project": projectDir,
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        stream: true,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "What patterns?" }],
        tools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      }),
    });

    expect(resp.ok).toBe(true);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const sse = await resp.text();

    // The upstream preamble's message_start is preserved.
    expect(sse).toMatch(/"id":"msg_upstream_001"/);

    // The marker text appears in the SSE.
    expect(sse).toContain("Searching");

    // Two upstream calls — recall interception ran (follow-up was issued).
    expect(call).toBe(2);

    // Anthropic Messages permits exactly one response envelope. Pi rejects a
    // continuation message_start before the original message_stop (#1211).
    const startCount = (sse.match(/^event: message_start/gm) ?? []).length;
    const stopCount = (sse.match(/^event: message_stop/gm) ?? []).length;
    expect(startCount).toBe(1);
    expect(stopCount).toBe(1);
  });

  test("marker is positioned after the preamble text inside its envelope", async () => {
    const dbPath = `/tmp/lore-marker-split-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-marker-split-proj-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    let call = 0;
    const { baseURL, setUpstreamInterceptor, server, closeDB } =
      await spinUpGateway(projectDir);
    setUpstreamInterceptor(async () => {
      call++;
      return call === 1
        ? anthropicRecallStream("patterns")
        : anthropicFinalStream("Based on the search: pattern X.");
    });

    teardownFn = () =>
      teardownAll(dbPath, projectDir, server, closeDB, setUpstreamInterceptor);

    const resp = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "x-lore-project": projectDir,
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        stream: true,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "What patterns?" }],
        tools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      }),
    });

    const sse = await resp.text();

    // Position order: preamble text < inline marker < final continuation.
    const preamblePos = sse.indexOf("Let me search memory first.");
    const markerPos = sse.indexOf("Searching");
    expect(preamblePos).toBeGreaterThan(-1);
    expect(markerPos).toBeGreaterThan(preamblePos);
  });

  test("SSE event order: every message_start is closed by a message_stop before the next message_start", async () => {
    const dbPath = `/tmp/lore-marker-split-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-marker-split-proj-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    let call = 0;
    const { baseURL, setUpstreamInterceptor, server, closeDB } =
      await spinUpGateway(projectDir);
    setUpstreamInterceptor(async () => {
      call++;
      return call === 1
        ? anthropicRecallStream("patterns")
        : anthropicFinalStream("Based on the search: pattern X.");
    });

    teardownFn = () =>
      teardownAll(dbPath, projectDir, server, closeDB, setUpstreamInterceptor);

    const resp = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "x-lore-project": projectDir,
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        stream: true,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "What patterns?" }],
        tools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      }),
    });

    expect(resp.ok).toBe(true);
    const sse = await resp.text();

    // Parse SSE events by tracking the POSITION of each message_start and
    // message_stop. For each message_start at position p, the next
    // message_stop must fall strictly between p and the next message_start
    // (or end-of-stream). This catches three classes of wire-contract
    // violations:
    //   1. The original envelope never closes before the marker envelope
    //      opens (held-back ordering bug).
    //   2. A message_stop arrives with no preceding open message_start
    //      (dangling close).
    //   3. The same message_stop is emitted twice (double emission from
    //      non-consuming heldBackEvents()).
    const eventOrder: string[] = [];
    for (const line of sse.split("\n")) {
      if (line.startsWith("event: ")) {
        eventOrder.push(line.slice(7).trim());
      }
    }

    const messageStartPositions: number[] = [];
    for (let i = 0; i < eventOrder.length; i++) {
      if (eventOrder[i] === "message_start") {
        messageStartPositions.push(i);
      }
    }
    const messageStopPositions: number[] = [];
    for (let i = 0; i < eventOrder.length; i++) {
      if (eventOrder[i] === "message_stop") {
        messageStopPositions.push(i);
      }
    }

    // Balance check: the response is one Anthropic message envelope.
    expect(messageStartPositions.length).toBe(messageStopPositions.length);
    expect(messageStartPositions.length).toBe(1);

    // The only response envelope has one terminal message_stop.
    for (let i = 0; i < messageStartPositions.length; i++) {
      const start = messageStartPositions[i];
      const nextStart = messageStartPositions[i + 1] ?? eventOrder.length;
      const stopsInRange = messageStopPositions.filter(
        (p) => p >= start && p < nextStart,
      ).length;
      expect(stopsInRange).toBe(1);
    }
  });
});

describe("Streaming recall marker — non-Anthropic (inline + translated)", () => {
  test("OpenAI Chat Completions client receives marker as a delta.content chunk", async () => {
    const dbPath = `/tmp/lore-marker-split-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-marker-split-proj-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    let call = 0;
    const { baseURL, setUpstreamInterceptor, server, closeDB } =
      await spinUpGateway(projectDir);
    setUpstreamInterceptor(async () => {
      call++;
      return call === 1
        ? anthropicRecallStream("patterns")
        : anthropicFinalStream("Based on the search: pattern X.");
    });

    teardownFn = () =>
      teardownAll(dbPath, projectDir, server, closeDB, setUpstreamInterceptor);

    // OpenAI Chat Completions streaming shape — the CLIENT speaks OpenAI
    // (POSTs to /v1/chat/completions) but the GATEWAY's upstream is Anthropic
    // (we mock the upstream as Anthropic SSE). The translator at
    // stream/openai.ts converts the Anthropic SSE to OpenAI Chat Completions
    // chunks — including the inline marker, which arrives as a
    // delta.content chunk.
    const resp = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-lore-project": projectDir,
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "What patterns?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          },
        ],
      }),
    });

    expect(resp.ok).toBe(true);
    const sse = await resp.text();

    // The OpenAI translator forwards text deltas as delta.content chunks.
    // The marker text MUST be present in the OpenAI stream so the client
    // persists it for the next-turn replay path (fixes silent-recall-loss
    // bug from dropping the marker entirely for non-Anthropic clients).
    expect(sse).toContain("Searching");

    // Wire-shape invariants: the OpenAI Chat Completions stream must have
    // EXACTLY ONE [DONE] sentinel and EXACTLY ONE non-null finish_reason
    // chunk. Duplicate [DONE] or contradictory finish_reasons indicate
    // double-emission of a close event (e.g. forwarding both the preamble's
    // held-back message_stop AND the continuation's terminal message_stop).
    const doneCount = (sse.match(/data: \[DONE\]/g) ?? []).length;
    expect(doneCount).toBe(1);

    const finishReasons: string[] = [];
    for (const line of sse.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const payload = line.slice(6);
      try {
        const obj = JSON.parse(payload) as {
          choices?: Array<{ finish_reason?: string | null }>;
        };
        const reason = obj.choices?.[0]?.finish_reason;
        if (reason) finishReasons.push(reason);
      } catch {
        /* not JSON — skip */
      }
    }
    expect(finishReasons).toEqual(["stop"]);

    // Two upstream calls — recall interception ran.
    expect(call).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Mixed-tools path: preamble text + recall + Read tool_use.
// The recall is suppressed, the marker is emitted as its own envelope, and
// the OTHER tool use (Read) is forwarded with re-indexed block indices.
// The stream closes after the held-back preamble message_delta/stop.
//
// This pins the C/MUST-FIX from the adversarial review: the marker envelope
// must NOT orphan the Read tool_use, and the held-back preamble closure must
// arrive AFTER the marker envelope (so the Anthropic SDK renders the marker
// as a distinct assistant message, not nested inside the preamble).
// ---------------------------------------------------------------------------

function anthropicMixedToolsStream(query: string): Response {
  const body =
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_mixed_001",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-20250514",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Let me search and read." },
    }) +
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_recall_mix",
        name: "recall",
        input: {},
      },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ query }),
      },
    }) +
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 1,
    }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "tool_use",
        id: "toolu_read_mix",
        name: "read",
        input: { file: "/tmp/test" },
      },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: "" },
    }) +
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 2,
    }) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    sseEvent("message_stop", { type: "message_stop" });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Streaming recall marker — mixed tools (recall + Read)", () => {
  test("marker envelope is emitted and the other tool_use is forwarded", async () => {
    const dbPath = `/tmp/lore-marker-split-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-marker-split-proj-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    let call = 0;
    const { baseURL, setUpstreamInterceptor, server, closeDB } =
      await spinUpGateway(projectDir);
    setUpstreamInterceptor(async () => {
      call++;
      return call === 1
        ? anthropicMixedToolsStream("patterns")
        : anthropicFinalStream("Based on the search and read: result X.");
    });

    teardownFn = () =>
      teardownAll(dbPath, projectDir, server, closeDB, setUpstreamInterceptor);

    const resp = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "x-lore-project": projectDir,
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        stream: true,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "What patterns?" }],
        tools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      }),
    });

    expect(resp.ok).toBe(true);
    const sse = await resp.text();

    // The inline marker is present without opening another message envelope.
    expect(sse).toContain("Searching");

    // The OTHER tool_use (read) is forwarded through the accumulator after
    // re-indexing. Its id must be present in the response.
    expect(sse).toContain("toolu_read_mix");

    // The recall tool_use id is NOT in the client-facing response (it was
    // suppressed by the accumulator).
    expect(sse).not.toContain("toolu_recall_mix");

    // The marker text is present.
    expect(sse).toContain("Searching");

    // At least one upstream call was made (recall interception ran).
    expect(call).toBeGreaterThanOrEqual(1);

    // SSE event order: the mixed-tools path closes the stream with a single
    // preamble-close (message_delta + message_stop) forwarded after the
    // marker envelope. `takeHeldBackEvents()` ensures it's emitted exactly
    // once (no double-emission from the marker-emission seam + the
    // mixed-tools terminal-close branch).
    const eventOrder: string[] = [];
    for (const line of sse.split("\n")) {
      if (line.startsWith("event: ")) {
        eventOrder.push(line.slice(7).trim());
      }
    }
    const messageStartPositions: number[] = [];
    for (let i = 0; i < eventOrder.length; i++) {
      if (eventOrder[i] === "message_start") {
        messageStartPositions.push(i);
      }
    }
    const messageStopPositions: number[] = [];
    for (let i = 0; i < eventOrder.length; i++) {
      if (eventOrder[i] === "message_stop") {
        messageStopPositions.push(i);
      }
    }
    expect(messageStartPositions.length).toBe(messageStopPositions.length);
    // For every message_start at position p, exactly one message_stop must
    // fall in [p, nextStart). Catches double-emission (stopsInRange > 1) and
    // wrong-order emission (stopsInRange = 0).
    for (let i = 0; i < messageStartPositions.length; i++) {
      const start = messageStartPositions[i];
      const nextStart = messageStartPositions[i + 1] ?? eventOrder.length;
      const stopsInRange = messageStopPositions.filter(
        (p) => p >= start && p < nextStart,
      ).length;
      expect(stopsInRange).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-recall drill-down: model calls recall once, then again on the
// continuation. The first marker is emitted, the first follow-up returns
// another recall, the second marker is emitted, etc. Each marker must have a
// DISTINCT lore_marker_* id (no collision) and the response must contain
// both.
// ---------------------------------------------------------------------------

function anthropicFollowupRecallStream(query: string): Response {
  // Continuation that itself calls recall again (drill-down).
  const body =
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_followup_001",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-20250514",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Drilling in." },
    }) +
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_recall_2",
        name: "recall",
        input: {},
      },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ query, id: "t:abc123" }),
      },
    }) +
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 1,
    }) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    sseEvent("message_stop", { type: "message_stop" });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Streaming recall marker — non-Anthropic mixed tools (recall + Read)", () => {
  test("OpenAI mixed-tools wire: finish_reason=tool_calls, single [DONE], Read tool_use forwarded", async () => {
    const dbPath = `/tmp/lore-marker-split-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-marker-split-proj-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    let call = 0;
    const { baseURL, setUpstreamInterceptor, server, closeDB } =
      await spinUpGateway(projectDir);
    setUpstreamInterceptor(async () => {
      call++;
      return call === 1
        ? anthropicMixedToolsStream("patterns")
        : anthropicFinalStream("Final answer.");
    });

    teardownFn = () =>
      teardownAll(dbPath, projectDir, server, closeDB, setUpstreamInterceptor);

    // OpenAI Chat Completions client — exercises the
    // pipeline.ts:4824 takeHeldBackEvents() path which forwards the
    // preamble's message_delta + message_stop to the OpenAI translator
    // so it can emit finish_reason="tool_calls" + [DONE].
    const resp = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-lore-project": projectDir,
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "What patterns?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "read",
              description: "Read a file",
              parameters: {
                type: "object",
                properties: { file: { type: "string" } },
                required: ["file"],
              },
            },
          },
        ],
      }),
    });

    expect(resp.ok).toBe(true);
    const sse = await resp.text();

    // The OTHER tool_use (Read) is forwarded through the accumulator
    // after re-indexing. Its id must be present in the response.
    expect(sse).toContain("toolu_read_mix");

    // The recall tool_use id is NOT in the client-facing response (it
    // was suppressed by the accumulator).
    expect(sse).not.toContain("toolu_recall_mix");

    // The marker text is present.
    expect(sse).toContain("Searching");

    // Wire-shape invariants for mixed-tools: the OpenAI translator
    // must emit EXACTLY ONE [DONE] sentinel and EXACTLY ONE non-null
    // finish_reason. The finish_reason is "tool_calls" because the
    // model called Read (which is still pending client-side).
    const doneCount = (sse.match(/data: \[DONE\]/g) ?? []).length;
    expect(doneCount).toBe(1);

    const finishReasons: string[] = [];
    for (const line of sse.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const payload = line.slice(6);
      try {
        const obj = JSON.parse(payload) as {
          choices?: Array<{ finish_reason?: string | null }>;
        };
        const reason = obj.choices?.[0]?.finish_reason;
        if (reason) finishReasons.push(reason);
      } catch {
        /* not JSON — skip */
      }
    }
    expect(finishReasons).toEqual(["tool_calls"]);

    // Recall interception ran (at least one upstream call).
    expect(call).toBeGreaterThanOrEqual(1);
  });
});

describe("Streaming recall marker — multi-recall drill-down", () => {
  test("each iteration emits an inline marker in one response envelope", async () => {
    const dbPath = `/tmp/lore-marker-split-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const projectDir = mkdtempSync(join(tmpdir(), "lore-marker-split-proj-"));
    writeFileSync(
      join(projectDir, ".lore.json"),
      JSON.stringify({ search: { queryExpansion: false } }),
    );

    let call = 0;
    const { baseURL, setUpstreamInterceptor, server, closeDB } =
      await spinUpGateway(projectDir);
    setUpstreamInterceptor(async () => {
      call++;
      if (call === 1) return anthropicRecallStream("patterns");
      if (call === 2) return anthropicFollowupRecallStream("patterns");
      return anthropicFinalStream("Final answer based on drill-down.");
    });

    teardownFn = () =>
      teardownAll(dbPath, projectDir, server, closeDB, setUpstreamInterceptor);

    const resp = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "x-lore-project": projectDir,
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        stream: true,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "What patterns?" }],
        tools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      }),
    });

    expect(resp.ok).toBe(true);
    const sse = await resp.text();

    // Both recall markers are inline text blocks. A nested message envelope
    // would make Pi reject the response before it can consume the follow-up.
    expect(sse).toContain('Searching all archives for \\"patterns\\"');
    expect(sse).toContain("Fetching detail for t:abc123");

    // Both upstream call results (recalls) were consumed: call counter >= 3.
    expect(call).toBeGreaterThanOrEqual(3);

    // A multi-recall turn is still exactly one Anthropic response envelope.
    const eventOrder: string[] = [];
    for (const line of sse.split("\n")) {
      if (line.startsWith("event: ")) {
        eventOrder.push(line.slice(7).trim());
      }
    }
    const messageStartPositions: number[] = [];
    for (let i = 0; i < eventOrder.length; i++) {
      if (eventOrder[i] === "message_start") {
        messageStartPositions.push(i);
      }
    }
    const messageStopPositions: number[] = [];
    for (let i = 0; i < eventOrder.length; i++) {
      if (eventOrder[i] === "message_stop") {
        messageStopPositions.push(i);
      }
    }
    expect(messageStartPositions.length).toBe(messageStopPositions.length);
    expect(messageStartPositions.length).toBe(1);
    for (let i = 0; i < messageStartPositions.length; i++) {
      const start = messageStartPositions[i];
      const nextStart = messageStartPositions[i + 1] ?? eventOrder.length;
      const stopsInRange = messageStopPositions.filter(
        (p) => p >= start && p < nextStart,
      ).length;
      expect(stopsInRange).toBe(1);
    }
  });
});
