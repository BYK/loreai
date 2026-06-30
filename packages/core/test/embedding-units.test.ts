import { describe, test, expect } from "vitest";
import {
  buildEmbeddingUnits,
  buildEmbeddingText,
  TOOL_FIRST_LINE_MAX,
} from "../src/embedding-units";
import { partsToText } from "../src/temporal";
import type { LorePart } from "../src/types";
import {
  embedTemporalMessage,
  _saveAndClearProvider,
  _restoreProvider,
} from "../src/embedding";

// Part fixtures — mirror the producers in temporal.partsToText (and the helpers
// in distillation.test.ts) so content strings are byte-identical to production.
function textPart(text: string): LorePart {
  return { type: "text", text } as LorePart;
}
function reasoningPart(text: string): LorePart {
  return { type: "reasoning", text } as LorePart;
}
function toolPart(tool: string, output: string): LorePart {
  return {
    type: "tool",
    tool,
    state: { status: "completed", output },
  } as unknown as LorePart;
}

describe("buildEmbeddingUnits", () => {
  test("keeps a plain-text part verbatim", () => {
    expect(buildEmbeddingUnits("hello world")).toEqual([
      { kind: "text", text: "hello world" },
    ]);
  });

  test("keeps a reasoning part verbatim (with its prefix)", () => {
    expect(buildEmbeddingUnits("[reasoning] thinking it through")).toEqual([
      { kind: "reasoning", text: "[reasoning] thinking it through" },
    ]);
  });

  test("reduces a tool envelope to header + first line, dropping the body", () => {
    const content = partsToText([
      textPart("Investigating the crash."),
      toolPart("read", `src/server.ts\n${"BODY ".repeat(2000)}`),
    ]);
    const units = buildEmbeddingUnits(content);
    expect(units).toHaveLength(2);
    expect(units[0]).toEqual({
      kind: "text",
      text: "Investigating the crash.",
    });
    expect(units[1]).toEqual({
      kind: "tool",
      tool: "read",
      text: "[tool:read] src/server.ts",
    });
  });

  test("handles an empty tool output (header only, no trailing space)", () => {
    // partsToText renders this as "[tool:bash] " (trailing space, empty body).
    const units = buildEmbeddingUnits(partsToText([toolPart("bash", "")]));
    expect(units).toEqual([
      { kind: "tool", tool: "bash", text: "[tool:bash]" },
    ]);
  });

  test("does NOT promote a [tool:...] line embedded inside another tool's output", () => {
    // A read of a file that documents this very format: the embedded
    // "[tool:bash]" line lives inside the read envelope and must be dropped
    // with the body, never split into its own unit.
    const adversarial = [
      "reading AGENTS.md",
      "[tool:bash] this is INSIDE the payload, not a real envelope",
      "still inside the read output",
    ].join("\n");
    const content = partsToText([
      textPart("Searching for the format spec."),
      toolPart("read", adversarial),
      textPart("Found it."),
    ]);
    const units = buildEmbeddingUnits(content);
    expect(units).toHaveLength(3);
    expect(units[1]).toEqual({
      kind: "tool",
      tool: "read",
      text: "[tool:read] reading AGENTS.md",
    });
    // The embedded bash line never becomes a unit of its own.
    expect(units.some((u) => u.tool === "bash")).toBe(false);
  });

  test("caps an oversized single-line tool output at TOOL_FIRST_LINE_MAX", () => {
    const giant = "A".repeat(TOOL_FIRST_LINE_MAX + 500); // one line, no newline
    const units = buildEmbeddingUnits(partsToText([toolPart("bash", giant)]));
    expect(units).toHaveLength(1);
    const [u] = units;
    expect(u.text.startsWith("[tool:bash] AAAA")).toBe(true);
    expect(u.text.length).toBe("[tool:bash] ".length + TOOL_FIRST_LINE_MAX);
  });

  test("leaves a malformed tool envelope (no '] ' delimiter) as text", () => {
    expect(buildEmbeddingUnits("[tool:weird")).toEqual([
      { kind: "text", text: "[tool:weird" },
    ]);
  });
});

describe("buildEmbeddingText", () => {
  test("preserves prose and reasoning but drops bulky tool bodies", () => {
    const body = "SECRET_BODY ".repeat(3000); // ~36 KB that must not be embedded
    const content = partsToText([
      textPart("Prose stays."),
      reasoningPart("Reasoning stays."),
      toolPart("read", `path/to/file.ts\n${body}`),
    ]);
    const text = buildEmbeddingText(content);
    expect(text).toContain("Prose stays.");
    expect(text).toContain("[reasoning] Reasoning stays.");
    expect(text).toContain("[tool:read] path/to/file.ts");
    // The dominant body is gone — both as a substring and by total size.
    expect(text).not.toContain("SECRET_BODY");
    expect(text.length).toBeLessThan(200);
  });

  test("returns empty string for empty content", () => {
    expect(buildEmbeddingText("")).toBe("");
  });
});

describe("partsToText → buildEmbeddingUnits round trip", () => {
  // Pins the local CHUNK separator against temporal.partsToText: if the
  // producer's terminator ever changes, this split returns one fused unit and
  // the kind sequence below no longer matches.
  test("recovers one unit per part with the correct kinds and reductions", () => {
    const content = partsToText([
      textPart("alpha"),
      reasoningPart("beta"),
      toolPart("grep", "gamma\nmore output lines"),
      textPart("delta"),
    ]);
    const units = buildEmbeddingUnits(content);
    expect(units.map((u) => u.kind)).toEqual([
      "text",
      "reasoning",
      "tool",
      "text",
    ]);
    expect(units.map((u) => u.text)).toEqual([
      "alpha",
      "[reasoning] beta",
      "[tool:grep] gamma",
      "delta",
    ]);
  });
});

describe("embedTemporalMessage wiring", () => {
  test("embeds the reduced text, not the raw content", async () => {
    const body = "X".repeat(5000);
    const content = partsToText([
      textPart("Debugging the failing test."),
      toolPart("read", `src/foo.ts\n${body}`),
    ]);

    let captured: string[] | null = null;
    let resolveCaptured!: () => void;
    const captureDone = new Promise<void>((r) => (resolveCaptured = r));

    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            captured = texts;
            resolveCaptured();
            return texts.map(() => new Float32Array([1, 0, 0]));
          },
        },
      });
      embedTemporalMessage("wiring-msg-1", content);
      await captureDone;

      expect(captured).not.toBeNull();
      const sent = captured?.[0];
      // Exactly the part-selective reduction — embed() passes text through
      // untouched, so this is byte-identical to buildEmbeddingText(content).
      expect(sent).toBe(buildEmbeddingText(content));
      expect(sent).toContain("Debugging the failing test.");
      expect(sent).toContain("[tool:read] src/foo.ts");
      // The 5 KB tool body never reaches the embedder (it stays in FTS only).
      expect(sent).not.toContain("XX");
    } finally {
      _restoreProvider(token);
    }
  });
});
