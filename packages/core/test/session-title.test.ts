/**
 * Unit tests for the pure title-derivation helpers (#1921): source priority
 * (explicit → first user message → distillation → id), chunk/tag cleanup,
 * and grapheme-safe truncation.
 */
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  deriveSessionTitle,
  normalizeTitle,
  SESSION_TITLE_MAX,
  titleFromMessageContent,
  titleFromNarrative,
  truncateTitle,
} from "../src/session-title";

const base = {
  sessionId: "s-1",
  explicitTitle: null,
  userMessages: [] as string[],
  latestDistillationNarrative: null as string | null,
};

describe("deriveSessionTitle", () => {
  test("empty session falls back to the id", () => {
    expect(deriveSessionTitle(base)).toEqual({
      title: "s-1",
      title_source: "id",
    });
  });

  test("explicit title beats everything and is whitespace-collapsed", () => {
    expect(
      deriveSessionTitle({
        ...base,
        explicitTitle: "  My   Session\nTitle ",
        userMessages: ["hello"],
        latestDistillationNarrative: "# Summary",
      }),
    ).toEqual({ title: "My Session Title", title_source: "explicit" });
  });

  test("empty/whitespace explicit title is ignored", () => {
    expect(
      deriveSessionTitle({
        ...base,
        explicitTitle: "   \n ",
        userMessages: [],
      }),
    ).toEqual({ title: "s-1", title_source: "id" });
  });

  test("tool-only first message falls through to the second user message", () => {
    expect(
      deriveSessionTitle({
        ...base,
        userMessages: [
          "[tool:bash] output here",
          "  Please fix the bug\nin the parser ",
        ],
      }),
    ).toEqual({
      title: "Please fix the bug in the parser",
      title_source: "first_message",
    });
  });

  test("all-tool messages fall back to the distillation narrative", () => {
    expect(
      deriveSessionTitle({
        ...base,
        userMessages: ["[tool:read] file contents", "[reasoning] thinking"],
        latestDistillationNarrative: "# Auth refactor\nThe user refactored…",
      }),
    ).toEqual({ title: "Auth refactor", title_source: "distillation" });
  });

  test("reasoning chunks are skipped but text chunks in the same message count", () => {
    const content = `[reasoning] hmm\n\x1fWhat is the airspeed of a swallow?`;
    expect(deriveSessionTitle({ ...base, userMessages: [content] })).toEqual({
      title: "What is the airspeed of a swallow?",
      title_source: "first_message",
    });
  });

  test("strips <system-reminder> blocks including inner text", () => {
    const content =
      "<system-reminder>\nYou are running low on context.\n</system-reminder>Actual question here";
    expect(titleFromMessageContent(content)).toBe("Actual question here");
  });

  test("strips command-* / local-command-* blocks with inner text; other tags lose markers only", () => {
    expect(
      titleFromMessageContent(
        "<command-name>/clear</command-name><local-command-stdout>bye</local-command-stdout>",
      ),
    ).toBeNull();
    expect(titleFromMessageContent("<b>bold</b> statement")).toBe(
      "bold statement",
    );
  });

  test("a message that is only injected context produces no title", () => {
    expect(
      deriveSessionTitle({
        ...base,
        userMessages: ["<system-reminder>noise</system-reminder>"],
      }),
    ).toEqual({ title: "s-1", title_source: "id" });
  });

  test("strips markdown heading markers and list bullets", () => {
    expect(titleFromMessageContent("## Investigate the flaky test")).toBe(
      "Investigate the flaky test",
    );
    expect(titleFromMessageContent("- item one")).toBe("item one");
  });

  test("collapses internal newlines and whitespace", () => {
    expect(titleFromMessageContent("line one\n\n  line   two")).toBe(
      "line one line two",
    );
  });

  test("narrative uses the first non-empty line", () => {
    expect(titleFromNarrative("\n\n  ###  Deployed the fix\ndetails")).toBe(
      "Deployed the fix",
    );
    expect(titleFromNarrative("   \n  ")).toBeNull();
  });

  test("explicit title is truncated to the cap", () => {
    const long = "x".repeat(200);
    const out = deriveSessionTitle({ ...base, explicitTitle: long });
    expect(Array.from(out.title).length).toBe(SESSION_TITLE_MAX);
    expect(out.title.endsWith("…")).toBe(true);
  });
});

describe("truncateTitle", () => {
  test("short text passes through unchanged", () => {
    expect(truncateTitle("hello")).toBe("hello");
    expect(truncateTitle("x".repeat(80))).toBe("x".repeat(80));
  });

  test("long ASCII text becomes 79 chars + ellipsis", () => {
    const out = truncateTitle("y".repeat(120));
    expect(out).toBe(`${"y".repeat(79)}…`);
  });

  test("never splits a grapheme (emoji, CJK, combining marks)", () => {
    const emojiFam = "👨‍👩‍👧‍👦".repeat(30); // multi-code-point grapheme
    const out = truncateTitle(emojiFam);
    expect(Array.from(out).length).toBeLessThanOrEqual(SESSION_TITLE_MAX);
    expect(out.endsWith("…")).toBe(true);
    // No half-family: stripping the ellipsis must re-segment cleanly.
    const body = out.slice(0, -1);
    expect(
      [...new Intl.Segmenter().segment(body)].every((s) => s.segment === "👨‍👩‍👧‍👦"),
    ).toBe(true);

    const combining = "é".repeat(200); // e + U+0301
    const out2 = truncateTitle(combining);
    expect(out2.endsWith("…")).toBe(true);
    expect(
      [...new Intl.Segmenter().segment(out2.slice(0, -1))].every(
        (s) => s.segment === "é",
      ),
    ).toBe(true);
  });

  test("property: output ≤ 80 code points; identity when input ≤ 80 code points", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = truncateTitle(s);
        expect(Array.from(out).length).toBeLessThanOrEqual(SESSION_TITLE_MAX);
        if (Array.from(s).length <= SESSION_TITLE_MAX) expect(out).toBe(s);
      }),
    );
  });
});

describe("normalizeTitle", () => {
  test("NFKC + lower-cases + collapses whitespace", () => {
    expect(normalizeTitle("  Ünïcode  Chat\n")).toBe("ünïcode chat");
    expect(normalizeTitle("Ｆｕｌｌｗｉｄｔｈ")).toBe("fullwidth");
  });
});
