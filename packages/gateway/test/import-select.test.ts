import { describe, test, expect, vi } from "vitest";
import {
  parseIndexSelection,
  selectIndices,
  applyAgentFilter,
  filterAlreadyImported,
} from "../src/cli/import";
import type { conversationImport } from "@loreai/core";

type DetectionResult = conversationImport.DetectionResult;
type DetectedSession = conversationImport.DetectedSession;

function makeSession(
  overrides: Partial<DetectedSession> = {},
): DetectedSession {
  return {
    id: "sess-1",
    label: "Test session",
    startedAt: 1_000,
    lastActivityAt: 2_000,
    estimatedTokens: 500,
    messageCount: 10,
    ...overrides,
  };
}

function makeResult(
  agentName: string,
  sessions: DetectedSession[],
): DetectionResult {
  return {
    agentName,
    agentDisplayName: agentName,
    sessions,
    totalMessages: sessions.reduce((s, x) => s + x.messageCount, 0),
    totalTokens: sessions.reduce((s, x) => s + x.estimatedTokens, 0),
  };
}

// A stable hash for tests: encode the two fields we key on.
const hashOf = (s: { messageCount: number; lastActivityAt: number }) =>
  `${s.messageCount}:${s.lastActivityAt}`;

describe("parseIndexSelection", () => {
  test("empty / 'a' / 'all' select everything", () => {
    expect(parseIndexSelection("", 3)).toEqual([0, 1, 2]);
    expect(parseIndexSelection("  ", 3)).toEqual([0, 1, 2]);
    expect(parseIndexSelection("a", 3)).toEqual([0, 1, 2]);
    expect(parseIndexSelection("all", 3)).toEqual([0, 1, 2]);
    expect(parseIndexSelection("ALL", 3)).toEqual([0, 1, 2]);
  });

  test("comma-separated 1-based indices map to 0-based", () => {
    expect(parseIndexSelection("1,3", 3)).toEqual([0, 2]);
    expect(parseIndexSelection("2", 3)).toEqual([1]);
  });

  test("accepts whitespace and mixed separators", () => {
    expect(parseIndexSelection("1 3", 3)).toEqual([0, 2]);
    expect(parseIndexSelection(" 1 , 2 ", 3)).toEqual([0, 1]);
  });

  test("collapses duplicates and sorts ascending", () => {
    expect(parseIndexSelection("3,1,3,1", 3)).toEqual([0, 2]);
  });

  test("rejects out-of-range indices", () => {
    expect(parseIndexSelection("0", 3)).toBeNull(); // 1-based, 0 invalid
    expect(parseIndexSelection("4", 3)).toBeNull();
    expect(parseIndexSelection("1,9", 3)).toBeNull();
  });

  test("rejects non-numeric tokens", () => {
    expect(parseIndexSelection("x", 3)).toBeNull();
    expect(parseIndexSelection("1,x", 3)).toBeNull();
    expect(parseIndexSelection("1.5", 3)).toBeNull();
  });
});

