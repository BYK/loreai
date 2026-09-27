import { describe, expect, it } from "vitest";
import { upstreamRequestShape } from "../src/upstream-request-shape";

describe("upstream request shape", () => {
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
    const summary = upstreamRequestShape(body, JSON.stringify(body));
    expect(summary).toContain(
      `bodyBytes=${Buffer.byteLength(JSON.stringify(body), "utf8")}`,
    );
    expect(summary).toContain(
      `instructionsBytes=${Buffer.byteLength(privateText, "utf8")}`,
    );
    expect(summary).toContain("inputItems=2 tools=1");
    expect(summary).toContain("largestItemType=other");
    expect(summary).not.toContain(privateText);
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
    const summary = upstreamRequestShape(body, serialized);
    expect(summary).toContain(`bodyBytes=${Buffer.byteLength(serialized)}`);
    expect(summary).toContain("inputItems=1");
    expect(summary).not.toContain("PRIVATE_ERROR_TEXT");
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
    const summary = upstreamRequestShape(body, serialized);
    expect(summary).toBe(`bodyBytes=${Buffer.byteLength(serialized)}`);
  });

  it("bounds per-item work on a large rejected request", () => {
    const body = {
      input: Array.from({ length: 4097 }, () => ({ type: "message" })),
    };
    const summary = upstreamRequestShape(body, JSON.stringify(body));
    expect(summary).toContain("inputItems=4097");
    expect(summary).not.toContain("largestItemBytes");
  });
});
