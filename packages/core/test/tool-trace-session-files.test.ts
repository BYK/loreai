import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject, projectId } from "../src/db";
import { recordToolCalls } from "../src/temporal";
import * as toolTrace from "../src/tool-trace";
import type { LoreMessage, LorePart } from "../src/types";

// D2c PR-2: sessionFileTouches — per-session summary of distinct files
// tool calls acted on. Backed by tool_calls.input_paths_json (the JSON array
// written by recordToolCalls in PR-1b), walked via SQLite's json_each so a
// single multi-path bash command surfaces every path it touched.

const PROJECT = "/test/d2c-pr2/session-files";
const SESSION = "sess-1";

function makeMessage(id: string): LoreMessage {
  return {
    id,
    sessionID: SESSION,
    role: "assistant",
    time: { created: 1_700_000_000_000 },
    parentID: "parent-1",
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: PROJECT, root: PROJECT },
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
    sessionID: SESSION,
    messageID,
    type: "tool",
    tool,
    callID,
    // Wrap the caller's state in a proper LoreToolState shape (status must be
    // present so toolOutcome() in temporal.ts can read it without crashing).
    state: { status: "pending", ...state } as Record<string, unknown>,
  };
}

describe("sessionFileTouches (D2c PR-2)", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
  });

  test("returns empty arrays for a session with no tool calls", () => {
    const got = toolTrace.sessionFileTouches(PROJECT, SESSION);
    expect(got.paths).toEqual([]);
    expect(got.counts).toEqual({});
  });

  test("returns empty arrays for an unknown session_id", () => {
    recordToolCalls({
      projectPath: PROJECT,
      info: makeMessage("m1"),
      parts: [
        toolPart("m1", "c1", "Read", {
          input: { filePath: "src/a.ts" },
        }),
      ],
    });
    const got = toolTrace.sessionFileTouches(PROJECT, "no-such-session");
    expect(got.paths).toEqual([]);
  });

  test("aggregates single-path tool calls (Read/Edit/Write) by file", () => {
    recordToolCalls({
      projectPath: PROJECT,
      info: makeMessage("m1"),
      parts: [
        toolPart("m1", "c1", "Read", { input: { filePath: "src/a.ts" } }),
        toolPart("m1", "c2", "Edit", { input: { filePath: "src/a.ts" } }),
        toolPart("m1", "c3", "Write", { input: { filePath: "src/b.ts" } }),
      ],
    });
    const got = toolTrace.sessionFileTouches(PROJECT, SESSION);
    // Sorted by hits DESC, path ASC: a.ts has 2 hits, b.ts has 1.
    expect(got.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(got.counts).toEqual({ "src/a.ts": 2, "src/b.ts": 1 });
  });

  test("multi-path bash command (input_paths_json array) expands via json_each", () => {
    // Manually insert a tool_calls row with a multi-path JSON array to test
    // the json_each path directly (recordToolCalls always passes through
    // extractFilePaths which produces an array — so this is the production
    // shape, not a synthetic edge).
    recordToolCalls({
      projectPath: PROJECT,
      info: makeMessage("m1"),
      parts: [
        toolPart("m1", "c1", "bash", {
          input: { command: "cat a.ts b.ts > out.ts" },
        }),
      ],
    });
    const got = toolTrace.sessionFileTouches(PROJECT, SESSION);
    expect(new Set(got.paths)).toEqual(new Set(["a.ts", "b.ts", "out.ts"]));
    // Each path appears exactly once.
    for (const p of got.paths) {
      expect(got.counts[p]).toBe(1);
    }
  });

  test("limit caps the returned paths but preserves hit-count ordering", () => {
    recordToolCalls({
      projectPath: PROJECT,
      info: makeMessage("m1"),
      parts: [
        toolPart("m1", "c1", "Read", { input: { filePath: "src/a.ts" } }),
        toolPart("m1", "c2", "Read", { input: { filePath: "src/b.ts" } }),
        toolPart("m1", "c3", "Read", { input: { filePath: "src/c.ts" } }),
        toolPart("m1", "c4", "Read", { input: { filePath: "src/d.ts" } }),
      ],
    });
    const got = toolTrace.sessionFileTouches(PROJECT, SESSION, { limit: 2 });
    expect(got.paths).toHaveLength(2);
    // All four have 1 hit; tiebreak is alphabetical ASC.
    expect(got.paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("scopes to project_id (does not leak other projects)", () => {
    const OTHER = "/test/d2c-pr2/session-files-other";
    ensureProject(OTHER);
    recordToolCalls({
      projectPath: PROJECT,
      info: makeMessage("m1"),
      parts: [
        toolPart("m1", "c1", "Read", { input: { filePath: "src/our.ts" } }),
      ],
    });
    recordToolCalls({
      projectPath: OTHER,
      info: { ...makeMessage("m2"), sessionID: "sess-other" },
      parts: [
        {
          ...toolPart("m2", "c2", "Read", {
            input: { filePath: "src/their.ts" },
          }),
          sessionID: "sess-other",
        },
      ],
    });
    const ourGot = toolTrace.sessionFileTouches(PROJECT, SESSION);
    expect(ourGot.paths).toEqual(["src/our.ts"]);
    expect(ourGot.counts["src/their.ts"]).toBeUndefined();
  });

  test("ensureProject returns a string id (regression check)", () => {
    expect(typeof projectId(PROJECT)).toBe("string");
  });
});
