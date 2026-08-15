import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  close,
  db,
  ensureProject,
  recallById,
  temporal,
  withTenant,
  LOCAL_TENANT_ID,
} from "@loreai/core";
import { storeTurnTemporal } from "../src/pipeline";
import {
  deterministicID,
  gatewayMessagesToLore,
  legacyDeterministicID,
} from "../src/temporal-adapter";
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayUsage,
} from "../src/translate/types";

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

function identityRows(projectID: string, sessionID: string) {
  return db()
    .query(
      `SELECT id, source_id, role, content
         FROM temporal_messages
        WHERE project_id = ? AND session_id = ?
        ORDER BY created_at, rowid`,
    )
    .all(projectID, sessionID) as Array<{
    id: string;
    source_id: string | null;
    role: string;
    content: string;
  }>;
}

function markerRecallID(messages: ReturnType<typeof gatewayMessagesToLore>) {
  const marker = messages[2]?.parts[0];
  if (marker?.type !== "text" || typeof marker.text !== "string") {
    throw new Error("expected historical tool-result marker");
  }
  const id = marker.text.match(/\(t:([^)]*)\)$/)?.[1];
  if (!id) throw new Error("expected temporal recall ID");
  return id;
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

    const placeholder = loreMessages[0]?.parts[0];
    if (placeholder?.type !== "text" || typeof placeholder.text !== "string") {
      throw new Error("expected tool-result recall placeholder");
    }
    const recallID = placeholder.text.match(/\(t:([^)]*)\)$/)?.[1];
    expect(recallID).toMatch(/^lore_tm_v1_/);
    expect(recallById(`t:${recallID}`)).toContain(
      "DISTINCTIVE_TOOL_OUTPUT_XYZ",
    );
  });

  it.each(["fresh-first", "legacy-first"] as const)(
    "bridges pre-v82 gateway rows through the production path (%s)",
    (order) => {
      const projectPath = `/test/store-turn-temporal/v82-bridge-${order}`;
      const sessionID = `v82-bridge-session-${order}`;
      const otherSessionID = `${sessionID}-other`;
      const tenantID = (order === "fresh-first" ? "c" : "d").repeat(64);
      const callID = `legacy-call-${order}`;
      const toolOutput = `LEGACY_TOOL_OUTPUT_${order}`;
      const responseText = `same assistant acknowledgement ${order}`;
      const toolUse: GatewayContentBlock[] = [
        {
          type: "tool_use",
          id: callID,
          name: "read",
          input: { path: "legacy.ts" },
        },
      ];
      const toolResult: GatewayContentBlock[] = [
        {
          type: "tool_result",
          toolUseId: callID,
          content: [{ type: "text", text: toolOutput }],
        },
      ];
      const response: GatewayContentBlock[] = [
        { type: "text", text: responseText },
      ];
      const conversation: GatewayMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "read the legacy file" }],
        },
        { role: "assistant", content: toolUse },
        { role: "user", content: toolResult },
      ];
      const convertedBeforeMigration = gatewayMessagesToLore(
        conversation,
        sessionID,
      );
      const legacyUserID = convertedBeforeMigration[2].legacySourceID;
      if (!legacyUserID) throw new Error("expected legacy user identity");
      const legacyResponseID = legacyDeterministicID("assistant", 0, response);
      const legacyToolMessageID = legacyDeterministicID(
        "assistant",
        0,
        toolUse,
      );
      const projectID = ensureProject(projectPath);
      const responseParts = gatewayMessagesToLore(
        [{ role: "assistant", content: response }],
        sessionID,
        conversation.length,
      )[0].parts;

      db()
        .query(
          `INSERT INTO temporal_messages
             (id, source_id, project_id, session_id, role, content, tokens,
              distilled, created_at, metadata)
           VALUES (?, ?, ?, ?, 'user', ?, 1, 0, 1000, '{}'),
                  (?, ?, ?, ?, 'assistant', ?, 1, 0, 2000, '{}')`,
        )
        .run(
          legacyUserID,
          legacyUserID,
          projectID,
          sessionID,
          temporal.partsToText(convertedBeforeMigration[2].parts),
          legacyResponseID,
          legacyResponseID,
          projectID,
          sessionID,
          temporal.partsToText(responseParts),
        );
      db()
        .query(
          `INSERT INTO tool_calls
             (call_id, message_id, project_id, session_id, tool, status,
              created_at, verifier, input_paths_json)
           VALUES (?, ?, ?, ?, 'read', 'pending', 900, 0, '["legacy.ts"]')`,
        )
        .run(callID, legacyToolMessageID, projectID, sessionID);

      // Reproduce the real v81 layouts, then restart through migrate(). This
      // keeps IDs/FTS rows/tool data intact while v82 backfills source_id=id and
      // rebuilds the owned tool-call primary key.
      db().exec(`
        DROP INDEX idx_temporal_source_identity;
        ALTER TABLE temporal_messages DROP COLUMN source_id;
        DROP TABLE IF EXISTS tool_calls_v81_bridge;
        CREATE TABLE tool_calls_v81_bridge (
          call_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          tool TEXT NOT NULL,
          status TEXT NOT NULL,
          error_type TEXT,
          error_message TEXT,
          duration_ms INTEGER,
          created_at INTEGER NOT NULL,
          verifier INTEGER,
          input_paths_json TEXT
        );
        INSERT INTO tool_calls_v81_bridge
          (call_id, message_id, project_id, session_id, tool, status,
           error_type, error_message, duration_ms, created_at, verifier,
           input_paths_json)
        SELECT call_id, message_id, project_id, session_id, tool, status,
               error_type, error_message, duration_ms, created_at, verifier,
               input_paths_json
          FROM tool_calls;
        DROP TABLE tool_calls;
        ALTER TABLE tool_calls_v81_bridge RENAME TO tool_calls;
        CREATE INDEX idx_tool_calls_project_tool_status
          ON tool_calls (project_id, tool, status);
        CREATE INDEX idx_tool_calls_project_session
          ON tool_calls (project_id, session_id);
        UPDATE schema_version SET version = 81;
      `);
      close();
      expect(db().query("SELECT version FROM schema_version").get()).toEqual({
        version: 82,
      });

      const noStoreLore = gatewayMessagesToLore(conversation, sessionID);
      storeTurnTemporal({
        loreMessages: noStoreLore,
        assistantContentBlocks: response,
        usage: USAGE,
        model: "claude-sonnet-4-20250514",
        projectPath,
        sessionID,
        noStore: true,
      });
      expect(markerRecallID(noStoreLore)).toBe(legacyUserID);
      expect(identityRows(projectID, sessionID)).toEqual([
        expect.objectContaining({ id: legacyUserID, source_id: legacyUserID }),
        expect.objectContaining({
          id: legacyResponseID,
          source_id: legacyResponseID,
        }),
      ]);

      const runTurn = (
        tenant: string,
        activeSessionID: string,
        messages: GatewayMessage[] = conversation,
      ) => {
        const loreMessages = gatewayMessagesToLore(messages, activeSessionID);
        withTenant(tenant, () =>
          storeTurnTemporal({
            loreMessages,
            assistantContentBlocks: response,
            usage: USAGE,
            model: "claude-sonnet-4-20250514",
            projectPath,
            sessionID: activeSessionID,
            noStore: false,
          }),
        );
        return loreMessages;
      };
      const runFreshRows = () => {
        runTurn(LOCAL_TENANT_ID, otherSessionID);
        runTurn(tenantID, sessionID);
      };

      let migratedLore: ReturnType<typeof gatewayMessagesToLore>;
      if (order === "fresh-first") {
        runFreshRows();
        migratedLore = runTurn(LOCAL_TENANT_ID, sessionID);
      } else {
        migratedLore = runTurn(LOCAL_TENANT_ID, sessionID);
        runFreshRows();
      }

      const modernUserID = deterministicID(sessionID, "user", 2, toolResult);
      const modernResponseID = deterministicID(
        sessionID,
        "assistant",
        conversation.length,
        response,
      );
      expect(identityRows(projectID, sessionID)).toEqual([
        expect.objectContaining({
          id: legacyUserID,
          source_id: modernUserID,
          role: "user",
        }),
        expect.objectContaining({
          id: legacyResponseID,
          source_id: modernResponseID,
          role: "assistant",
        }),
      ]);
      expect(markerRecallID(migratedLore)).toBe(legacyUserID);
      expect(recallById(`t:${legacyUserID}`)).toContain(toolOutput);
      expect(
        db()
          .query(
            `SELECT message_id, status, input_paths_json FROM tool_calls
              WHERE project_id = ? AND session_id = ? AND call_id = ?`,
          )
          .get(projectID, sessionID, callID),
      ).toEqual({
        message_id: legacyToolMessageID,
        status: "completed",
        input_paths_json: '["legacy.ts"]',
      });

      const otherSessionRows = identityRows(projectID, otherSessionID);
      expect(otherSessionRows).toHaveLength(2);
      expect(otherSessionRows.map((row) => row.id)).not.toContain(legacyUserID);
      expect(otherSessionRows.map((row) => row.id)).not.toContain(
        legacyResponseID,
      );
      const tenantProjectID = withTenant(tenantID, () =>
        ensureProject(projectPath),
      );
      expect(tenantProjectID).not.toBe(projectID);
      const tenantRows = identityRows(tenantProjectID, sessionID);
      expect(tenantRows).toHaveLength(2);
      expect(tenantRows.map((row) => row.id)).not.toContain(legacyUserID);
      expect(tenantRows.map((row) => row.id)).not.toContain(legacyResponseID);

      // Once claimed, the bridge stores the modern source ID. A later
      // same-content assistant response in this mixed history must get a fresh
      // v82 row rather than repeatedly falling back to legacy content identity.
      const mixedConversation: GatewayMessage[] = [
        ...conversation,
        { role: "assistant", content: response },
        {
          role: "user",
          content: [{ type: "text", text: "repeat the acknowledgement" }],
        },
      ];
      const mixedLore = runTurn(LOCAL_TENANT_ID, sessionID, mixedConversation);
      expect(markerRecallID(mixedLore)).toBe(legacyUserID);
      const mixedRows = identityRows(projectID, sessionID);
      expect(mixedRows).toHaveLength(4);
      const repeatedResponses = mixedRows.filter(
        (row) => row.role === "assistant" && row.content === responseText,
      );
      expect(repeatedResponses).toHaveLength(2);
      expect(repeatedResponses.map((row) => row.id)).toContain(
        legacyResponseID,
      );
      expect(new Set(repeatedResponses.map((row) => row.id)).size).toBe(2);

      close();
      expect(identityRows(projectID, sessionID)).toHaveLength(4);
      expect(
        db()
          .query(
            `SELECT status FROM tool_calls
              WHERE project_id = ? AND session_id = ? AND call_id = ?`,
          )
          .get(projectID, sessionID, callID),
      ).toEqual({ status: "completed" });
    },
  );

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
