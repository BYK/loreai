import { describe, expect, test } from "vitest";
import { upstreamRejectionDiagnostic } from "../src/provider-failure-diagnostics";
import {
  buildOpenAIUpstreamRequest,
  parseOpenAIRequest,
} from "../src/translate/openai";

describe("Copilot Gemini request rejection diagnostics", () => {
  test("identifies a provider field even when the message has no existing hints", () => {
    expect(
      upstreamRejectionDiagnostic(
        JSON.stringify({
          error: {
            code: "invalid_request_body",
            message: "PRIVATE",
            param: "tools[63].function.parameters.properties.PRIVATE.type",
          },
        }),
      ),
    ).toBe(
      "body=json code=invalid_request_body hints=none message=string param=tool_schema fields=none checks=none",
    );
  });

  test("classifies known rejected fields and schema checks without copying text", () => {
    expect(
      upstreamRejectionDiagnostic(
        JSON.stringify({
          error: {
            code: "invalid_request_body",
            message:
              "PRIVATE messages[1].content[0].cache_control: unknown field; additionalProperties is not allowed",
            param: "PRIVATE",
          },
        }),
      ),
    ).toBe(
      "body=json code=invalid_request_body hints=none message=string param=unrecognized fields=cache_control checks=additional_properties,unknown_field",
    );
  });

  test.each([
    [undefined, "missing"],
    [null, "null"],
    ["", "empty"],
    [{ private: "PRIVATE" }, "other"],
  ])("distinguishes unavailable explanation (%j)", (message, shape) => {
    expect(
      upstreamRejectionDiagnostic(
        JSON.stringify({ error: { code: "invalid_request_body", message } }),
      ),
    ).toBe(
      `body=json code=invalid_request_body hints=none message=${shape} param=missing fields=none checks=none`,
    );
  });

  test.each([
    ["thinking_budget", "thinking_budget"],
    ["reasoning_effort", "reasoning_effort"],
    ["messages.0.content", "message_content"],
    ["/tools/0/function/parameters/required", "tool_schema"],
    ["tools[0].function.name", "tool_name"],
    ["PRIVATE.tools[0].function.parameters", "unrecognized"],
    ["tools[0].function.parametersPRIVATE", "unrecognized"],
  ])("classifies parameter %s with a fixed code", (param, field) => {
    expect(
      upstreamRejectionDiagnostic(
        JSON.stringify({ error: { code: "invalid_request_body", param } }),
      ),
    ).toContain(`param=${field} `);
  });

  test("keeps diagnostics bounded for hostile provider strings", () => {
    const result = upstreamRejectionDiagnostic(
      JSON.stringify({
        error: {
          code: "invalid_request_body",
          message: "PRIVATE".repeat(100_000),
          param: "PRIVATE".repeat(100_000),
        },
      }),
    );
    expect(result).not.toContain("PRIVATE");
    expect(result.length).toBeLessThan(250);
  });
});

describe("OpenCode-shaped Copilot Gemini Chat serialization", () => {
  test("preserves 64 function schemas and explicit model controls", () => {
    const tools = Array.from({ length: 64 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: "A tool",
        parameters: {
          type: "object",
          properties: {
            value: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["value"],
          additionalProperties: false,
          $defs: { value: { type: "string" } },
        },
      },
    }));
    const body = {
      model: "gemini-4-argon",
      messages: [
        { role: "system", content: "System instructions" },
        { role: "user", content: "Reply with hello" },
      ],
      stream: true,
      max_tokens: 8192,
      tools,
      tool_choice: "auto",
    };
    const upstream = buildOpenAIUpstreamRequest(
      parseOpenAIRequest(body, {}),
      "https://api.githubcopilot.com",
    );
    expect(upstream.url).toBe("https://api.githubcopilot.com/chat/completions");
    expect(upstream.body).toEqual(body);
  });
});
