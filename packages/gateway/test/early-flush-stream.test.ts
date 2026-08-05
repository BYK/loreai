/**
 * Unit tests for `earlyFlushStreamingResponse` — the early-header-flush
 * wrapper that returns a streaming Response synchronously so the server sends
 * HTTP 200 + text/event-stream before the (potentially slow) pre-upstream
 * pipeline work completes.
 *
 * Regression for the "Provider response headers timed out after 10000ms"
 * issue: on a cold post-restart session the gateway's LTM injection + gradient
 * transform can take tens of seconds, and opencode aborts when no headers
 * arrive within 10s. This wrapper enqueues an SSE keepalive comment as the
 * first chunk (forcing the header flush), then re-pipes the inner streaming
 * response.
 */
import { describe, test, expect, vi } from "vitest";
import { earlyFlushStreamingResponse } from "../src/pipeline";

const SSE = {
  "content-type": "text/event-stream",
} as const;

/** A controllable inner response: emits its body only after the given delay. */
function innerStream(
  events: string[],
  delayMs: number,
  status = 200,
): Response {
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        for (const ev of events) controller.enqueue(encoder.encode(ev));
        controller.close();
      },
    }),
    { status, headers: SSE },
  );
}

async function drain(resp: Response): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) out += decoder.decode(value, { stream: true });
    if (done) break;
  }
  return out;
}

/** Canonical Responses-API `response.failed` event envelope (one wire event). */
const FAILED_EVENT_RE =
  /^event: response\.failed\ndata: \{"type":"response\.failed","response":\{"id":"resp_error_[0-9]+","object":"response","created_at":\d+,"model":"gpt-5\.6-terra","status":"failed","output":\[\],"usage":null,"error":\{"type":"server_error","message":"(([^"\\]|\\["\\])*)"\}\}\}\n\n/m;

const KEEPALIVE = ": lore preparing\n\n";

describe("earlyFlushStreamingResponse", () => {
  test("returns a Response synchronously with streaming headers", () => {
    const start = Date.now();
    const resp = earlyFlushStreamingResponse(async () => {
      // A "slow" pipeline (5s) must NOT block the wrapper's return.
      await new Promise((r) => setTimeout(r, 5000));
      return innerStream(["event: response.created\n\n"], 0);
    }, "gpt-5.6-terra");
    const elapsed = Date.now() - start;

    // The wrapper returns a Response with streaming headers synchronously —
    // far faster than the 5s simulated pipeline. This is the property that
    // guarantees headers flush before opencode's 10s timeout.
    expect(elapsed).toBeLessThan(100);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
  });

  test("flushes a keepalive comment first, then re-pipes the inner stream", async () => {
    const resp = earlyFlushStreamingResponse(async () => {
      // Simulate a slow pre-upstream pipeline.
      await new Promise((r) => setTimeout(r, 30));
      return innerStream(
        [
          "event: response.output_item.added\n\n",
          "event: response.completed\n\n",
        ],
        0,
      );
    }, "gpt-5.6-terra");

    const out = await drain(resp);
    // First chunk is the keepalive comment (forces the header flush).
    expect(out.startsWith(KEEPALIVE)).toBe(true);
    // Then the inner stream's events are re-piped verbatim.
    expect(out).toContain("event: response.output_item.added");
    expect(out).toContain("event: response.completed");
    // And the keepalive strictly precedes the real events.
    const keepaliveIdx = out.indexOf(KEEPALIVE);
    const createdIdx = out.indexOf("event: response.output_item.added");
    expect(keepaliveIdx).toBeLessThan(createdIdx);
  });

  test("emits a canonical response.failed envelope when the inner pipeline rejects", async () => {
    const resp = earlyFlushStreamingResponse(async () => {
      throw new Error("boom");
    }, "gpt-5.6-terra");

    const out = await drain(resp);
    // Pin the canonical envelope shape (id, object, created_at, model, status,
    // output, usage, error) — not a loose substring. A regression that drops
    // the `response:{}` envelope or splits the data field will fail.
    const match = out.match(FAILED_EVENT_RE);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("boom");
  });

  test("emits a canonical response.failed envelope when the inner response is a non-SSE error body", async () => {
    const resp = earlyFlushStreamingResponse(async () => {
      return new Response("upstream 429", { status: 429 });
    }, "gpt-5.6-terra");

    const out = await drain(resp);
    const match = out.match(FAILED_EVENT_RE);
    expect(match).not.toBeNull();
    // The HTTP status and the truncated upstream body surface in the message.
    expect(match?.[1]).toContain("429");
    expect(match?.[1]).toContain("upstream 429");
  });

  test("the pipeline runs once inside the stream start", async () => {
    const run = vi.fn(async () =>
      innerStream(["event: response.created\n\n"], 0),
    );
    const resp = earlyFlushStreamingResponse(run, "gpt-5.6-terra");

    await drain(resp);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
