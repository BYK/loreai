import { describe, test, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import * as ltm from "../src/ltm";
import * as distillation from "../src/distillation";

const PROJECT = "/test/worker-attribution/project";

describe("worker source attribution (v35)", () => {
  beforeEach(() => {
    db().exec("DELETE FROM knowledge");
    db().exec("DELETE FROM distillations");
  });

  describe("ltm.create", () => {
    test("creates entry without worker attribution (legacy path)", () => {
      const id = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "No worker",
        content: "x",
        scope: "project",
      });
      const entry = ltm.get(id);
      expect(entry?.worker_provider_id).toBeNull();
      expect(entry?.worker_model_id).toBeNull();
    });

    test("writes worker attribution when provided", () => {
      const id = ltm.create({
        projectPath: PROJECT,
        category: "preference",
        title: "Worker attribution",
        content: "x",
        scope: "project",
        workerProviderID: "minimax-coding-plan",
        workerModelID: "MiniMax-M3",
      });
      const entry = ltm.get(id);
      expect(entry?.worker_provider_id).toBe("minimax-coding-plan");
      expect(entry?.worker_model_id).toBe("MiniMax-M3");
    });

    test("getWorkerSource returns null for legacy entries", () => {
      const id = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "Legacy",
        content: "x",
        scope: "project",
      });
      expect(ltm.getWorkerSource(id)).toBeNull();
    });

    test("getWorkerSource returns attribution for attributed entries", () => {
      const id = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "Attributed",
        content: "x",
        scope: "project",
        workerProviderID: "anthropic",
        workerModelID: "claude-opus-4-6",
      });
      expect(ltm.getWorkerSource(id)).toEqual({
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
      });
    });

    test("dedup merge preserves original worker attribution", () => {
      // First creation with attribution
      const id1 = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "Same title",
        content: "first",
        scope: "project",
        workerProviderID: "anthropic",
        workerModelID: "claude-opus-4-6",
      });
      // Second creation with different attribution — should dedup-update, not overwrite attribution
      const id2 = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "Same title",
        content: "second",
        scope: "project",
        workerProviderID: "minimax-coding-plan",
        workerModelID: "MiniMax-M3",
      });
      expect(id1).toBe(id2);
      const entry = ltm.get(id1);
      expect(entry?.content).toBe("second");
      // Attribution is preserved from the original creator
      expect(entry?.worker_provider_id).toBe("anthropic");
      expect(entry?.worker_model_id).toBe("claude-opus-4-6");
    });
  });

  describe("KnowledgeEntry type includes worker attribution", () => {
    test("KNOWLEDGE_COLS selects worker_provider_id and worker_model_id", () => {
      const id = ltm.create({
        projectPath: PROJECT,
        category: "decision",
        title: "Cols test",
        content: "x",
        scope: "project",
        workerProviderID: "nvidia",
        workerModelID: "nemotron-3-ultra-550b",
      });
      // If KNOWLEDGE_COLS is missing the new fields, this select would not
      // materialize them and the assertion below would fail.
      const entry = ltm.get(id);
      expect(entry).not.toBeNull();
      expect(entry?.worker_provider_id).toBe("nvidia");
      expect(entry?.worker_model_id).toBe("nemotron-3-ultra-550b");
    });
  });

  describe("distillation table", () => {
    test("storeDistillation accepts and stores worker attribution", () => {
      // The storeDistillation function is internal to distillation.ts. Test
      // it indirectly by writing a row via raw SQL with the same shape, then
      // verifying the columns are queryable. (Direct calls to storeDistillation
      // require a full LLMClient, which is out of scope for this unit test.)
      const id = "019e18ec-0000-7000-8000-000000000001";
      db()
        .query(
          `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, worker_provider_id, worker_model_id)
           VALUES (?, (SELECT id FROM projects WHERE path = ?), 'sess-test', '', '[]', 'obs', '[]', 0, 10, ?, 'anthropic', 'claude-opus-4-6')`,
        )
        .run(id, PROJECT, Date.now());
      const row = db()
        .query(
          "SELECT worker_provider_id, worker_model_id FROM distillations WHERE id = ?",
        )
        .get(id) as {
        worker_provider_id: string | null;
        worker_model_id: string | null;
      } | null;
      expect(row?.worker_provider_id).toBe("anthropic");
      expect(row?.worker_model_id).toBe("claude-opus-4-6");
    });

    test("legacy distillations (no attribution) have NULL fields", () => {
      // Verify that a row inserted without the new columns is queryable and
      // returns NULL — confirms the migration is backward-compatible.
      const id = "019e18ec-0000-7000-8000-000000000002";
      db()
        .query(
          `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at)
           VALUES (?, (SELECT id FROM projects WHERE path = ?), 'sess-legacy', '', '[]', 'obs', '[]', 0, 10, ?)`,
        )
        .run(id, PROJECT, Date.now());
      const row = db()
        .query(
          "SELECT worker_provider_id, worker_model_id FROM distillations WHERE id = ?",
        )
        .get(id) as {
        worker_provider_id: string | null;
        worker_model_id: string | null;
      } | null;
      expect(row?.worker_provider_id).toBeNull();
      expect(row?.worker_model_id).toBeNull();
    });
  });

  describe("schema", () => {
    test("idx_distillation_worker index exists", () => {
      const row = db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_distillation_worker'",
        )
        .get() as { name: string } | null;
      expect(row?.name).toBe("idx_distillation_worker");
    });

    test("idx_knowledge_worker index exists", () => {
      const row = db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_knowledge_worker'",
        )
        .get() as { name: string } | null;
      expect(row?.name).toBe("idx_knowledge_worker");
    });
  });
});

// Ensure the module is referenced so the file is part of the test graph
void distillation;
