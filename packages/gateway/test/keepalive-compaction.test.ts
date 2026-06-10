import { describe, test, expect } from "vitest";
import { buildKeepaliveCompactionStream } from "../src/stream/anthropic";
import { translateAnthropicStreamToOpenAI } from "../src/stream/openai";

async function readAll(resp: Response): Promise<string> {
  const stream = resp.body;
  if (!stream) throw new Error("response has no body");
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe("buildKeepaliveCompactionStream", () => {
  test("emits ping heartbeats while pending, then the summary content", async () => {
    let resolve!: (s: string | null) => void;
    const pending = new Promise<string | null>((r) => {
      resolve = r;
    });
    const resp = buildKeepaliveCompactionStream(
      "msg_test",
      "model-x",
      pending,
      10, // 10ms ping interval
    );
    // Resolve after enough time for several pings to fire.
    setTimeout(() => resolve("THE SUMMARY"), 200);
    const body = await readAll(resp);

    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_start");
    expect(body).toContain("event: ping");
    expect(body).toContain("THE SUMMARY");
    expect(body).toContain("event: content_block_stop");
    expect(body).toContain("event: message_delta");
    expect(body).toContain("event: message_stop");
    // Heartbeats precede the resolved content.
    expect(body.indexOf("event: ping")).toBeLessThan(
      body.indexOf("THE SUMMARY"),
    );
  });

  test("null summary yields a well-formed empty assistant turn", async () => {
    const resp = buildKeepaliveCompactionStream(
      "msg_test2",
      "model-x",
      Promise.resolve(null),
      50,
    );
    const body = await readAll(resp);
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain('"text":""');
    expect(body).toContain("event: message_stop");
  });

  test("translates cleanly to OpenAI SSE (pings dropped, summary preserved)", async () => {
    let resolve!: (s: string | null) => void;
    const pending = new Promise<string | null>((r) => {
      resolve = r;
    });
    const anthropicSSE = buildKeepaliveCompactionStream(
      "msg_x",
      "model-x",
      pending,
      10, // 10ms ping interval
    );
    const openaiResp = translateAnthropicStreamToOpenAI(anthropicSSE);
    setTimeout(() => resolve("TRANSLATED SUMMARY"), 200);
    const body = await readAll(openaiResp);

    // OpenAI chat.completion chunks carry the text in delta.content; pings are
    // not a valid OpenAI event and must be dropped by the translator.
    expect(body).toContain("chat.completion.chunk");
    expect(body).toContain("TRANSLATED SUMMARY");
    expect(body).not.toContain("event: ping");
    expect(body).toContain("[DONE]");
  });

  test("a rejected summary errors the stream (no message_stop) so the client keeps context", async () => {
    const rejecting = new Promise<string | null>((_, rej) => {
      setTimeout(() => rej(new Error("boom")), 5);
    });
    const resp = buildKeepaliveCompactionStream(
      "msg_test3",
      "model-x",
      rejecting,
      50,
    );
    // The stream errors after the opening events — reading it must reject, and
    // the client never sees a `message_stop`, so it treats compaction as failed
    // (keeps its full history) rather than as a successful empty summary.
    // (A null *resolution* is different — see the empty-turn test above.)
    await expect(readAll(resp)).rejects.toThrow("boom");
  });
});
