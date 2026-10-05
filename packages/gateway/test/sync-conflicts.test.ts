import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, ltm, syncData } from "@loreai/core";
import { loadConfig, type GatewayConfig } from "../src/config";
import { handleSyncConflictRequest } from "../src/sync-conflicts";
import { startServer } from "../src/server";
import { loopbackRequest } from "./helpers/loopback-request";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    remoteGateway: false,
    hostedMode: false,
    allowRemoteManagement: false,
    ...overrides,
  };
}

async function request(
  path: string,
  method = "GET",
  body?: string,
  config = makeConfig(),
): Promise<Response> {
  const url = new URL(path, "http://127.0.0.1");
  const response = await handleSyncConflictRequest(
    new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body,
          }),
    }),
    url,
    config,
  );
  if (!response) throw new Error(`route not handled: ${method} ${path}`);
  return response;
}

function makeKnowledge(): string {
  return ltm.create({
    id: randomUUID(),
    scope: "global",
    category: "pattern",
    title: `Current ${randomUUID()}`,
    content: "Current local content",
  });
}

function recordKnowledgeConflict(
  logicalId: string,
  local: Record<string, unknown> | null,
  resolution = "remote_upsert_wins",
): number {
  syncData.recordConflict("knowledge", logicalId, resolution, local);
  return syncData.listSyncConflicts(1)[0].id;
}

function currentEntry(logicalId: string) {
  return db()
    .query(
      `SELECT id AS version_id, version, title, content, category
         FROM knowledge_current
        WHERE logical_id = ?`,
    )
    .get(logicalId) as {
    version_id: string;
    version: number;
    title: string;
    content: string;
    category: string;
  };
}

let remoteServer: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  remoteServer = await startServer(makeConfig(), {
    peerAddressForRequest: () => "192.0.2.10",
  });
});

afterAll(async () => {
  await remoteServer.stop();
});

beforeEach(() => {
  syncData.disableSync();
  db().exec(
    "DELETE FROM knowledge_entity_refs; DELETE FROM knowledge_meta_crdt; DELETE FROM knowledge_meta; DELETE FROM sync_conflicts; DELETE FROM knowledge;",
  );
});

