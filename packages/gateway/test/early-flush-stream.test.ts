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

describe("earlyFlushStreamingResponse", () => {
  test("returns a Response immediately with streaming headers", () => {
    const resp = earlyFlushStreamingResponse(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return innerStream(["event: response.created\n\n"], 0);
    }, "openai-responses");

    // The wrapper returns a Response with streaming headers synchronously.
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
    }, "openai-responses");

    const out = await drain(resp);
    // First chunk is the keepalive comment (forces the header flush).
    expect(out.startsWith(": lore preparing\n\n")).toBe(true);
    // Then the inner stream's events are re-piped verbatim.
    expect(out).toContain("event: response.output_item.added");
    expect(out).toContain("event: response.completed");
  });

  test("emits response.failed when the inner pipeline rejects", async () => {
    const resp = earlyFlushStreamingResponse(async () => {
      throw new Error("boom");
    }, "openai-responses");

    const out = await drain(resp);
    expect(out).toContain("event: response.failed");
    expect(out).toContain('"message":"boom"');
  });

  test("emits response.failed when the inner response is a non-SSE error body", async () => {
    const resp = earlyFlushStreamingResponse(async () => {
      return new Response("upstream 429", { status: 429 });
    }, "openai-responses");

    const out = await drain(resp);
    expect(out).toContain("event: response.failed");
    expect(out).toContain("429");
  });

  test("the pipeline runs inside the stream start (keepalive first)", async () => {
    const run = vi.fn(async () =>
      innerStream(["event: response.created\n\n"], 0),
    );
    const resp = earlyFlushStreamingResponse(run, "openai-responses");

    await drain(resp);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
