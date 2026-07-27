import { beforeEach, describe, expect, test } from "vitest";
import { buildFilesTouchedContext } from "../src/curator";
import { db, ensureProject } from "../src/db";
import { recordToolCalls } from "../src/temporal";
import type { LoreMessage, LorePart } from "../src/types";

// D2c PR-2: buildFilesTouchedContext — the curator's per-session "what files
// were touched" prompt-context block. Mirrors buildActionTagContext shape:
// compact markdown, top-N sorted, "" when empty.

const PROJ = "/test/d2c-pr2/files-touched-ctx";
const SESS = "sess-curator-ctx";

function makeMessage(): LoreMessage {
  return {
    id: "m-ctx",
    sessionID: SESS,
    role: "assistant",
    time: { created: 1_700_000_000_000 },
    parentID: "p",
    modelID: "x",
    providerID: "y",
    mode: "build",
    path: { cwd: PROJ, root: PROJ },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function toolPart(callID: string, tool: string, input: unknown): LorePart {
  return {
    id: `tp-${callID}`,
    sessionID: SESS,
    messageID: "m-ctx",
    type: "tool",
    tool,
    callID,
    state: { status: "pending", input } as Record<string, unknown>,
  };
}

describe("buildFilesTouchedContext (D2c PR-2)", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
  });

  test("returns '' when projectPath is missing (graceful no-op)", () => {
    expect(buildFilesTouchedContext("", SESS)).toBe("");
  });

  test("returns '' when sessionID is missing (graceful no-op)", () => {
    expect(buildFilesTouchedContext(PROJ, "")).toBe("");
  });

  test("returns '' when no files have been touched this session", () => {
    expect(buildFilesTouchedContext(PROJ, SESS)).toBe("");
  });

  test("returns a markdown block sorted by hit count DESC", () => {
    recordToolCalls({
      projectPath: PROJ,
      info: makeMessage(),
      parts: [
        toolPart("c1", "Read", { filePath: "src/a.ts" }),
        toolPart("c2", "Edit", { filePath: "src/a.ts" }),
        toolPart("c3", "Write", { filePath: "src/a.ts" }),
        toolPart("c4", "Read", { filePath: "src/b.ts" }),
      ],
    });
    const out = buildFilesTouchedContext(PROJ, SESS);
    expect(out).toContain("Files touched this session");
    expect(out).toContain("`src/a.ts` (3 hits)");
    expect(out).toContain("`src/b.ts` (1 hits)");
    // a.ts must appear before b.ts (hit-count order).
    const aIdx = out.indexOf("src/a.ts");
    const bIdx = out.indexOf("src/b.ts");
    expect(aIdx).toBeLessThan(bIdx);
  });

  test("caps at MAX_FILES_IN_CURATOR_CONTEXT (15)", () => {
    const parts: LorePart[] = [];
    for (let i = 0; i < 20; i++) {
      parts.push(toolPart(`c${i}`, "Read", { filePath: `src/file-${i}.ts` }));
    }
    recordToolCalls({
      projectPath: PROJ,
      info: makeMessage(),
      parts,
    });
    const out = buildFilesTouchedContext(PROJ, SESS);
    // Count occurrences of "- `src/" — should be exactly 15.
    const matches = out.match(/- `src\//g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(15);
  });
});
