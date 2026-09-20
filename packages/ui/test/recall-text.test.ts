import { describe, expect, it } from "vitest";

import { parseRecallMarkdown, recallInline } from "~/lib/recall-text";

describe("recall markdown rendering", () => {
  it("parses headings, separators, bullets and paragraphs without HTML parsing", () => {
    expect(parseRecallMarkdown("## **Heading**\n- body\n---")).toEqual([
      { kind: "heading", level: 2, text: "**Heading**" },
      { kind: "item", text: "body", parts: [{ text: "body" }] },
      { kind: "separator" },
    ]);
  });

  it("links knowledge references but leaves other references plain", () => {
    expect(recallInline("see (k:abc), (d:def), (m:ghi) and **bold**")).toEqual([
      { text: "see " },
      { text: "(k:abc)", linkId: "abc" },
      { text: ", (d:def), (m:ghi) and " },
      { text: "bold", bold: true },
    ]);
  });

  it("renders raw HTML as literal text parts", () => {
    const nodes = parseRecallMarkdown(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>",
    );
    expect(
      nodes
        .flatMap((node) => ("parts" in node ? node.parts : []))
        .map((part) => part.text),
    ).toEqual(["<script>alert(1)</script>", "<img src=x onerror=alert(1)>"]);
  });

  it("keeps Lore links inside bold inline parts", () => {
    expect(recallInline("**bold (k:abc) tail**")).toEqual([
      { text: "bold ", bold: true },
      { text: "(k:abc)", linkId: "abc", bold: true },
      { text: " tail", bold: true },
    ]);
  });

  it("renders ordered and unordered list items", () => {
    expect(
      parseRecallMarkdown(
        "- one\n  - nested bullet\n- two\n\n1. first\n   1. nested number\n2. second",
      ),
    ).toEqual([
      expect.objectContaining({ kind: "item", text: "one" }),
      expect.objectContaining({ kind: "item", text: "nested bullet" }),
      expect.objectContaining({ kind: "item", text: "two" }),
      expect.objectContaining({ kind: "item", text: "first" }),
      expect.objectContaining({ kind: "item", text: "nested number" }),
      expect.objectContaining({ kind: "item", text: "second" }),
    ]);
  });

  it("keeps fenced code and incomplete Lore links inert", () => {
    const nodes = parseRecallMarkdown("```\n<script>alert(1)</script>\n```");
    expect(nodes[0]).toEqual(
      expect.objectContaining({
        kind: "paragraph",
        text: "<script>alert(1)</script>",
      }),
    );
    expect(recallInline("(k:")).toEqual([{ text: "(k:" }]);
  });
});
