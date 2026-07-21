import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import { extractFilePath } from "../src/tool-trace";
import type { LoreMessage, LorePart } from "../src/types";

// D2c PR-1 (#627 Step 1): capture the source-file path a tool call acted on into
// tool_calls.input_path — session→file provenance, the substrate for associating
// knowledge entries with the files that produced them.

describe("extractFilePath", () => {
  test("reads path from an object input ({ path })", () => {
    expect(extractFilePath({ path: "src/auth/jwt.ts" })).toBe(
      "src/auth/jwt.ts",
    );
  });

  test("reads filePath and file keys", () => {
    expect(extractFilePath({ filePath: "a/b.ts" })).toBe("a/b.ts");
    expect(extractFilePath({ file: "c/d.ts" })).toBe("c/d.ts");
  });

  test("prefers path over filePath over file", () => {
    expect(
      extractFilePath({ path: "p.ts", filePath: "fp.ts", file: "f.ts" }),
    ).toBe("p.ts");
    expect(extractFilePath({ filePath: "fp.ts", file: "f.ts" })).toBe("fp.ts");
  });

  test("parses a JSON string input", () => {
    expect(extractFilePath('{"path":"src/x.ts"}')).toBe("src/x.ts");
  });

  test("falls back to a path-like token in a plain-text string", () => {
    expect(extractFilePath("editing packages/core/src/db.ts now")).toBe(
      "packages/core/src/db.ts",
    );
  });

  test("returns undefined for non-file tool inputs", () => {
    expect(extractFilePath({ command: "pnpm test" })).toBeUndefined();
    expect(extractFilePath({ pattern: "TODO" })).toBeUndefined();
    expect(extractFilePath("just some prose with no path")).toBeUndefined();
    expect(extractFilePath(null)).toBeUndefined();
    expect(extractFilePath(undefined)).toBeUndefined();
    expect(extractFilePath(42)).toBeUndefined();
  });

  test("ignores an empty-string path", () => {
    expect(extractFilePath({ path: "" })).toBeUndefined();
  });

  test("a `/`-free string is skipped without running the regex", () => {
    // No slash → cannot be a path → cheap early return (also the ReDoS skip).
    expect(extractFilePath("no slashes here just prose words")).toBeUndefined();
  });

  test("does not stall on a pathological long slash-run (ReDoS guard)", () => {
    // A long run of slash-separated tokens with no matching extension is the
    // super-linear-backtracking worst case for the fallback regex. With the
    // length cap + slash skip this must return promptly, not hang.
    const evil = `${"a/".repeat(50_000)}bbbbbbbbbbbb`;
    const start = Date.now();
    const result = extractFilePath(evil);
    const elapsed = Date.now() - start;
    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(1000);
  });
});

const TOOL_PROJECT = "/test/temporal/input-path";

function makeMessage(id: string, sessionID: string): LoreMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1_700_000_000_000 },
    parentID: "parent-1",
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function toolPart(
  messageID: string,
  callID: string,
  tool: string,
  state: Record<string, unknown>,
): LorePart {
  return {
    id: `tp-${callID}`,
    sessionID: "sess-ip",
    messageID,
    type: "tool",
    tool,
    callID,
    state,
  };
}

function pathOf(pid: string, callId: string): string | null {
  return (
    (
      db()
        .query(
          "SELECT input_path FROM tool_calls WHERE project_id = ? AND call_id = ?",
        )
        .get(pid, callId) as { input_path: string | null } | null
    )?.input_path ?? null
  );
}

describe("recordToolCalls populates input_path (D2c PR-1)", () => {
  beforeEach(() => {
    const pid = ensureProject(TOOL_PROJECT);
    db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
  });

  test("stores the path for file tools and NULL for non-file tools", () => {
    const pid = ensureProject(TOOL_PROJECT);
    const info = makeMessage("m-ip", "sess-ip");
    const parts: LorePart[] = [
      toolPart("m-ip", "r1", "read", {
        status: "pending",
        input: { path: "src/auth/jwt.ts" },
      }),
      toolPart("m-ip", "e1", "edit", {
        status: "pending",
        input: { filePath: "src/config.ts" },
      }),
      toolPart("m-ip", "b1", "bash", {
        status: "pending",
        input: { command: "pnpm test" },
      }),
      toolPart("m-ip", "g1", "grep", {
        status: "pending",
        input: { pattern: "TODO" },
      }),
    ];
    temporal.recordToolCalls({ projectPath: TOOL_PROJECT, info, parts });

    expect(pathOf(pid, "r1")).toBe("src/auth/jwt.ts");
    expect(pathOf(pid, "e1")).toBe("src/config.ts");
    expect(pathOf(pid, "b1")).toBeNull();
    expect(pathOf(pid, "g1")).toBeNull();
  });

  test("a re-seed never clobbers a captured path (COALESCE keeps first non-null)", () => {
    const pid = ensureProject(TOOL_PROJECT);
    const info = makeMessage("m-re", "sess-ip");
    const withPath: LorePart[] = [
      toolPart("m-re", "rx", "read", {
        status: "pending",
        input: { path: "src/first.ts" },
      }),
    ];
    temporal.recordToolCalls({
      projectPath: TOOL_PROJECT,
      info,
      parts: withPath,
    });
    // Re-seed the SAME call_id with no recoverable path (retry / re-delivery).
    const noPath: LorePart[] = [
      toolPart("m-re", "rx", "read", { status: "pending", input: {} }),
    ];
    temporal.recordToolCalls({
      projectPath: TOOL_PROJECT,
      info,
      parts: noPath,
    });
    expect(pathOf(pid, "rx")).toBe("src/first.ts");

    // Re-seed with a DIFFERENT non-null path — the first captured path must WIN
    // (COALESCE direction: keep existing, never overwrite). Guards against a
    // reversed COALESCE that would silently clobber provenance on re-delivery.
    const otherPath: LorePart[] = [
      toolPart("m-re", "rx", "read", {
        status: "pending",
        input: { path: "src/second.ts" },
      }),
    ];
    temporal.recordToolCalls({
      projectPath: TOOL_PROJECT,
      info,
      parts: otherPath,
    });
    expect(pathOf(pid, "rx")).toBe("src/first.ts");
  });
});
