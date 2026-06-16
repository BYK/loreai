/**
 * Unit tests for the unsustainable-conversation warning text + strip round-trip.
 *
 * Covers the PIPELINE-side plumbing of the "gate unsustainable warning" fix:
 * (1) the warning reports the ACTUAL consecutive-bust count (not a hardcoded
 * "5+ times"), and (2) the marker prefix is byte-stable so stripContextWarnings
 * removes the injected warning on the next turn — preserving the prompt-cache
 * prefix regardless of the (variable) count in the text.
 */
import { describe, test, expect } from "vitest";
import {
  contextWarningText,
  stripContextWarnings,
  CONTEXT_WARNING_MARKER,
} from "../src/pipeline";
import type {
  GatewayContentBlock,
  GatewayMessage,
} from "../src/translate/types";

function assistant(...content: GatewayContentBlock[]): GatewayMessage {
  return { role: "assistant", content };
}
function user(...content: GatewayContentBlock[]): GatewayMessage {
  return { role: "user", content };
}
function text(t: string): GatewayContentBlock {
  return { type: "text", text: t };
}

describe("contextWarningText — reports the actual consecutive-bust count", () => {
  test("interpolates the real count", () => {
    const t = contextWarningText(7);
    expect(t).toContain("7 times in a row");
    // No hardcoded legacy figure.
    expect(t).not.toContain("5+ times");
  });

  test("falls back to generic wording when count is unknown/zero", () => {
    expect(contextWarningText()).toContain("several times in a row");
    expect(contextWarningText(0)).toContain("several times in a row");
    expect(contextWarningText(undefined)).toContain("several times in a row");
  });

  test("always starts with the stable marker prefix (strip-safe)", () => {
    for (const c of [undefined, 0, 2, 99]) {
      expect(contextWarningText(c).startsWith(CONTEXT_WARNING_MARKER)).toBe(
        true,
      );
    }
  });

  test("is actionable (advises /compact)", () => {
    expect(contextWarningText(3)).toContain("/compact");
  });
});

describe("stripContextWarnings — removes the injected warning regardless of count", () => {
  test("strips a warning block with any count, restoring API-original content", () => {
    // Two different counts must both be stripped — proving the variable count
    // doesn't defeat the marker-prefix match (the cache-preservation invariant).
    for (const count of [2, 42]) {
      const messages: GatewayMessage[] = [
        user(text("hi")),
        assistant(text(contextWarningText(count)), text("real answer")),
      ];
      stripContextWarnings(messages);
      const a = messages[1];
      // The warning block is gone; the model's real text remains.
      expect(
        a.content.some(
          (b) => b.type === "text" && b.text.startsWith(CONTEXT_WARNING_MARKER),
        ),
      ).toBe(false);
      expect(
        a.content.some((b) => b.type === "text" && b.text === "real answer"),
      ).toBe(true);
    }
  });

  test("leaves messages without the marker untouched", () => {
    const messages: GatewayMessage[] = [
      user(text("hi")),
      assistant(text("a normal answer that mentions /compact in passing")),
    ];
    const before = JSON.stringify(messages);
    stripContextWarnings(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
