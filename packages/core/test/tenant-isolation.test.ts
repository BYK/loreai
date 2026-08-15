import { afterEach, describe, expect, test } from "vitest";
import { close, db, ensureProject, invalidateProjectIdCache } from "../src/db";
import { withTenant } from "../src/tenant";
import * as entities from "../src/entities";
import * as ltm from "../src/ltm";
import * as temporal from "../src/temporal";
import { recallById, runRecall } from "../src/recall";
import { config } from "../src/config";
import { isVecAvailable } from "../src/db/vec";
import {
  readStorageMode,
  resolveReadMode,
  storeEmbedding,
} from "../src/db/vec-store";
import { runVectorQuery } from "../src/vector-query";

const TENANT_A = "a".repeat(64);
const TENANT_B = "b".repeat(64);

afterEach(() => {
  invalidateProjectIdCache();
});

describe("durable remote tenant storage isolation", () => {
  test.each([
    [TENANT_A, TENANT_B],
    [TENANT_B, TENANT_A],
  ])(
    "same client path resolves independently in adversarial order %#",
    async (firstTenant, secondTenant) => {
      const path = `/test/tenant-isolation/order-${firstTenant[0]}`;
      const firstId = withTenant(firstTenant, () => ensureProject(path));
      const secondId = withTenant(secondTenant, () => ensureProject(path));

      expect(firstId).not.toBe(secondId);
      expect(
        db()
          .query(
            "SELECT tenant_id, path FROM projects WHERE id IN (?, ?) ORDER BY tenant_id",
          )
          .all(firstId, secondId),
      ).toEqual([
        { tenant_id: TENANT_A, path },
        { tenant_id: TENANT_B, path },
      ]);

      close();
      const firstAfterRestart = withTenant(firstTenant, () =>
        ensureProject(path),
      );
      const secondAfterRestart = withTenant(secondTenant, () =>
        ensureProject(path),
      );
      expect(firstAfterRestart).toBe(firstId);
      expect(secondAfterRestart).toBe(secondId);
    },
  );

  test("isolates project/global memory, entities, recall, point reads, and background sweeps after restart", async () => {
    const path = "/test/tenant-isolation/shared-client-path";
    const secret = "alpha-tenant-zircon-memory";
    let projectKnowledgeId = "";
    let globalKnowledgeId = "";
    let entityId = "";
    let temporalId = "";
    let projectA = "";

    await withTenant(TENANT_A, async () => {
      projectA = ensureProject(path, undefined, "github.com/shared/repo");
      projectKnowledgeId = ltm.create({
        projectPath: path,
        scope: "project",
        category: "architecture",
        title: "Tenant A zircon architecture",
        content: `${secret} belongs only to tenant A`,
        crossProject: true,
      });
      globalKnowledgeId = ltm.create({
        projectPath: path,
        scope: "global",
        category: "preference",
        title: "Tenant A zircon preference",
        content: `Always preserve ${secret}`,
        crossProject: true,
      });
      entityId = entities.create({
        projectPath: path,
        entityType: "service",
        canonicalName: "ZirconTenantAService",
        aliases: [{ type: "name", value: "zircon-a-service" }],
        crossProject: true,
      }).id;
      temporalId = crypto.randomUUID();
      const storedTemporalId = temporal.store({
        projectPath: path,
        info: {
          id: temporalId,
          sessionID: "tenant-a-session",
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "anthropic", modelID: "test-model" },
        },
        parts: [
          {
            id: crypto.randomUUID(),
            sessionID: "tenant-a-session",
            messageID: temporalId,
            type: "text",
            text: `recall ${secret}`,
          },
        ],
      });
      if (!storedTemporalId) throw new Error("expected stored temporal row");
      temporalId = storedTemporalId;
      db()
        .query(
          `INSERT INTO distillations
             (id, project_id, session_id, narrative, facts, source_ids,
              observations, generation, token_count, created_at, archived)
           VALUES (?, ?, ?, '', '', '[]', ?, 0, 10, ?, 0)`,
        )
        .run(
          crypto.randomUUID(),
          projectA,
          "tenant-a-session",
          `distilled ${secret}`,
          Date.now(),
        );
      ltm.recordContradiction({
        logicalIdA: projectKnowledgeId,
        logicalIdB: globalKnowledgeId,
        projectId: projectA,
        similarity: 0.9,
        rationale: "tenant A only",
      });
      ltm.recordDedupFeedback({
        projectId: null,
        entryATitle: "tenant A feedback one",
        entryBTitle: "tenant A feedback two",
        similarity: 0.91,
        accepted: false,
        source: "dashboard",
      });
      entities.recordEntityDedupFeedback({
        projectId: null,
        entryATitle: "tenant A entity one",
        entryBTitle: "tenant A entity two",
        similarity: 0.92,
        accepted: false,
        source: "dashboard",
      });
    });

    // A real restart drops connection-keyed project caches before the adversary
    // arrives and forces ownership to be recovered from durable rows.
    close();
    invalidateProjectIdCache();

    await withTenant(TENANT_B, async () => {
      const projectB = ensureProject(path, undefined, "github.com/shared/repo");
      expect(projectB).not.toBe(projectA);
      expect(ltm.forProject(path, true)).toEqual([]);
      expect(entities.forProject(path, true)).toEqual([]);
      expect(ltm.get(projectKnowledgeId)).toBeNull();
      expect(ltm.get(globalKnowledgeId)).toBeNull();
      expect(entities.get(entityId)).toBeNull();
      expect(recallById(`k:${projectKnowledgeId}`)).toContain("No entry found");
      expect(recallById(`e:${entityId}`)).toContain("No entry found");
      expect(recallById(`t:${temporalId}`)).toContain("No entry found");

      const recall = await runRecall({
        query: secret,
        projectPath: path,
        sessionID: "tenant-b-session",
        scope: "all",
      });
      expect(recall).not.toContain(secret);
      expect(recall).not.toContain("ZirconTenantAService");

      // These installation-wide background/catalog passes must operate on the
      // active tenant only, not fan out over tenant A's global rows.
      expect(ltm.pruneDeadEntriesAllProjects()).toEqual([]);
      expect(ltm.rerankPreferences()).toBe(0);
      expect(entities.listAll()).toEqual([]);
      expect(
        ltm.contradictionExists(projectKnowledgeId, globalKnowledgeId),
      ).toBe(false);
      expect(ltm.getDedupFeedback(null)).toEqual([]);
      expect(entities.getEntityDedupFeedback(null)).toEqual([]);
    });

    close();
    invalidateProjectIdCache();

    await withTenant(TENANT_A, async () => {
      expect(ensureProject(path)).toBe(projectA);
      expect(
        ltm.forProject(path, true).map((entry) => entry.logical_id),
      ).toEqual(
        expect.arrayContaining([projectKnowledgeId, globalKnowledgeId]),
      );
      expect(
        entities.forProject(path, true).map((entity) => entity.id),
      ).toContain(entityId);
      const recall = await runRecall({
        query: secret,
        projectPath: path,
        sessionID: "tenant-a-session",
        scope: "all",
      });
      expect(recall).toContain(secret);
      expect(recallById(`t:${temporalId}`)).toContain(secret);
      expect(
        ltm.contradictionExists(projectKnowledgeId, globalKnowledgeId),
      ).toBe(true);
      expect(ltm.getDedupFeedback(null)).toHaveLength(1);
      expect(entities.getEntityDedupFeedback(null)).toHaveLength(1);
    });
  });

  test("filters vector candidate pools before ranking across worker-safe query specs", async () => {
    const path = "/test/tenant-isolation/vector-shared-path";
    const dimensions = config().search.embeddings.dimensions;
    const vector = (axis: number) => {
      const value = new Float32Array(dimensions);
      value[axis] = 1;
      return value;
    };
    const ids: Record<
      string,
      { knowledge: string; entity: string; distillation: string }
    > = {};

    for (const [tenantId, axis] of [
      [TENANT_A, 0],
      [TENANT_B, 1],
    ] as const) {
      withTenant(tenantId, () => {
        const projectId = ensureProject(path);
        const knowledge = ltm.create({
          projectPath: path,
          scope: "project",
          category: "architecture",
          title: `Vector knowledge ${tenantId[0]}`,
          content: `private vector content ${tenantId[0]}`,
        });
        const entity = entities.create({
          projectPath: path,
          entityType: "service",
          canonicalName: `VectorService${tenantId[0]}`,
        }).id;
        const distillation = crypto.randomUUID();
        db()
          .query(
            `INSERT INTO distillations
               (id, project_id, session_id, narrative, facts, source_ids,
                observations, generation, token_count, created_at, archived)
             VALUES (?, ?, ?, '', '', '[]', ?, 0, 10, ?, 0)`,
          )
          .run(
            distillation,
            projectId,
            `vector-session-${tenantId[0]}`,
            `private distillation ${tenantId[0]}`,
            Date.now(),
          );
        storeEmbedding(db(), "knowledge", knowledge, vector(axis));
        storeEmbedding(db(), "entities", entity, vector(axis));
        storeEmbedding(db(), "distillations", distillation, vector(axis));
        ids[tenantId] = { knowledge, entity, distillation };
      });
    }

    const mode = resolveReadMode(readStorageMode(db()), isVecAvailable());
    const query = vector(0);
    const tenantB = ids[TENANT_B];
    const knowledgeHits = runVectorQuery(db(), mode, query, {
      kind: "knowledge",
      tenantId: TENANT_B,
      limit: 10,
    });
    const entityHits = runVectorQuery(db(), mode, query, {
      kind: "entities",
      tenantId: TENANT_B,
      limit: 10,
    });
    const distillationHits = runVectorQuery(db(), mode, query, {
      kind: "distillations",
      tenantId: TENANT_B,
      limit: 10,
    });

    expect(knowledgeHits.map((hit) => hit.id)).toEqual([tenantB.knowledge]);
    expect(entityHits.map((hit) => hit.id)).toEqual([tenantB.entity]);
    expect(distillationHits.map((hit) => hit.id)).toEqual([
      tenantB.distillation,
    ]);
  });
});
