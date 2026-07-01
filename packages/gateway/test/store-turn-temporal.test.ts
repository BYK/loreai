import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, ensureProject } from "@loreai/core";
import { storeTurnTemporal } from "../src/pipeline";
import { gatewayMessagesToLore } from "../src/temporal-adapter";
import type { GatewayContentBlock, GatewayUsage } from "../src/translate/types";

// #1084: storeTurnTemporal batches a turn's four temporal writes (user store +
// tool-calls, assistant store + tool-calls) into ONE savepoint. The rows written
// must be identical to the pre-batch behavior; only the number of commits drops.

const PROJECT = "/test/store-turn-temporal";
const USAGE: GatewayUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

let sessionCounter = 0;
function freshSession(): string {
  return `stt-sess-${sessionCounter++}`;
}

function userMessages(sessionID: string, text: string) {
  return gatewayMessagesToLore(
    [{ role: "user", content: [{ type: "text", text }] }],
    sessionID,
  );
}

function rowsFor(sessionID: string) {
  return db()
    .query(
      "SELECT role, content FROM temporal_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(sessionID) as Array<{ role: string; content: string }>;
}

beforeEach(() => {
  ensureProject(PROJECT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("storeTurnTemporal (#1084)", () => {
  it("stores the user + assistant messages for a normal turn", () => {
    const SESSION = freshSession();
    const loreMessages = userMessages(SESSION, "hello from the user");
    const assistantContentBlocks: GatewayContentBlock[] = [
      { type: "text", text: "hello from the assistant" },
    ];

    storeTurnTemporal({
      loreMessages,
      assistantContentBlocks,
      usage: USAGE,
      model: "claude-sonnet-4-20250514",
      projectPath: PROJECT,
      sessionID: SESSION,
      noStore: false,
    });

    const rows = rowsFor(SESSION);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows.find((r) => r.role === "user")?.content).toContain(
      "hello from the user",
    );
    expect(rows.find((r) => r.role === "assistant")?.content).toContain(
      "hello from the assistant",
    );
  });

  it("writes NOTHING in no-store mode (but still resolves in-memory)", () => {
    const SESSION = freshSession();
    // A tool_result-bearing user message so resolveToolResults has an observable
    // in-memory effect (it strips the tool_result → placeholder).
    const loreMessages = gatewayMessagesToLore(
      [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tu-nostore",
              content: [{ type: "text", text: "secret tool output" }],
            },
          ],
        },
      ],
      SESSION,
    );
    const before = JSON.stringify(loreMessages);
    const assistantContentBlocks: GatewayContentBlock[] = [
      { type: "text", text: "secret assistant message" },
    ];

    storeTurnTemporal({
      loreMessages,
      assistantContentBlocks,
      usage: USAGE,
      model: "claude-sonnet-4-20250514",
      projectPath: PROJECT,
      sessionID: SESSION,
      noStore: true,
    });

    // Nothing persisted …
    expect(rowsFor(SESSION)).toEqual([]);
    // … but resolveToolResults still ran (it mutated loreMessages in place —
    // downstream reconstruct-after-eviction depends on this).
    expect(JSON.stringify(loreMessages)).not.toBe(before);
  });

  it("stores the user message with its ORIGINAL tool_result content (before resolveToolResults strips it)", () => {
    const SESSION = freshSession();
    const loreMessages = gatewayMessagesToLore(
      [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tu-1",
              content: [{ type: "text", text: "DISTINCTIVE_TOOL_OUTPUT_XYZ" }],
            },
          ],
        },
      ],
      SESSION,
    );

    storeTurnTemporal({
      loreMessages,
      assistantContentBlocks: [{ type: "text", text: "ack" }],
      usage: USAGE,
      model: "claude-sonnet-4-20250514",
      projectPath: PROJECT,
      sessionID: SESSION,
      noStore: false,
    });

    // The user row must carry the ORIGINAL tool output, NOT the
    // "[tool results provided]" placeholder resolveToolResults produces — which
    // proves the user store happened BEFORE the resolve (ordering invariant).
    const userRow = rowsFor(SESSION).find((r) => r.role === "user");
    expect(userRow?.content).toContain("DISTINCTIVE_TOOL_OUTPUT_XYZ");
    expect(userRow?.content).not.toContain("tool results provided");
  });

  it("batches the writes into a single savepoint (one SAVEPOINT + one RELEASE)", () => {
    const SESSION = freshSession();
    const loreMessages = userMessages(SESSION, "batched turn");
    const assistantContentBlocks: GatewayContentBlock[] = [
      { type: "text", text: "batched reply" },
    ];

    const execSpy = vi.spyOn(db(), "exec");
    storeTurnTemporal({
      loreMessages,
      assistantContentBlocks,
      usage: USAGE,
      model: "claude-sonnet-4-20250514",
      projectPath: PROJECT,
      sessionID: SESSION,
      noStore: false,
    });

    const execs = execSpy.mock.calls.map((c) => String(c[0]));
    expect(
      execs.filter((s) => s === "SAVEPOINT post_response_temporal").length,
    ).toBe(1);
    expect(
      execs.filter((s) => s === "RELEASE post_response_temporal").length,
    ).toBe(1);
    // Success path: no rollback.
    expect(
      execs.some((s) => s.startsWith("ROLLBACK TO post_response_temporal")),
    ).toBe(false);
    // And the rows landed.
    expect(rowsFor(SESSION).length).toBe(2);
    // Atomicity on a mid-batch throw (ROLLBACK TO) is guaranteed by
    // withSavepoint's own contract/tests — this test only proves the four writes
    // are wrapped in exactly one savepoint.
  });
});