describe("selectIndices", () => {
  test("returns parsed selection from the injected reader", async () => {
    const reader = vi.fn(async () => "1,3");
    const result = await selectIndices(3, { reader });
    expect(result).toEqual([0, 2]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  test("empty answer selects all", async () => {
    const reader = vi.fn(async () => "");
    const result = await selectIndices(2, { reader });
    expect(result).toEqual([0, 1]);
  });

  test("re-prompts on invalid input then accepts", async () => {
    const answers = ["nope", "9", "2"];
    let i = 0;
    const reader = vi.fn(async () => answers[i++]);
    const result = await selectIndices(3, { reader, maxTries: 3 });
    expect(result).toEqual([1]);
    expect(reader).toHaveBeenCalledTimes(3);
  });

  test("falls back to all after exhausting invalid attempts", async () => {
    const reader = vi.fn(async () => "bogus");
    const result = await selectIndices(3, { reader, maxTries: 2 });
    expect(result).toEqual([0, 1, 2]);
    expect(reader).toHaveBeenCalledTimes(2);
  });
});

describe("applyAgentFilter", () => {
  const results = [
    makeResult("codex", [makeSession()]),
    makeResult("claude-code", [makeSession({ id: "c1" })]),
  ];

  test("returns all results when filter is null", () => {
    expect(applyAgentFilter(results, null)).toBe(results);
  });

  test("keeps only the matching agent", () => {
    const filtered = applyAgentFilter(results, "codex");
    expect(filtered.map((r) => r.agentName)).toEqual(["codex"]);
  });

  test("returns empty when no agent matches", () => {
    expect(applyAgentFilter(results, "nonexistent")).toEqual([]);
  });
});

describe("filterAlreadyImported", () => {
  test("local mode: drops sessions already in the local DB", () => {
    const dupe = makeSession({
      id: "dupe",
      messageCount: 5,
      lastActivityAt: 9,
    });
    const fresh = makeSession({
      id: "fresh",
      messageCount: 7,
      lastActivityAt: 8,
    });
    const results = [makeResult("codex", [dupe, fresh])];

    const isImportedLocal = vi.fn(
      (_p: string, _a: string, sourceId: string) => sourceId === "dupe",
    );

    const out = filterAlreadyImported(results, {
      projectPath: "/p",
      hashOf,
      isImportedLocal,
      // remoteImports omitted → local path
    });

    expect(out.length).toBe(1);
    expect(out[0].sessions.map((s) => s.id)).toEqual(["fresh"]);
    // totals recomputed over the surviving session
    expect(out[0].totalMessages).toBe(7);
    expect(out[0].totalTokens).toBe(500);
    expect(isImportedLocal).toHaveBeenCalled();
  });

  test("local mode: removes an agent left with zero new sessions", () => {
    const results = [
      makeResult("codex", [makeSession({ id: "a" })]),
      makeResult("pi", [makeSession({ id: "b" })]),
    ];
    // codex fully imported, pi entirely new
    const isImportedLocal = (_p: string, agent: string) => agent === "codex";

    const out = filterAlreadyImported(results, {
      projectPath: "/p",
      hashOf,
      isImportedLocal,
    });

    expect(out.map((r) => r.agentName)).toEqual(["pi"]);
  });

  test("remote mode: dedups against remote import history, never touches local", () => {
    const dupe = makeSession({
      id: "r-dupe",
      messageCount: 3,
      lastActivityAt: 4,
    });
    const fresh = makeSession({
      id: "r-fresh",
      messageCount: 6,
      lastActivityAt: 5,
    });
    const results = [makeResult("claude-code", [dupe, fresh])];

    const isImportedLocal = vi.fn(() => false);
    const remoteImports = [
      {
        agent_name: "claude-code",
        source_id: "r-dupe",
        source_hash: hashOf({ messageCount: 3, lastActivityAt: 4 }),
      },
    ];

    const out = filterAlreadyImported(results, {
      projectPath: "/p",
      hashOf,
      remoteImports,
      isImportedLocal,
    });

    expect(out[0].sessions.map((s) => s.id)).toEqual(["r-fresh"]);
    // remote path must NOT consult the local DB
    expect(isImportedLocal).not.toHaveBeenCalled();
  });

  test("remote mode: a hash mismatch is treated as a new (not-yet-imported) session", () => {
    const sess = makeSession({ id: "x", messageCount: 3, lastActivityAt: 4 });
    const results = [makeResult("codex", [sess])];
    const remoteImports = [
      {
        agent_name: "codex",
        source_id: "x",
        source_hash: "stale-hash", // same id, different content hash
      },
    ];

    const out = filterAlreadyImported(results, {
      projectPath: "/p",
      hashOf,
      remoteImports,
      isImportedLocal: () => false,
    });

    expect(out[0].sessions.map((s) => s.id)).toEqual(["x"]);
  });

  test("skips agents with no registered provider", () => {
    const results = [makeResult("ghost", [makeSession({ id: "g" })])];
    const isImportedLocal = vi.fn(() => false);

    const out = filterAlreadyImported(results, {
      projectPath: "/p",
      hashOf,
      isImportedLocal,
      hasProvider: () => false, // provider missing
    });

    // Agent skipped entirely — its sessions are left untouched, and since it
    // still has sessions it survives the empty-filter (matches production:
    // `getProvider` guard `continue`s, agent kept).
    expect(out.map((r) => r.agentName)).toEqual(["ghost"]);
    expect(isImportedLocal).not.toHaveBeenCalled();
  });

  test("returns empty when every session is already imported", () => {
    const results = [makeResult("codex", [makeSession({ id: "a" })])];
    const out = filterAlreadyImported(results, {
      projectPath: "/p",
      hashOf,
      isImportedLocal: () => true,
    });
    expect(out).toEqual([]);
  });
});
