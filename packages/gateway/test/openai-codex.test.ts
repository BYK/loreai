/**
 * Tests for `openai-codex` (ChatGPT Codex) support.
 *
 * Codex uses the OpenAI Responses wire format on ChatGPT's backend
 * (`/backend-api/codex/responses`). The gateway reuses the `openai-responses`
 * protocol and carries a `codex` flag that steers:
 *   - the upstream URL suffix (`/codex/responses` vs `/v1/responses`)
 *   - preservation of Codex control fields (`store: false`, `include`,
 *     `prompt_cache_key`, `text`, `tool_choice`, `parallel_tool_calls`,
 *     `service_tier`).
 */
import { describe, test, expect } from "vitest";
import {
  parseOpenAICodexRequest,
  parseOpenAIResponsesRequest,
  buildOpenAIResponsesUpstreamRequest,
} from "../src/translate/openai-responses";
import { resolveProviderRoute } from "../src/config";

const codexBody = {
  model: "gpt-5.5",
  input: "Hello",
  instructions: "Be helpful",
  stream: true,
  store: false,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "sess-123",
  text: { verbosity: "low" },
  tool_choice: "auto",
  parallel_tool_calls: true,
  service_tier: "priority",
};

describe("parseOpenAICodexRequest", () => {
  test("flags the request as codex and keeps openai-responses protocol", () => {
    const req = parseOpenAICodexRequest(codexBody, {
      authorization: "Bearer jwt-token",
    });
    expect(req.protocol).toBe("openai-responses");
    expect(req.codex).toBe(true);
  });

  test("captures Codex control fields into extras (store is forced, not captured)", () => {
    const req = parseOpenAICodexRequest(codexBody, {});
    // `store` is NOT captured — the builder always forces store:false.
    expect(req.extras?.include).toEqual(["reasoning.encrypted_content"]);
    expect(req.extras?.prompt_cache_key).toBe("sess-123");
    expect(req.extras?.text).toEqual({ verbosity: "low" });
    expect(req.extras?.tool_choice).toBe("auto");
    expect(req.extras?.parallel_tool_calls).toBe(true);
    expect(req.extras?.service_tier).toBe("priority");
  });

  test("base parser does NOT set the codex flag or capture control fields", () => {
    const req = parseOpenAIResponsesRequest(codexBody, {});
    expect(req.codex).toBeUndefined();
    // Codex control fields must NOT leak into normal openai-responses parsing.
    expect(req.extras?.include).toBeUndefined();
    expect(req.extras?.prompt_cache_key).toBeUndefined();
    expect(req.extras?.tool_choice).toBeUndefined();
    expect(req.extras?.parallel_tool_calls).toBeUndefined();
    expect(req.extras?.service_tier).toBeUndefined();
  });
});

describe("buildOpenAIResponsesUpstreamRequest (codex)", () => {
  test("emits the Codex upstream path", () => {
    const req = parseOpenAICodexRequest(codexBody, {
      authorization: "Bearer jwt-token",
    });
    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://chatgpt.com/backend-api",
    );
    expect(result.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  test("preserves Codex control fields and forces store:false", () => {
    const req = parseOpenAICodexRequest(codexBody, {});
    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://chatgpt.com/backend-api",
    );
    const body = result.body as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.prompt_cache_key).toBe("sess-123");
    expect(body.text).toEqual({ verbosity: "low" });
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.service_tier).toBe("priority");
  });

  test("forces store:false even when the client omits store", () => {
    const { store: _omit, ...noStore } = codexBody;
    const req = parseOpenAICodexRequest(noStore, {});
    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://chatgpt.com/backend-api",
    );
    expect((result.body as Record<string, unknown>).store).toBe(false);
  });

  test("forwards Codex auth + headers", () => {
    const req = parseOpenAICodexRequest(codexBody, {
      authorization: "Bearer jwt-token",
      "chatgpt-account-id": "acct-1",
      originator: "pi",
      "openai-beta": "responses=experimental",
      session_id: "sess-123",
    });
    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://chatgpt.com/backend-api",
    );
    expect(result.headers.Authorization).toBe("Bearer jwt-token");
    expect(result.headers["chatgpt-account-id"]).toBe("acct-1");
    expect(result.headers.originator).toBe("pi");
    expect(result.headers["openai-beta"]).toBe("responses=experimental");
    expect(result.headers.session_id).toBe("sess-123");
  });

  test("non-codex Responses request is unaffected (no leaked fields)", () => {
    const req = parseOpenAIResponsesRequest(codexBody, {});
    const result = buildOpenAIResponsesUpstreamRequest(
      req,
      "https://api.openai.com",
    );
    // Non-codex still hits /v1/responses.
    expect(result.url).toBe("https://api.openai.com/v1/responses");
    const body = result.body as Record<string, unknown>;
    // Codex control fields must NOT be emitted for normal openai-responses.
    expect(body.store).toBeUndefined();
    expect(body.include).toBeUndefined();
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(body.service_tier).toBeUndefined();
  });
});

describe("resolveProviderRoute (openai-codex)", () => {
  test("routes openai-codex to ChatGPT backend with openai-responses protocol", () => {
    expect(resolveProviderRoute("openai-codex")).toEqual({
      url: "https://chatgpt.com/backend-api",
      protocol: "openai-responses",
    });
  });
});