describe("sync conflict routes", () => {
  it("lists recoverable and classified conflicts without exposing other table snapshots", async () => {
    const logicalId = makeKnowledge();
    recordKnowledgeConflict(logicalId, {
      title: "Local title",
      content: "Discarded local text",
      category: "decision",
    });
    syncData.recordConflict(
      "entities",
      "entity-private",
      "remote_upsert_wins",
      {
        private: "must not be returned",
      },
    );
    const nonKnowledgeId = syncData.listSyncConflicts(1)[0].id;
    const missing = randomUUID();
    recordKnowledgeConflict(
      missing,
      { title: "Missing local", content: "Local text", category: "gotcha" },
      "remote_upsert_wins",
    );
    const unreadable = Number(
      db()
        .query(
          `INSERT INTO sync_conflicts (table_name, row_id, detected_at, resolution, local_content)
           VALUES ('knowledge', ?, ?, 'remote_upsert_wins', '{bad json')`,
        )
        .run(randomUUID(), Date.now()).lastInsertRowid,
    );
    const remoteDeletedId = makeKnowledge();
    ltm.remove(remoteDeletedId);
    const remoteDelete = recordKnowledgeConflict(
      remoteDeletedId,
      { title: "Deleted local", content: "Some local text" },
      "remote_delete_wins",
    );

    const response = await request("/api/v1/sync/conflicts");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.available).toBe(true);
    expect(body.complete).toBe(true);
    const byId = new Map(
      body.conflicts.map((conflict: { id: number }) => [conflict.id, conflict]),
    );
    expect(byId.get(remoteDelete)).toMatchObject({
      recoverable: true,
      unrecoverable_reason: null,
      local: {
        title: "Deleted local",
        content: "Some local text",
      },
      current: {
        version_id: expect.any(String),
        deleted: true,
      },
    });
    expect(byId.get(nonKnowledgeId)).toMatchObject({
      table: "entities",
      recoverable: false,
      unrecoverable_reason: "not_knowledge",
      local: null,
    });
    expect(JSON.stringify(byId.get(nonKnowledgeId))).not.toContain(
      "must not be returned",
    );
    expect(byId.get(unreadable)).toMatchObject({
      recoverable: false,
      unrecoverable_reason: "unreadable",
      local: null,
    });
    const recoverable = body.conflicts.find(
      (conflict: { id: number; row_id: string }) =>
        conflict.id !== remoteDelete &&
        conflict.id !== nonKnowledgeId &&
        conflict.id !== unreadable &&
        conflict.row_id === logicalId,
    );
    expect(recoverable).toMatchObject({
      recoverable: true,
      unrecoverable_reason: null,
      local: {
        title: "Local title",
        content: "Discarded local text",
        category: "decision",
      },
      current: {
        title: expect.any(String),
        version_id: expect.any(String),
        version: expect.any(Number),
        content: "Current local content",
      },
    });
    expect(recoverable.current).not.toHaveProperty("deleted");
    expect(
      body.conflicts.find(
        (conflict: { row_id: string }) => conflict.row_id === missing,
      ),
    ).toMatchObject({
      recoverable: false,
      unrecoverable_reason: "entry_missing",
      local: {
        title: "Missing local",
        category: "gotcha",
      },
      current: null,
    });
  });

  it("keeps a local snapshot as a new version and returns the actual current title", async () => {
    const logicalId = makeKnowledge();
    const initial = currentEntry(logicalId);
    const id = recordKnowledgeConflict(logicalId, {
      title: initial.title,
      content: "Restored local content",
      category: "pattern",
    });
    const response = await request(
      `/api/v1/sync/conflicts/${id}/keep-local`,
      "POST",
      JSON.stringify({ expected_version_id: initial.version_id }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      kept: "local",
      current: {
        version_id: expect.any(String),
        version: initial.version + 1,
        title: initial.title,
        content: "Restored local content",
      },
    });
    expect(body.current.version_id).not.toBe(initial.version_id);
    expect(syncData.getSyncConflict(id)).toBeNull();
  });

  it("leaves a conflict intact when the expected current version is stale", async () => {
    const logicalId = makeKnowledge();
    const id = recordKnowledgeConflict(logicalId, {
      title: "Local title",
      content: "Restored text",
      category: "pattern",
    });
    const current = currentEntry(logicalId);
    const response = await request(
      `/api/v1/sync/conflicts/${id}/keep-local`,
      "POST",
      JSON.stringify({ expected_version_id: "stale-version-id" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        type: "stale_version",
        current_version_id: current.version_id,
      },
    });
    expect(syncData.getSyncConflict(id)).not.toBeNull();
  });

  it("restores a remote-deleted snapshot only from the matching death certificate", async () => {
    const logicalId = makeKnowledge();
    ltm.remove(logicalId);
    const deathCert = db()
      .query(
        "SELECT id, version FROM knowledge WHERE logical_id = ? AND is_current = 1",
      )
      .get(logicalId) as { id: string; version: number };
    const id = recordKnowledgeConflict(
      logicalId,
      {
        title: "Recovered title",
        content: "Recovered local content",
        category: "decision",
        metadata: JSON.stringify({ gitHead: "b".repeat(40) }),
      },
      "remote_delete_wins",
    );
    const listed = await request("/api/v1/sync/conflicts");
    const conflict = (await listed.json()).conflicts.find(
      (entry: { id: number }) => entry.id === id,
    );
    expect(conflict).toMatchObject({
      recoverable: true,
      current: {
        version_id: deathCert.id,
        version: deathCert.version,
        deleted: true,
      },
    });
    expect(conflict.local).not.toHaveProperty("metadata");

    const stale = await request(
      `/api/v1/sync/conflicts/${id}/keep-local`,
      "POST",
      JSON.stringify({ expected_version_id: "stale-death-cert" }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: {
        type: "stale_version",
        current_version_id: deathCert.id,
      },
    });
    expect(syncData.getSyncConflict(id)).not.toBeNull();

    const response = await request(
      `/api/v1/sync/conflicts/${id}/keep-local`,
      "POST",
      JSON.stringify({ expected_version_id: deathCert.id }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kept: "local",
      current: {
        version_id: expect.any(String),
        version: deathCert.version + 1,
        title: "Recovered title",
        content: "Recovered local content",
      },
    });
    expect(syncData.getSyncConflict(id)).toBeNull();
    expect(ltm.getByLogical(logicalId)).toMatchObject({
      approval_status: "auto",
      metadata: {
        gitHead: "b".repeat(40),
        recovered_from: {
          kind: "sync_conflict_keep_local",
          conflict_id: id,
          remote_deleted_version_id: deathCert.id,
          restored_at: expect.any(String),
        },
      },
    });
  });

  it("updates a live version for a remote-delete conflict with a revision check", async () => {
    const logicalId = makeKnowledge();
    const initial = currentEntry(logicalId);
    const id = recordKnowledgeConflict(
      logicalId,
      {
        title: "Local title",
        content: "Local content",
        category: "decision",
      },
      "remote_delete_wins",
    );

    const stale = await request(
      `/api/v1/sync/conflicts/${id}/keep-local`,
      "POST",
      JSON.stringify({ expected_version_id: "stale-live-version" }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: {
        type: "stale_version",
        current_version_id: initial.version_id,
      },
    });
    expect(currentEntry(logicalId)).toMatchObject(initial);
    expect(syncData.getSyncConflict(id)).not.toBeNull();

    const response = await request(
      `/api/v1/sync/conflicts/${id}/keep-local`,
      "POST",
      JSON.stringify({ expected_version_id: initial.version_id }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kept: "local",
      current: {
        version_id: expect.any(String),
        version: initial.version + 1,
        title: "Local title",
        content: "Local content",
      },
    });
    expect(syncData.getSyncConflict(id)).toBeNull();
  });

  it("returns the actual title when a local rename collides with another entry", async () => {
    const logicalId = makeKnowledge();
    const collisionTitle = `Collision ${randomUUID()}`;
    ltm.create({
      id: randomUUID(),
      scope: "global",
      category: "pattern",
      title: collisionTitle,
      content: "Existing entry",
    });
    const initial = currentEntry(logicalId);
    const id = recordKnowledgeConflict(logicalId, {
      title: collisionTitle,
      content: "Restored local content",
      category: "pattern",
    });
    const response = await request(
      `/api/v1/sync/conflicts/${id}/keep-local`,
      "POST",
      JSON.stringify({ expected_version_id: initial.version_id }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kept: "local",
      current: {
        title: initial.title,
        content: "Restored local content",
        version: initial.version + 1,
      },
    });
  });

  it("discards a conflict and rejects missing, malformed, and unrecoverable keep requests", async () => {
    const logicalId = makeKnowledge();
    ltm.remove(logicalId);
    const deathCert = db()
      .query("SELECT id FROM knowledge WHERE logical_id = ? AND is_current = 1")
      .get(logicalId) as { id: string };
    const unrecoverableId = recordKnowledgeConflict(
      logicalId,
      null,
      "remote_delete_wins",
    );
    const listed = await request("/api/v1/sync/conflicts");
    expect(
      (await listed.json()).conflicts.find(
        (entry: { id: number }) => entry.id === unrecoverableId,
      ),
    ).toMatchObject({
      recoverable: false,
      unrecoverable_reason: "unreadable",
      local: null,
    });
    const keep = await request(
      `/api/v1/sync/conflicts/${unrecoverableId}/keep-local`,
      "POST",
      JSON.stringify({
        expected_version_id: deathCert.id,
      }),
    );
    expect(keep.status).toBe(409);
    expect(await keep.json()).toMatchObject({
      error: { type: "not_recoverable" },
    });

    expect(
      (
        await request(
          `/api/v1/sync/conflicts/${unrecoverableId}/discard`,
          "POST",
          "{}",
        )
      ).status,
    ).toBe(200);
    expect(syncData.getSyncConflict(unrecoverableId)).toBeNull();
    expect(
      (
        await request(
          `/api/v1/sync/conflicts/${unrecoverableId}/discard`,
          "POST",
          "{}",
        )
      ).status,
    ).toBe(404);
    expect(
      (await request("/api/v1/sync/conflicts/0/discard", "POST", "{}")).status,
    ).toBe(400);
    expect(
      (await request("/api/v1/sync/conflicts/1/keep-local", "POST", "{"))
        .status,
    ).toBe(400);
  });

  it("probes one extra row, truncates at 100, and hides the feature in hosted mode", async () => {
    for (let index = 0; index < 101; index++) {
      syncData.recordConflict(
        "entities",
        `entity-${index}`,
        "remote_upsert_wins",
        {
          index,
        },
      );
    }
    const response = await request("/api/v1/sync/conflicts");
    const body = await response.json();
    expect(body.conflicts).toHaveLength(100);
    expect(body.complete).toBe(false);

    const hosted = makeConfig({ hostedMode: true, remoteGateway: true });
    expect(
      await (
        await request("/api/v1/sync/conflicts", "GET", undefined, hosted)
      ).json(),
    ).toEqual({
      available: false,
      complete: true,
      conflicts: [],
    });
    for (const path of [
      "/api/v1/sync/conflicts/1/keep-local",
      "/api/v1/sync/conflicts/1/discard",
    ]) {
      const refused = await request(path, "POST", "{", hosted);
      expect(refused.status).toBe(403);
    }
  });

  it("hides all sync-conflict routes from non-loopback peers", async () => {
    for (const [path, method] of [
      ["/api/v1/sync/conflicts", "GET"],
      ["/api/v1/sync/conflicts/1/keep-local", "POST"],
      ["/api/v1/sync/conflicts/1/discard", "POST"],
    ] as const) {
      const response = await loopbackRequest(
        `http://127.0.0.1:${remoteServer.port}${path}`,
        {
          method,
          ...(method === "POST"
            ? {
                headers: { "Content-Type": "application/json" },
                body: "{}",
              }
            : {}),
        },
      );
      expect(response.status).toBe(404);
    }
  });
});
