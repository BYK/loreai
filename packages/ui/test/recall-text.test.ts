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
});
