/**
 * Unit tests for [lore:session-id=...] and [lore:project=...] context
 * marker extraction, used by the lore-hermes plugin integration.
 */
import { describe, test, expect } from "vitest";
import {
  extractSessionMarker,
  extractProjectMarker,
  stripContextMarkers,
} from "../src/pipeline";
import type { GatewayMessage } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): GatewayMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): GatewayMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function userMsgMultiBlock(...texts: string[]): GatewayMessage {
  return {
    role: "user",
    content: texts.map((t) => ({ type: "text" as const, text: t })),
  };
}

function userMsgWithToolResult(
  text: string,
  toolResult: string,
): GatewayMessage {
  return {
    role: "user",
    content: [
      { type: "text", text },
      {
        type: "tool_result",
        toolUseId: "toolu_1",
        content: [{ type: "text", text: toolResult }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// extractSessionMarker
// ---------------------------------------------------------------------------

describe("extractSessionMarker", () => {
  test("extracts session ID from last user message", () => {
    const msgs: GatewayMessage[] = [
      userMsg("Hello"),
      assistantMsg("Hi there"),
      userMsg("What was I working on?\n[lore:session-id=abc123def456]"),
    ];
    expect(extractSessionMarker(msgs)).toBe("abc123def456");
  });

  test("returns undefined when no marker present", () => {
    const msgs: GatewayMessage[] = [
      userMsg("Hello"),
      assistantMsg("Hi there"),
      userMsg("What was I working on?"),
    ];
    expect(extractSessionMarker(msgs)).toBeUndefined();
  });

  test("returns undefined for empty messages", () => {
    expect(extractSessionMarker([])).toBeUndefined();
  });

  test("scans only the last user message", () => {
    const msgs: GatewayMessage[] = [
      userMsg("[lore:session-id=aaaa000012345678]"),
      assistantMsg("response"),
      userMsg("[lore:session-id=bbbb000087654321]"),
    ];
    expect(extractSessionMarker(msgs)).toBe("bbbb000087654321");
  });

  test("skips assistant messages", () => {
    const msgs: GatewayMessage[] = [
      userMsg("Hello"),
      assistantMsg("[lore:session-id=abc123def456]"),
    ];
    expect(extractSessionMarker(msgs)).toBeUndefined();
  });

  test("extracts from multi-block content", () => {
    const msgs: GatewayMessage[] = [
      userMsgMultiBlock("Do something", "\n[lore:session-id=aabb11223344]"),
    ];
    expect(extractSessionMarker(msgs)).toBe("aabb11223344");
  });

  test("requires 8+ hex characters", () => {
    const msgs: GatewayMessage[] = [userMsg("[lore:session-id=abc]")];
    expect(extractSessionMarker(msgs)).toBeUndefined();
  });

  test("accepts up to 64 hex characters", () => {
    const long = "a".repeat(64);
    const msgs: GatewayMessage[] = [userMsg(`[lore:session-id=${long}]`)];
    expect(extractSessionMarker(msgs)).toBe(long);
  });

  test("rejects non-hex characters", () => {
    const msgs: GatewayMessage[] = [userMsg("[lore:session-id=ghijklmnopqr]")];
    expect(extractSessionMarker(msgs)).toBeUndefined();
  });

  test("ignores tool_result blocks and reads text blocks", () => {
    const msgs: GatewayMessage[] = [
      userMsgWithToolResult(
        "[lore:session-id=aabb11223344]",
        "tool output here",
      ),
    ];
    expect(extractSessionMarker(msgs)).toBe("aabb11223344");
  });
});

// ---------------------------------------------------------------------------
// extractProjectMarker
// ---------------------------------------------------------------------------

describe("extractProjectMarker", () => {
  test("extracts project path from last user message", () => {
    const msgs: GatewayMessage[] = [
      userMsg("Hello\n[lore:project=/home/user/myproject]"),
    ];
    expect(extractProjectMarker(msgs)).toBe("/home/user/myproject");
  });

  test("returns undefined when no marker present", () => {
    const msgs: GatewayMessage[] = [userMsg("Hello")];
    expect(extractProjectMarker(msgs)).toBeUndefined();
  });

  test("returns undefined for empty messages", () => {
    expect(extractProjectMarker([])).toBeUndefined();
  });

  test("rejects relative paths", () => {
    const msgs: GatewayMessage[] = [userMsg("[lore:project=relative/path]")];
    expect(extractProjectMarker(msgs)).toBeUndefined();
  });

  test("strips trailing slashes", () => {
    const msgs: GatewayMessage[] = [
      userMsg("[lore:project=/home/user/project/]"),
    ];
    expect(extractProjectMarker(msgs)).toBe("/home/user/project");
  });

  test("handles paths with spaces", () => {
    const msgs: GatewayMessage[] = [
      userMsg("[lore:project=/home/user/my project]"),
    ];
    expect(extractProjectMarker(msgs)).toBe("/home/user/my project");
  });

  test("scans only the last user message", () => {
    const msgs: GatewayMessage[] = [
      userMsg("[lore:project=/old/path]"),
      assistantMsg("response"),
      userMsg("[lore:project=/new/path]"),
    ];
    expect(extractProjectMarker(msgs)).toBe("/new/path");
  });

  test("skips assistant messages", () => {
    const msgs: GatewayMessage[] = [
      userMsg("Hello"),
      assistantMsg("[lore:project=/home/user/project]"),
    ];
    expect(extractProjectMarker(msgs)).toBeUndefined();
  });

  test("extracts from multi-block content", () => {
    const msgs: GatewayMessage[] = [
      userMsgMultiBlock("Do something", "\n[lore:project=/home/user/project]"),
    ];
    expect(extractProjectMarker(msgs)).toBe("/home/user/project");
  });

  test("handles both markers in same message", () => {
    const msgs: GatewayMessage[] = [
      userMsg(
        "Query here\n[lore:session-id=abc123def456]\n[lore:project=/home/user/project]",
      ),
    ];
    expect(extractProjectMarker(msgs)).toBe("/home/user/project");
    expect(extractSessionMarker(msgs)).toBe("abc123def456");
  });

  test("rejects path traversal with ..", () => {
    const msgs: GatewayMessage[] = [
      userMsg("[lore:project=/home/user/../../etc]"),
    ];
    expect(extractProjectMarker(msgs)).toBeUndefined();
  });

  test("strips control characters", () => {
    const msgs: GatewayMessage[] = [
      userMsg("[lore:project=/home/user/proj\x00ect]"),
    ];
    expect(extractProjectMarker(msgs)).toBe("/home/user/project");
  });

  test("rejects paths exceeding max length", () => {
    const longPath = `/home/${"a".repeat(1020)}`;
    const msgs: GatewayMessage[] = [userMsg(`[lore:project=${longPath}]`)];
    expect(extractProjectMarker(msgs)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stripContextMarkers
// ---------------------------------------------------------------------------

describe("stripContextMarkers", () => {
  test("removes session-id marker from user message", () => {
    const msgs: GatewayMessage[] = [
      userMsg("Hello world\n[lore:session-id=abc123def456]"),
    ];
    stripContextMarkers(msgs);
    expect(msgs[0].content[0]).toEqual({ type: "text", text: "Hello world" });
  });

  test("removes project marker from user message", () => {
    const msgs: GatewayMessage[] = [
      userMsg("Hello\n[lore:project=/home/user/project]"),
    ];
    stripContextMarkers(msgs);
    expect(msgs[0].content[0]).toEqual({ type: "text", text: "Hello" });
  });

  test("removes both markers", () => {
    const msgs: GatewayMessage[] = [
      userMsg(
        "Query\n[lore:session-id=aabb11223344]\n[lore:project=/home/user/proj]",
      ),
    ];
    stripContextMarkers(msgs);
    expect(msgs[0].content[0]).toEqual({ type: "text", text: "Query" });
  });

  test("does not modify assistant messages", () => {
    const msgs: GatewayMessage[] = [
      assistantMsg("Response with [lore:session-id=abc123def456]"),
    ];
    stripContextMarkers(msgs);
    expect(
      (msgs[0].content[0] as { type: "text"; text: string }).text,
    ).toContain("[lore:session-id=");
  });

  test("does not modify messages without markers", () => {
    const msgs: GatewayMessage[] = [userMsg("Just a normal message")];
    stripContextMarkers(msgs);
    expect(msgs[0].content[0]).toEqual({
      type: "text",
      text: "Just a normal message",
    });
  });

  test("handles multi-block content", () => {
    const msgs: GatewayMessage[] = [
      userMsgMultiBlock("Do something", "\n[lore:session-id=aabb11223344]"),
    ];
    stripContextMarkers(msgs);
    // First block unchanged, second block stripped
    expect((msgs[0].content[0] as { type: "text"; text: string }).text).toBe(
      "Do something",
    );
    expect((msgs[0].content[1] as { type: "text"; text: string }).text).toBe(
      "",
    );
  });
});
