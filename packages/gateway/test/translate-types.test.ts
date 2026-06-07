import { describe, it, expect } from "vitest";
import { ZERO_USAGE, extractJSONFromSSE } from "../src/translate/types";

// ---------------------------------------------------------------------------
// ZERO_USAGE
// ---------------------------------------------------------------------------

describe("ZERO_USAGE", () => {
  it("must not include optional cache fields", () => {
    // INVARIANT: ZERO_USAGE must only contain required fields (inputTokens,
    // outputTokens). The optional cache fields (cacheReadInputTokens,
    // cacheCreationInputTokens) must NOT be present — their mere presence
    // (even as 0) causes downstream `!= null` guards to emit cache fields
    // in the wire response, leaking "cache_read_input_tokens: 0" to clients
    // when no caching actually occurred.
    expect(Object.keys(ZERO_USAGE).sort()).toEqual([
      "inputTokens",
      "outputTokens",
    ]);
    expect(ZERO_USAGE).not.toHaveProperty("cacheReadInputTokens");
    expect(ZERO_USAGE).not.toHaveProperty("cacheCreationInputTokens");
  });

  it("has zero values for required fields", () => {
    expect(ZERO_USAGE.inputTokens).toBe(0);
    expect(ZERO_USAGE.outputTokens).toBe(0);
  });

  it("is frozen to prevent accidental mutation", () => {
    expect(Object.isFrozen(ZERO_USAGE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractJSONFromSSE
// ---------------------------------------------------------------------------

/** Helper: create a Response with the given body text and content-type. */
function sseResponse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("extractJSONFromSSE", () => {
  it("extracts JSON from a single data: line", async () => {
    const resp = sseResponse('data: {"id":"abc","model":"gpt-4"}\n\n');
    const json = await extractJSONFromSSE(resp);
    expect(json).toEqual({ id: "abc", model: "gpt-4" });
  });

  it("returns the last non-[DONE] payload when multiple data: lines exist", async () => {
    const body = [
      'data: {"id":"1","choices":[]}',
      'data: {"id":"2","choices":[{"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    const json = await extractJSONFromSSE(sseResponse(body));
    expect(json).toEqual({
      id: "2",
      choices: [{ finish_reason: "stop" }],
    });
  });

  it("ignores data: [DONE] sentinel", async () => {
    const body = 'data: {"id":"x"}\ndata: [DONE]\n\n';
    const json = await extractJSONFromSSE(sseResponse(body));
    expect(json).toEqual({ id: "x" });
  });

  it("throws when body has no data: lines", async () => {
    const resp = sseResponse("event: ping\n: comment\n\n");
    await expect(extractJSONFromSSE(resp)).rejects.toThrow(
      "no data payload found",
    );
  });

  it("throws when body has only data: [DONE]", async () => {
    const resp = sseResponse("data: [DONE]\n\n");
    await expect(extractJSONFromSSE(resp)).rejects.toThrow(
      "no data payload found",
    );
  });

  it("throws on malformed JSON in data: line", async () => {
    const resp = sseResponse("data: {broken json}\n\n");
    await expect(extractJSONFromSSE(resp)).rejects.toThrow();
  });

  it("handles \\r\\n line endings", async () => {
    const body = 'data: {"id":"crlf"}\r\ndata: [DONE]\r\n\r\n';
    const json = await extractJSONFromSSE(sseResponse(body));
    expect(json).toEqual({ id: "crlf" });
  });
});
