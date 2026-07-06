import { describe, it, expect } from "vitest";
import {
  ZERO_USAGE,
  extractJSONFromSSE,
  extractJSONFromSSEText,
  looksLikeSSE,
  readCompletionJSON,
} from "../src/translate/types";

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

  it("tolerates `data:` with no space after the colon", async () => {
    const json = await extractJSONFromSSE(
      sseResponse('data:{"id":"nospace"}\n'),
    );
    expect(json).toEqual({ id: "nospace" });
  });

  it("unwraps the openai-responses `response.completed` envelope to the bare response", () => {
    const body = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      "event: response.completed",
      'data: {"type":"response.completed","response":{"output_text":"hi","usage":{"input_tokens":3,"output_tokens":1},"model":"gpt-5-codex"}}',
      "data: [DONE]",
      "",
    ].join("\n");
    // The terminal event's `.response` is returned, NOT the envelope — so the
    // non-streaming parsers read `output_text`/`usage`/`model` at top level.
    expect(extractJSONFromSSEText(body)).toEqual({
      output_text: "hi",
      usage: { input_tokens: 3, output_tokens: 1 },
      model: "gpt-5-codex",
    });
  });
});

// ---------------------------------------------------------------------------
// looksLikeSSE — body-prefix sniffing (content-type may be mislabeled)
// ---------------------------------------------------------------------------

describe("looksLikeSSE", () => {
  it("true for a text/event-stream content-type regardless of body", () => {
    expect(looksLikeSSE("text/event-stream; charset=utf-8", "{}")).toBe(true);
  });

  it("sniffs SSE bodies even when the content-type is wrong or empty", () => {
    for (const head of [
      "data: {",
      "event: response.created",
      "id: 1",
      "retry: 5",
      ": keepalive",
    ]) {
      expect(looksLikeSSE("application/json", `${head}\n`)).toBe(true);
      expect(looksLikeSSE("", `${head}\n`)).toBe(true);
    }
  });

  it("false for a JSON body (object or array), tolerating BOM/leading whitespace", () => {
    expect(looksLikeSSE("application/json", '{"a":1}')).toBe(false);
    expect(looksLikeSSE("", "  \n [1,2]")).toBe(false);
    expect(looksLikeSSE("", '\uFEFF{"a":1}')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readCompletionJSON — the single safe reader for non-streaming bodies
// ---------------------------------------------------------------------------

function response(body: string, contentType: string): Response {
  return new Response(body, { headers: { "content-type": contentType } });
}

describe("readCompletionJSON", () => {
  it("parses a normal JSON body", async () => {
    const json = await readCompletionJSON(
      response(
        '{"choices":[{"message":{"content":"hi"}}]}',
        "application/json",
      ),
    );
    expect(json).toEqual({ choices: [{ message: { content: "hi" } }] });
  });

  it("does NOT throw on an SSE body that is mislabeled application/json (LOREAI-GATEWAY-38/-1P)", async () => {
    // A chat/completions SSE stream with the WRONG content-type — calling
    // response.json() on this throws `Unexpected token 'd', "data: {..."`.
    const body =
      'data: {"id":"1","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\ndata: [DONE]\n\n';
    const json = await readCompletionJSON(response(body, "application/json"));
    expect(json).toEqual({
      id: "1",
      choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
    });
  });

  it("handles an openai-responses SSE stream with NO content-type, unwrapping the envelope", async () => {
    const body = [
      "event: response.completed",
      'data: {"type":"response.completed","response":{"output_text":"done","model":"gpt-5-codex"}}',
      "",
    ].join("\n");
    const json = await readCompletionJSON(response(body, ""));
    expect(json).toEqual({ output_text: "done", model: "gpt-5-codex" });
  });
});
