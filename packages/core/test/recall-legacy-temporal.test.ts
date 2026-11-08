import { describe, expect, test } from "vitest";
import { config } from "../src/config";
import { close, db, ensureProject } from "../src/db";
import { runRecallWithMetadata } from "../src/recall";
import {
  createRecallToolExecutor,
  parseRecallToolArguments,
} from "../src/recall-tool";
import { storedMessageId } from "../src/temporal";
import { withTenant } from "../src/tenant";

const projectPath = "/test/recall-legacy-temporal";
const sessionID = "legacy-message-session";
const sourceID = "msg_legacy-provider-id";
const marker = "legacymigrationneedle";
const content = `${marker} ${"preserved conversation detail ".repeat(300)}`;
const tenantId = "recall-legacy-owner";

function searchConfig() {
  const search = config().search;
  return {
    ...search,
    queryExpansion: false,
    embeddings: { ...search.embeddings, enabled: false },
  };
}

function executor() {
  return createRecallToolExecutor(
    (input) =>
      runRecallWithMetadata({ ...input, searchConfig: searchConfig() }).then(
        (run) => run.result,
      ),
    config,
  );
}

describe("recall of preserved pre-v82 temporal IDs", () => {
  test("resolves direct and opaque detail after the real v82 identity migration", async () => {
    withTenant(tenantId, () => {
      const projectId = ensureProject(projectPath);
      db()
        .query(`INSERT INTO temporal_messages
        (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
        VALUES (?, ?, ?, ?, 'user', ?, 2000, 0, ?, '{}')`)
        .run(sourceID, sourceID, projectId, sessionID, content, Date.now());
      // Restore the actual v81 temporal layout, then let the real migration
      // preserve its primary key and backfill source_id on reopen.
      db().exec(`DROP INDEX idx_temporal_source_identity;
        ALTER TABLE temporal_messages DROP COLUMN source_id;
        UPDATE schema_version SET version = 81;`);
      close();
      expect(storedMessageId({ projectPath, sessionID, sourceID })).toBe(
        sourceID,
      );
      expect(
        db()
          .query("SELECT source_id FROM temporal_messages WHERE id = ?")
          .get(sourceID),
      ).toEqual({ source_id: sourceID });
    });

    withTenant(tenantId, () => ensureProject("/test/recall-legacy-other"));
    withTenant("other-tenant", () => ensureProject(projectPath));
    const execute = executor();
    const context = { projectPath, sessionID };
    const direct = await withTenant(tenantId, () =>
      execute({ id: `t:${sourceID}`, scope: "session" }, context),
    );
    expect.soft(direct).toContain(marker);
    const preview = await withTenant(tenantId, () =>
      execute({ query: marker, scope: "session" }, context),
    );
    const ref = preview.match(/detail ref: `([^`]+)`/)?.[1];
    expect(ref).toMatch(/^r:[0-9a-f-]{36}$/);
    expect(preview).not.toContain(sourceID);
    const opaque = await withTenant(tenantId, () =>
      execute({ id: ref }, context),
    );
    expect.soft(opaque).toContain(marker);

    for (const id of [`t:${sourceID}`, ref]) {
      for (const [owner, args, requestContext] of [
        [
          tenantId,
          { id, scope: "session" },
          { ...context, sessionID: "other-session" },
        ],
        [tenantId, { id, scope: "knowledge" }, context],
        [
          tenantId,
          { id, scope: "session" },
          { ...context, projectPath: "/test/recall-legacy-other" },
        ],
        ["other-tenant", { id, scope: "session" }, context],
      ] as const) {
        const result = await withTenant(owner, () =>
          execute(args, requestContext),
        );
        expect(result).toBe("No matching recall detail.");
      }
    }
    expect(
      await withTenant(tenantId, () =>
        execute({ id: "t:msg_' OR 1=1 --", scope: "session" }, context),
      ),
    ).toBe("No matching recall detail.");
    // Direct IDs remain project-visible across sessions, but the opaque
    // capability remains bound to its producing session and scope.
    expect(
      await withTenant(tenantId, () =>
        execute(
          { id: `t:${sourceID}`, scope: "project" },
          { ...context, sessionID: "other-session" },
        ),
      ),
    ).toContain(content.trim());
    expect(
      await withTenant(tenantId, () =>
        execute({ id: ref, scope: "project" }, context),
      ),
    ).toBe("No matching recall detail.");
  });

  test("bounds legacy selectors and rejects control or truncated IDs", () => {
    for (const id of ["t:msg_123", "t:source-1", `t:${"a".repeat(254)}`]) {
      expect(parseRecallToolArguments({ id }).valid, id).toBe(true);
      expect(parseRecallToolArguments({ ids: [id] }).valid, id).toBe(true);
    }
    for (const id of [
      "t:",
      `t:${"a".repeat(255)}`,
      "t:msg_…",
      ...[0, 9, 10, 13, 31, 127].map(
        (code) => `t:msg_${String.fromCharCode(code)}private`,
      ),
    ]) {
      expect(parseRecallToolArguments({ id }).valid, JSON.stringify(id)).toBe(
        false,
      );
      expect(
        parseRecallToolArguments({ ids: [id] }).valid,
        JSON.stringify(id),
      ).toBe(false);
    }
  });
});
