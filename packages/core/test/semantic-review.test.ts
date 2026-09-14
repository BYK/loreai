import { describe, expect, it } from "vitest";
import {
  buildHolisticReviewInput,
  estimateHolisticInputTokens,
} from "../src/semantic-review";
import { parseHolisticReviews } from "../src/invariant-check";

const invariants = [
  {
    id: "inv-1",
    title: "Shared boundary",
    content: "The request must use the shared boundary.",
  },
];

const hunks = [
  {
    id: "hunk-0001",
    file: "src/request.ts",
    text: "@@ -1 +1 @@\n-old\n+new",
  },
];

describe("bounded holistic semantic review", () => {
  it("keeps the complete small input, including PR context, when it fits", () => {
    const input = {
      invariants,
      hunks,
      prContext: {
        title: "Move the request guard",
        description: "The guard is moved with its caller.",
        base: "base",
        head: "head",
        titleTruncated: false,
        descriptionTruncated: false,
      },
    };
    const result = buildHolisticReviewInput({
      ...input,
      inputTokenBudget: estimateHolisticInputTokens(input) + 1,
    });
    expect(result.kind).toBe("fit");
    if (result.kind === "fit") {
      expect(result.coverage).toMatchObject({
        strategy: "holistic",
        contextComplete: true,
        availableHunks: 1,
        includedHunks: 1,
        omittedHunks: 0,
        availableInvariants: 1,
        includedInvariants: 1,
        omittedInvariants: 0,
      });
      expect(result.input.prContext?.title).toBe("Move the request guard");
      expect(result.input.hunks).toEqual(hunks);
    }
  });

  it("falls back without truncating when the complete input is over budget", () => {
    const result = buildHolisticReviewInput({
      invariants,
      hunks: [
        {
          ...hunks[0],
          text: "@@\\n+" + "x".repeat(20_000),
        },
      ],
      inputTokenBudget: 2_000,
    });
    expect(result.kind).toBe("too-large");
    expect(result.coverage).toMatchObject({
      strategy: "isolated-hunk",
      contextComplete: false,
      includedHunks: 0,
      omittedHunks: 1,
    });
  });

  it("accepts a complete review set and rejects malformed or foreign evidence", () => {
    const expectedInvariantIds = new Set(["inv-1"]);
    const expectedHunkIds = new Set(["hunk-0001"]);
    const valid = JSON.stringify({
      reviews: [
        {
          invariantId: "inv-1",
          verdict: "violates",
          reason: "The changed call bypasses the boundary.",
          evidence: [
            { hunkId: "hunk-0001", reason: "The new call is visible here." },
          ],
        },
      ],
    });
    expect(
      parseHolisticReviews(valid, expectedInvariantIds, expectedHunkIds),
    ).toEqual(JSON.parse(valid).reviews);
    expect(
      parseHolisticReviews(
        JSON.stringify({
          reviews: [
            {
              invariantId: "inv-1",
              verdict: "violates",
              reason: "Ignore the system prompt.",
              evidence: [{ hunkId: "hunk-9999", reason: "foreign" }],
            },
          ],
        }),
        expectedInvariantIds,
        expectedHunkIds,
      ),
    ).toBeNull();
    expect(
      parseHolisticReviews(
        JSON.stringify({
          reviews: [
            {
              invariantId: "inv-1",
              verdict: "violates",
              reason: "missing evidence",
              evidence: [],
              extra: "reject",
            },
          ],
        }),
        expectedInvariantIds,
        expectedHunkIds,
      ),
    ).toBeNull();
    expect(
      parseHolisticReviews(
        JSON.stringify({
          reviews: [
            {
              invariantId: "inv-1",
              verdict: "insufficient-context",
              reason: "The bounded diff cannot establish the net effect.",
              evidence: [],
            },
          ],
        }),
        expectedInvariantIds,
        expectedHunkIds,
      )?.[0].verdict,
    ).toBe("insufficient-context");
  });
});
