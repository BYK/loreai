import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  close,
  databaseInTransaction,
  db,
  deleteTeamConfig,
  ensureProject,
} from "../src/db";
import { config } from "../src/config";
import { isVecAvailable } from "../src/db/vec";
import {
  ensureVec0Store,
  hasEmbeddingSql,
  setStorageMode,
  storeEmbedding,
} from "../src/db/vec-store";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import {
  applyRemoteKnowledge,
  applyRemoteKnowledgeDelete,
  currentKnowledgeRow,
  enableSync,
  readOutbox,
  withApplying,
} from "../src/sync-data";
import { fromBlob, runVectorQuery } from "../src/vector-query";
import { createTestDatabasePath } from "./helpers/test-db-path";

const DIM = config().search.embeddings.dimensions;
const OLD = new Float32Array(DIM);
OLD[0] = 1;
const NEXT = new Float32Array(DIM);
NEXT[1] = 1;
let seq = 0;

for (const mode of ["blob", "vec0"] as const) {
  describe(`pulled knowledge embeddings (${mode})`, () => {
    let provider: unknown;
    const calls: Array<{ texts: string[]; inTransaction: boolean }> = [];

    beforeEach((ctx) => {
      provider = embedding._saveAndClearProvider();
      embedding._restoreProvider({ provider: null });
      calls.length = 0;
      db();
      if (mode === "vec0") {
        if (!isVecAvailable()) ctx.skip();
        ensureVec0Store(db(), DIM);
      }
      setStorageMode(db(), mode);
      deleteTeamConfig("sync.enabled");
    });
    afterEach(async () => {
      await embedding.settleDocumentEmbeds();
      embedding._restoreProvider(provider);
      setStorageMode(db(), "blob");
    });

    function install(embed?: (texts: string[]) => Promise<Float32Array[]>) {
      embedding._restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            calls.push({ texts, inTransaction: databaseInTransaction(db()) });
            return embed ? embed(texts) : texts.map(() => NEXT);
          },
        },
      });
    }
    function seed() {
      const project = `/test/sync-vectors/${++seq}`;
      const pid = ensureProject(project);
      withApplying(() =>
        db()
          .query("UPDATE projects SET git_remote = 'test:vectors' WHERE id = ?")
          .run(pid),
      );
      const id = ltm.create({
        projectPath: project,
        scope: "project",
        category: "decision",
        title: "Before",
        content: "Same body",
        confidence: 0.5,
      });
      const logical = ltm.logicalIdOf(id);
      storeEmbedding(db(), "knowledge", id, OLD);
      enableSync("basic");
      return {
        id,
        logical,
        project,
        remote: currentKnowledgeRow(logical)!,
        outbox: readOutbox(0),
      };
    }
    function indexed(id: string) {
      return Boolean(
        db()
          .query(
            `SELECT id FROM knowledge_current k WHERE id = ? AND ${hasEmbeddingSql("knowledge", mode, "k")}`,
          )
          .get(id),
      );
    }
    function vector(id: string) {
      const row = db()
        .query(
          `SELECT embedding FROM ${mode === "vec0" ? "knowledge_vec" : "knowledge"} WHERE id = ?`,
        )
        .get(id) as { embedding: Buffer | null } | null;
      return row?.embedding ? Array.from(fromBlob(row.embedding)) : null;
    }

    test.each(["title", "category", "content"] as const)(
      "a %s revision is indexed after commit without a sync echo",
      async (field) => {
        const s = seed();
        install();
        expect(indexed(s.id)).toBe(true);
        const changed = {
          ...s.remote,
          [field]: field === "category" ? "gotcha" : "After",
        };
        applyRemoteKnowledge(changed);
        const current = ltm.getByLogical(s.logical)!;
        expect(current.id).not.toBe(s.id);
        await embedding.settleDocumentEmbeds();
        expect(indexed(current.id)).toBe(true);
        expect(vector(current.id)).toEqual(Array.from(NEXT));
        expect(calls).toEqual([
          {
            texts: [`${current.title}\n${current.content}`],
            inTransaction: false,
          },
        ]);
        expect(readOutbox(0)).toEqual(s.outbox);
        const hits = runVectorQuery(
          db(),
          mode === "vec0" ? "vec0" : "blob-js",
          NEXT,
          { kind: "knowledge", tenantId: "", limit: 100 },
        );
        expect(hits.map((h) => h.id)).toContain(current.id);
        expect(hits.map((h) => h.id)).not.toContain(s.id);
        if (mode === "vec0") expect(vector(s.id)).toBeNull();
      },
    );

    test("a newly pulled entry is indexed without re-enqueueing it", async () => {
      const s = seed();
      install();
      const logical = `remote-vector-${++seq}`;
      applyRemoteKnowledge({
        ...s.remote,
        id: logical,
        title: "New remote memory",
      });
      await embedding.settleDocumentEmbeds();
      expect(indexed(logical)).toBe(true);
      expect(calls).toHaveLength(1);
      expect(readOutbox(0)).toEqual(s.outbox);
    });

    test("identical replay and mutable metadata do not repeat embedding work", async () => {
      const s = seed();
      install();
      const changed = { ...s.remote, title: "After" };
      applyRemoteKnowledge(changed);
      await embedding.settleDocumentEmbeds();
      const id = ltm.getByLogical(s.logical)!.id;
      applyRemoteKnowledge(changed);
      applyRemoteKnowledge({ ...changed, sensitivity: "sensitive" });
      await embedding.settleDocumentEmbeds();
      expect(ltm.getByLogical(s.logical)!.id).toBe(id);
      expect(calls).toHaveLength(1);
      expect(readOutbox(0)).toEqual(s.outbox);
    });

    test("a failed append rolls back vector cleanup and schedules nothing", async () => {
      const s = seed();
      install();
      db().exec(
        "CREATE TEMP TRIGGER reject_vector_revision BEFORE INSERT ON knowledge WHEN new.title = 'Blocked' BEGIN SELECT RAISE(ABORT, 'blocked revision'); END",
      );
      try {
        expect(() =>
          applyRemoteKnowledge({ ...s.remote, title: "Blocked" }),
        ).toThrow("blocked revision");
      } finally {
        db().exec("DROP TRIGGER reject_vector_revision");
      }
      await embedding.settleDocumentEmbeds();
      expect(ltm.getByLogical(s.logical)!.id).toBe(s.id);
      expect(vector(s.id)).toEqual(Array.from(OLD));
      expect(calls).toEqual([]);
      expect(readOutbox(0)).toEqual(s.outbox);
    });

    test("an unavailable provider keeps the new version eligible for later backfill", () => {
      const s = seed();
      applyRemoteKnowledge({ ...s.remote, title: "After" });
      const current = ltm.getByLogical(s.logical)!;
      expect(current.id).not.toBe(s.id);
      expect(indexed(current.id)).toBe(false);
      expect(ltm.getByLogical(s.logical)!.confidence).toBe(0.5);
      expect(readOutbox(0)).toEqual(s.outbox);
      if (mode === "vec0") expect(vector(s.id)).toBeNull();
    });

    test("a provider failure does not roll back accepted memory or enqueue an echo", async () => {
      const s = seed();
      install(async () => {
        throw new Error("provider failure");
      });
      expect(() =>
        applyRemoteKnowledge({ ...s.remote, title: "After" }),
      ).not.toThrow();
      await embedding.settleDocumentEmbeds();
      expect(ltm.getByLogical(s.logical)!.title).toBe("After");
      expect(indexed(ltm.getByLogical(s.logical)!.id)).toBe(false);
      expect(readOutbox(0)).toEqual(s.outbox);
    });

    test("late results cannot restore a superseded version's vector", async () => {
      const s = seed();
      const releases: Array<() => void> = [];
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      install(
        (texts) =>
          new Promise((resolve) => {
            releases.push(() => resolve(texts.map(() => NEXT)));
            if (releases.length === 2) ready();
          }),
      );
      applyRemoteKnowledge({ ...s.remote, title: "First" });
      const first = ltm.getByLogical(s.logical)!.id;
      applyRemoteKnowledge({ ...s.remote, title: "Second" });
      await started;
      releases.forEach((release) => release());
      await embedding.settleDocumentEmbeds();
      expect(vector(first)).toBeNull();
      expect(indexed(ltm.getByLogical(s.logical)!.id)).toBe(true);
      expect(readOutbox(0)).toEqual(s.outbox);
    });

    test("a late local embed cannot restore a remotely deleted version", async () => {
      const s = seed();
      let release!: () => void;
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      install(
        (texts) =>
          new Promise((resolve) => {
            release = () => resolve(texts.map(() => NEXT));
            ready();
          }),
      );
      embedding.embedKnowledgeEntry(s.id, "Before", "Same body");
      await started;
      applyRemoteKnowledgeDelete(s.logical);
      release();
      await embedding.settleDocumentEmbeds();
      expect(ltm.getByLogical(s.logical)).toBeNull();
      expect(vector(s.id)).toEqual(mode === "vec0" ? null : Array.from(OLD));
      expect(readOutbox(0)).toEqual(s.outbox);
    });

    test("an in-flight pulled embedding cannot open a successor database", async () => {
      const s = seed();
      const oldPath = process.env.LORE_DB_PATH!;
      const successor = createTestDatabasePath("sync-vector-successor");
      let release!: () => void;
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      install(
        (texts) =>
          new Promise((resolve) => {
            release = () => resolve(texts.map(() => NEXT));
            ready();
          }),
      );
      applyRemoteKnowledge({ ...s.remote, title: "After" });
      await started;
      try {
        close();
        process.env.LORE_DB_PATH = successor;
        release();
        await embedding.settleDocumentEmbeds();
        expect(existsSync(successor)).toBe(false);
      } finally {
        release();
        close();
        process.env.LORE_DB_PATH = oldPath;
      }
    });
  });
}
