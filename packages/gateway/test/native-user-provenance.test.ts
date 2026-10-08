import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { projectNativeUserProvenance } from "../src/native-user-provenance";
import { parseOpenAIResponsesRequest } from "../src/translate/openai-responses";
import { InvalidCrossProviderRequestError } from "../src/translate/errors";
import type { GatewayContentBlock } from "../src/translate/types";

function source(content: unknown) {
  return parseOpenAIResponsesRequest(
    {
      model: "gpt-test",
      input: [{ role: "user", id: "msg_source", status: "completed", content }],
    },
    {},
  ).messages[0];
}

function normalized(content: GatewayContentBlock[]): GatewayContentBlock[] {
  return content.map((block) =>
    block.type === "text" ? { ...block, text: block.text.trim() } : block,
  );
}

describe("native user text projection", () => {
  it("preserves envelope fields and part types for arbitrary plain text", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 6 }),
        (texts) => {
          const parts = texts.map((text, index) => ({
            type: index % 2 ? "output_text" : "input_text",
            text: `  start ${text} end  `,
            ...(index % 2 ? { annotations: [] } : {}),
          }));
          const original = source(parts);
          const before = JSON.stringify(original);
          const edited = normalized(original.content);
          const result = projectNativeUserProvenance(original, edited);
          expect(result.provenanceContent).toEqual([
            {
              type: "opaque",
              responsesItem: true,
              requestOnly: true,
              raw: {
                role: "user",
                id: "msg_source",
                status: "completed",
                content: parts.map((part) => ({
                  ...part,
                  text: part.text.trim(),
                })),
              },
            },
          ]);
          expect(result.provenancePositions).toEqual(
            original.provenancePositions,
          );
          expect(JSON.stringify(original)).toBe(before);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("preserves empty part positions and unchanged image and file blocks", () => {
    const parts = [
      { type: "input_text", text: "" },
      { type: "input_text", text: "  continue  " },
      {
        type: "input_image",
        image_url: "https://example.test/a.png",
        detail: "high",
      },
      { type: "output_text", text: "", annotations: [] },
      { type: "input_file", file_id: "file_source" },
    ];
    const original = source(parts);
    const result = projectNativeUserProvenance(
      original,
      normalized(original.content),
    );
    expect(result.provenanceContent?.[0]).toMatchObject({
      raw: {
        content: parts.map((part) =>
          part.text ? { ...part, text: part.text.trim() } : part,
        ),
      },
    });
    expect(original.provenanceContent?.[0]).toMatchObject({
      raw: { content: parts },
    });
  });

  it("keeps unchanged cited text while editing a neighboring plain part", () => {
    const cited = {
      type: "output_text",
      text: "claim",
      annotations: [{ type: "url_citation", url: "https://example.test/a" }],
    };
    const original = source([
      cited,
      { type: "input_text", text: "  continue  " },
    ]);
    expect(
      projectNativeUserProvenance(original, normalized(original.content))
        .provenanceContent?.[0],
    ).toMatchObject({
      raw: { content: [cited, { type: "input_text", text: "continue" }] },
    });
  });

  it("anchors retained edits by source index when cleanup removes a plain part", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        (retained) => {
          const parts = [
            { type: "input_text", text: "  continue  " },
            ...retained.map((keep, index) => ({
              type: "output_text",
              text: keep ? `  part ${index}  ` : "   ",
              annotations: [],
            })),
          ];
          const original = source(parts);
          const indexes = [
            0,
            ...retained.flatMap((keep, index) => (keep ? [index + 1] : [])),
          ];
          const edited = indexes.map((index) => {
            const block = original.content[index];
            if (block.type !== "text") throw new Error("expected text");
            return { ...block, text: block.text.trim() };
          });
          const result = projectNativeUserProvenance(original, edited, indexes);
          expect(result.provenanceContent?.[0]).toMatchObject({
            raw: {
              content: parts.map((part) => ({
                ...part,
                text: part.text.trim(),
              })),
            },
          });
          expect(result.provenancePositions).toEqual(edited.map(() => 0));
          expect(original.provenanceContent?.[0]).toMatchObject({
            raw: { content: parts },
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects missing cited or non-text parts and invalid source indexes", () => {
    for (const retained of [
      {
        type: "output_text",
        text: "claim",
        annotations: [{ type: "url_citation", url: "https://example.test/a" }],
      },
      { type: "input_image", image_url: "https://example.test/a.png" },
    ]) {
      const original = source([
        retained,
        { type: "input_text", text: "  continue  " },
      ]);
      expect(() =>
        projectNativeUserProvenance(
          original,
          [normalized(original.content)[1]],
          [1],
        ),
      ).toThrow(InvalidCrossProviderRequestError);
    }
    const original = source([
      { type: "input_text", text: "one" },
      { type: "input_text", text: "two" },
    ]);
    for (const indexes of [
      [],
      [0],
      [1, 0],
      [0, 0],
      [-1, 1],
      [0, 2],
      [0, 0.5],
    ]) {
      expect(() =>
        projectNativeUserProvenance(original, original.content, indexes),
      ).toThrow(InvalidCrossProviderRequestError);
    }
  });

  it("rejects changed cited text rather than replaying stale citations", () => {
    const original = source([
      {
        type: "output_text",
        text: "  claim  ",
        annotations: [
          {
            type: "url_citation",
            url: "https://example.test/a",
            start_index: 2,
            end_index: 7,
          },
        ],
      },
    ]);
    expect(() =>
      projectNativeUserProvenance(original, normalized(original.content)),
    ).toThrow(InvalidCrossProviderRequestError);
  });

  it("rejects removed, added, reordered, and changed non-text blocks", () => {
    const original = source([
      { type: "input_text", text: "  continue  " },
      { type: "input_image", image_url: "https://example.test/a.png" },
    ]);
    const edited = normalized(original.content);
    for (const invalid of [
      edited.slice(0, 1),
      [...edited, { type: "text" as const, text: "injected" }],
      [...edited].reverse(),
      [
        edited[0],
        {
          type: "opaque" as const,
          raw: { type: "input_image", image_url: "https://example.test/b.png" },
        },
      ],
    ]) {
      expect(() => projectNativeUserProvenance(original, invalid)).toThrow(
        InvalidCrossProviderRequestError,
      );
    }
  });
});
