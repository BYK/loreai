import { describe, expect, test } from "vitest";
import { close, db, ensureProject } from "../src/db";
import { withTenant } from "../src/tenant";
import * as temporal from "../src/temporal";
import type { LoreMessage, LorePart } from "../src/types";

const TENANT_A = "a".repeat(64);
const TENANT_B = "b".repeat(64);

function message(
  sourceID: string,
  sessionID: string,
  role: "user" | "assistant" = "user",
): LoreMessage {
  if (role === "user") {
    return {
      id: sourceID,
      sessionID,
      role,
      time: { created: 1_000 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "test" },
    };
  }
  return {
    id: sourceID,
    sessionID,
    role,
    time: { created: 1_000 },
    parentID: "parent",
    modelID: "test",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function textPart(sourceID: string, sessionID: string, text: string): LorePart {
  return {
    id: `part-${sourceID}-${sessionID}`,
    sessionID,
    messageID: sourceID,
    type: "text",
    text,
  };
}

function toolPart(
  sourceID: string,
  sessionID: string,
  callID: string,
  tool: string,
  state: Record<string, unknown>,
): LorePart {
  return {
    id: `tool-${sourceID}-${sessionID}`,
    sessionID,
    messageID: sourceID,
    type: "tool",
    tool,
    callID,
    state,
  };
}

function storeText(input: {
  tenantID: string;
  projectPath: string;
  sessionID: string;
  sourceID: string;
  text: string;
}): string {
  return withTenant(input.tenantID, () => {
    const id = temporal.store({
      projectPath: input.projectPath,
      info: message(input.sourceID, input.sessionID),
      parts: [textPart(input.sourceID, input.sessionID, input.text)],
    });
    if (!id) throw new Error("expected temporal row");
    return id;
  });
}

function recordTool(input: {
  tenantID: string;
  projectPath: string;
  sessionID: string;
  sourceID: string;
  callID: string;
  tool: string;
  state: Record<string, unknown>;
  role: "user" | "assistant";
}): void {
  withTenant(input.tenantID, () =>
    temporal.recordToolCalls({
      projectPath: input.projectPath,
      info: message(input.sourceID, input.sessionID, input.role),
      parts: [
        toolPart(
          input.sourceID,
          input.sessionID,
          input.callID,
          input.tool,
          input.state,
        ),
      ],
    }),
  );
}

function toolRows(tenantID: string, projectPath: string) {
  return withTenant(tenantID, () => {
    const projectID = ensureProject(projectPath);
    return db()
      .query(
        `SELECT session_id, call_id, tool, status, error_type
           FROM tool_calls WHERE project_id = ? ORDER BY session_id`,
      )
      .all(projectID) as Array<{
      session_id: string;
      call_id: string;
      tool: string;
      status: string;
      error_type: string | null;
    }>;
  });
}

describe("temporal tenant/session identity", () => {
  test.each([
    [TENANT_A, TENANT_B],
    [TENANT_B, TENANT_A],
  ])(
    "keeps the same source message isolated in tenant order %# and after restart",
    (firstTenant, secondTenant) => {
      const projectPath = `/test/temporal-identity/order-${firstTenant[0]}`;
      const sourceID = "caller-message-id";
      const sessionID = "shared-session-id";
      const text = "tenant isolated zircon temporal memory";

      const firstID = storeText({
        tenantID: firstTenant,
        projectPath,
        sessionID,
        sourceID,
        text,
      });
      const secondID = storeText({
        tenantID: secondTenant,
        projectPath,
        sessionID,
        sourceID,
        text,
      });

      expect(firstID).not.toBe(secondID);
      expect(firstID).toMatch(/^lore_tm_v1_/);
      expect(secondID).toMatch(/^lore_tm_v1_/);

      // Even a known storage ID cannot be mutated from the other tenant.
      withTenant(secondTenant, () => temporal.markDistilled([firstID]));
      expect(
        withTenant(firstTenant, () =>
          temporal.undistilled(projectPath, sessionID).map((row) => row.id),
        ),
      ).toEqual([firstID]);

      withTenant(firstTenant, () => temporal.markDistilled([firstID]));
      expect(
        withTenant(firstTenant, () =>
          temporal.undistilled(projectPath, sessionID),
        ),
      ).toEqual([]);
      expect(
        withTenant(secondTenant, () =>
          temporal.undistilled(projectPath, sessionID).map((row) => row.id),
        ),
      ).toEqual([secondID]);

      for (const [tenantID, expectedID] of [
        [firstTenant, firstID],
        [secondTenant, secondID],
      ] as const) {
        expect(
          withTenant(tenantID, () =>
            temporal.search({
              projectPath,
              sessionID,
              query: "zircon memory",
            }),
          ).map((row) => row.id),
        ).toEqual([expectedID]);
      }

      withTenant(secondTenant, () => temporal.markDistilled([secondID]));
      close();

      for (const [tenantID, expectedID] of [
        [firstTenant, firstID],
        [secondTenant, secondID],
      ] as const) {
        const rows = withTenant(tenantID, () =>
          temporal.bySession(projectPath, sessionID),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: expectedID,
          source_id: sourceID,
          distilled: 1,
        });
      }
    },
  );

  test("does not collapse the same source ID and content across sessions", () => {
    const projectPath = "/test/temporal-identity/two-sessions";
    const sourceID = "same-caller-id";
    const firstID = storeText({
      tenantID: TENANT_A,
      projectPath,
      sessionID: "session-one",
      sourceID,
      text: "repeated assistant answer",
    });
    const secondID = storeText({
      tenantID: TENANT_A,
      projectPath,
      sessionID: "session-two",
      sourceID,
      text: "repeated assistant answer",
    });

    expect(firstID).not.toBe(secondID);
    expect(withTenant(TENANT_A, () => temporal.count(projectPath))).toBe(2);

    storeText({
      tenantID: TENANT_A,
      projectPath,
      sessionID: "session-one",
      sourceID,
      text: "updated only in session one",
    });
    expect(
      withTenant(
        TENANT_A,
        () => temporal.bySession(projectPath, "session-one")[0]?.content,
      ),
    ).toContain("updated only");
    expect(
      withTenant(
        TENANT_A,
        () => temporal.bySession(projectPath, "session-two")[0]?.content,
      ),
    ).toBe("repeated assistant answer");
  });

  test("never accepts a caller-supplied value as an internal storage ID", () => {
    const sourceID = "lore_tm_v1_caller-controlled";
    const storedID = storeText({
      tenantID: TENANT_A,
      projectPath: "/test/temporal-identity/reserved-prefix",
      sessionID: "reserved-prefix-session",
      sourceID,
      text: "reserved prefix input",
    });

    expect(storedID).toMatch(/^lore_tm_v1_/);
    expect(storedID).not.toBe(sourceID);
    expect(
      withTenant(TENANT_A, () =>
        temporal.bySession(
          "/test/temporal-identity/reserved-prefix",
          "reserved-prefix-session",
        ),
      )[0]?.source_id,
    ).toBe(sourceID);
  });

  test("resolves a persisted pre-v82 source ID without re-keying it", () => {
    const projectPath = "/test/temporal-identity/legacy-source";
    const sessionID = "legacy-source-session";
    const legacyID = "pre-v82-gateway-hash";
    withTenant(TENANT_A, () => {
      const projectID = ensureProject(projectPath);
      db()
        .query(
          `INSERT INTO temporal_messages
             (id, source_id, project_id, session_id, role, content, tokens,
              distilled, created_at, metadata)
           VALUES (?, ?, ?, ?, 'user', 'legacy', 1, 0, 1, '{}')`,
        )
        .run(legacyID, legacyID, projectID, sessionID);
    });

    expect(
      withTenant(TENANT_A, () =>
        temporal.storedMessageId({
          projectPath,
          sessionID,
          sourceID: "v82-session-aware-hash",
          legacySourceID: legacyID,
        }),
      ),
    ).toBe(legacyID);
  });

  test("does not treat a fresh v82 row as an unclaimed legacy row", () => {
    const projectPath = "/test/temporal-identity/unambiguous-legacy";
    const sessionID = "unambiguous-legacy-session";
    const legacySourceID = "legacy-shaped-source";
    const freshID = storeText({
      tenantID: TENANT_A,
      projectPath,
      sessionID,
      sourceID: legacySourceID,
      text: "fresh v82 content",
    });

    const resolved = withTenant(TENANT_A, () =>
      temporal.storedMessageId({
        projectPath,
        sessionID,
        sourceID: "different-modern-source",
        legacySourceID,
      }),
    );
    expect(resolved).not.toBe(freshID);
    expect(resolved).toMatch(/^lore_tm_v1_/);
  });

  test("reuses a restored sync row whose local-only source ID is null", () => {
    const projectPath = "/test/temporal-identity/restored-row";
    const sessionID = "restored-session";
    const sourceID = "restored-source";
    withTenant(TENANT_A, () => {
      const projectID = ensureProject(projectPath);
      const restoredID = temporal.storedMessageId({
        projectPath,
        sessionID,
        sourceID,
      });
      db()
        .query(
          `INSERT INTO temporal_messages
             (id, source_id, project_id, session_id, role, content, tokens,
              distilled, created_at, metadata)
           VALUES (?, NULL, ?, ?, 'user', 'restored content', 1, 1, 1, '{}')`,
        )
        .run(restoredID, projectID, sessionID);
    });

    const storedID = storeText({
      tenantID: TENANT_A,
      projectPath,
      sessionID,
      sourceID,
      text: "updated restored content",
    });
    expect(
      withTenant(TENANT_A, () => temporal.bySession(projectPath, sessionID)),
    ).toEqual([
      expect.objectContaining({
        id: storedID,
        source_id: sourceID,
        content: "updated restored content",
      }),
    ]);
  });

  test("correlates duplicate raw tool call IDs only within project and session", () => {
    const sharedPath = "/test/temporal-identity/tool-shared";
    const otherPath = "/test/temporal-identity/tool-other-project";
    const callID = "provider-call-id";
    const seed = (
      tenantID: string,
      projectPath: string,
      sessionID: string,
      tool: string,
    ) =>
      recordTool({
        tenantID,
        projectPath,
        sessionID,
        sourceID: `assistant-${sessionID}`,
        callID,
        tool,
        state: { status: "pending", input: {} },
        role: "assistant",
      });
    const result = (
      tenantID: string,
      projectPath: string,
      sessionID: string,
      targetCallID: string,
      state: Record<string, unknown>,
    ) =>
      recordTool({
        tenantID,
        projectPath,
        sessionID,
        sourceID: `result-${sessionID}`,
        callID: targetCallID,
        tool: "result",
        state,
        role: "user",
      });

    seed(TENANT_A, sharedPath, "main", "read");
    seed(TENANT_A, sharedPath, "other-session", "edit");
    seed(TENANT_A, otherPath, "main", "bash");
    seed(TENANT_B, sharedPath, "main", "write");

    // Unknown/malformed ownership combinations are no-ops even though the raw
    // call ID exists under another tenant/project/session.
    result(TENANT_B, sharedPath, "missing-session", callID, {
      status: "error",
      input: null,
      error: "malformed cross-session result",
    });
    result(TENANT_A, sharedPath, "main", "unknown-call", {
      status: "completed",
      input: null,
      output: "unknown",
    });

    // Resolve tenants in the opposite order from their seeds.
    result(TENANT_B, sharedPath, "main", callID, {
      status: "error",
      input: null,
      error: "permission denied",
    });
    result(TENANT_A, sharedPath, "main", callID, {
      status: "completed",
      input: null,
      output: "ok",
    });

    expect(toolRows(TENANT_A, sharedPath)).toEqual([
      {
        session_id: "main",
        call_id: callID,
        tool: "read",
        status: "completed",
        error_type: null,
      },
      {
        session_id: "other-session",
        call_id: callID,
        tool: "edit",
        status: "pending",
        error_type: null,
      },
    ]);
    expect(toolRows(TENANT_B, sharedPath)).toEqual([
      {
        session_id: "main",
        call_id: callID,
        tool: "write",
        status: "error",
        error_type: "permission",
      },
    ]);
    expect(toolRows(TENANT_A, otherPath)[0]?.status).toBe("pending");

    close();

    // A post-restart result for the second session must not rewrite main, the
    // other project, or tenant B despite sharing the same raw call ID.
    result(TENANT_A, sharedPath, "other-session", callID, {
      status: "error",
      input: null,
      error: "timed out",
    });
    expect(toolRows(TENANT_A, sharedPath).map((row) => row.status)).toEqual([
      "completed",
      "error",
    ]);
    expect(toolRows(TENANT_A, otherPath)[0]?.status).toBe("pending");
    expect(toolRows(TENANT_B, sharedPath)[0]?.status).toBe("error");
  });
});
