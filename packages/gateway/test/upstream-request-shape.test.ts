import { describe, expect, it } from "vitest";
import {
  sanitizeUpstreamJson,
  upstreamRequestShape,
} from "../src/upstream-request-shape";

describe("upstream request shape", () => {
  it("measures the sanitized item bytes actually sent upstream", () => {
    const body = {
      input: [{ type: "message", content: { ["\ud83d"]: "broken \ud83d" } }],
    };
    const wire = JSON.stringify(body, sanitizeUpstreamJson);
    const shape = upstreamRequestShape(body, wire, "openai-responses");
    expect(shape.bodyBytes).toBe(Buffer.byteLength(wire));
    expect(shape.largestItemBytes).toBe(
      Buffer.byteLength(JSON.stringify(body.input[0], sanitizeUpstreamJson)),
    );
    expect(wire).not.toContain("\\ud83d");
  });

  it("rejects normalization collisions instead of dropping a schema property", () => {
    expect(() =>
      JSON.stringify({ ["\ud83d"]: 1, ["�"]: 2 }, sanitizeUpstreamJson),
    ).toThrow("Cannot serialize colliding Unicode property names");
  });

  it("reports only numeric dimensions and allowlisted item types", () => {
    const privateText = "PRIVATE_PROMPT_ä";
    const body = {
      instructions: privateText,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: privateText }],
        },
        { type: privateText, payload: privateText.repeat(10) },
      ],
      tools: [{ name: privateText }],
    };
    const summary = upstreamRequestShape(
      body,
      JSON.stringify(body),
      "openai-responses",
    );
    expect(summary.bodyBytes).toBe(
      Buffer.byteLength(JSON.stringify(body), "utf8"),
    );
    expect(summary.instructionsBytes).toBe(
      Buffer.byteLength(privateText, "utf8"),
    );
    expect(summary).toMatchObject({
      inputItems: 2,
      tools: 1,
      largestItemType: "other",
    });
    expect(JSON.stringify(summary)).not.toContain(privateText);
  });

  it("does not let diagnostic re-serialization change the upstream failure", () => {
    let calls = 0;
    const body = {
      input: [
        {
          toJSON() {
            if (++calls > 1) throw new Error("PRIVATE_ERROR_TEXT");
            return { type: "message", content: "private" };
          },
        },
      ],
    };
    const serialized = JSON.stringify(body);
    const summary = upstreamRequestShape(body, serialized, "openai-responses");
    expect(summary).toMatchObject({
      bodyBytes: Buffer.byteLength(serialized),
      inputItems: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_ERROR_TEXT");
  });

  it("preserves the body size if a getter changes after serialization", () => {
    let reads = 0;
    const body = {
      get input() {
        if (++reads > 1) throw new Error("PRIVATE_GETTER_TEXT");
        return [{ type: "message" }];
      },
    };
    const serialized = JSON.stringify(body);
    const summary = upstreamRequestShape(body, serialized, "openai-responses");
    expect(summary).toMatchObject({
      bodyBytes: Buffer.byteLength(serialized),
      inputItems: 0,
      tools: 0,
    });
  });

  it("bounds per-item work on a large rejected request", () => {
    const body = {
      input: Array.from({ length: 4097 }, () => ({ type: "message" })),
    };
    const summary = upstreamRequestShape(
      body,
      JSON.stringify(body),
      "openai-responses",
    );
    expect(summary.inputItems).toBe(4097);
    expect(summary.largestItemBytes).toBeUndefined();
  });

  it.each(["openai", "anthropic", "vertex"] as const)(
    "counts %s messages rather than Responses input",
    (protocol) => {
      const body = {
        messages: [
          { role: "user", content: "private" },
          { role: "assistant", content: "private" },
        ],
      };
      const summary = upstreamRequestShape(
        body,
        JSON.stringify(body),
        protocol,
      );
      expect(summary.inputItems).toBe(2);
      expect(summary.instructionsBytes).toBeUndefined();
    },
  );

  it("counts Gemini contents", () => {
    const body = {
      contents: [{ role: "user", parts: [{ text: "private" }] }],
      tools: [
        { functionDeclarations: [{ name: "a" }, { name: "b" }, { name: "c" }] },
      ],
    };
    expect(
      upstreamRequestShape(body, JSON.stringify(body), "gemini"),
    ).toMatchObject({
      inputItems: 1,
      tools: 3,
    });
  });

  it("uses UTF-8 byte length to bound re-serialization for multibyte content", () => {
    let serializations = 0;
    const body = {
      input: [
        {
          toJSON() {
            serializations++;
            return { type: "message" };
          },
        },
      ],
      extra: "🙂".repeat(2_100_000),
    };
    const serialized = JSON.stringify(body);
    expect(serialized.length).toBeLessThan(8 * 1024 * 1024);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(8 * 1024 * 1024);
    const summary = upstreamRequestShape(body, serialized, "openai-responses");
    expect(serializations).toBe(1);
    expect(summary.largestItemBytes).toBeUndefined();
  });
});
