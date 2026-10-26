import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { config } from "../src/config";
import {
  db,
  deleteTeamConfig,
  ensureProject,
  reinstallSyncCapture,
} from "../src/db";
import { isVecAvailable } from "../src/db/vec";
import { ensureVec0Store, setStorageMode } from "../src/db/vec-store";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import { enableSync, readOutbox, withApplying } from "../src/sync-data";
import { fromBlob } from "../src/vector-query";

const vector = new Float32Array(config().search.embeddings.dimensions);
vector[0] = 1;

for (const mode of ["blob", "vec0"] as const) {
  describe(`device-local document embeddings (${mode})`, () => {
    const state: { provider?: unknown } = {};

    beforeEach((ctx) => {
      state.provider = embedding._saveAndClearProvider();
      embedding._restoreProvider({ provider: null });
      if (mode === "vec0") {
        if (!isVecAvailable()) ctx.skip();
        ensureVec0Store(db(), vector.length);
      }
      setStorageMode(db(), mode);
      deleteTeamConfig("sync.enabled");
    });

    afterEach(async () => {
      await embedding.settleDocumentEmbeds();
      embedding._restoreProvider(state.provider);
      setStorageMode(db(), "blob");
    });

    test.each(["knowledge", "entities", "distillations"] as const)(
      "a delayed %s embedding preserves queued content without adding a sync echo",
      async (table) => {
        const path = `/test/document-vector/${randomUUID()}`;
        const project = ensureProject(path);
        const now = Date.now();
        withApplying(() => {
          db()
            .query(
              "UPDATE projects SET git_remote = 'test:document-vector' WHERE id = ?",
            )
            .run(project);
          db().query("DELETE FROM profiles").run();
          db()
            .query(
              "INSERT INTO profiles (id, tier, created_at, updated_at) VALUES ('document-vector-user', 'pro', ?, ?)",
            )
            .run(now, now);
        });
        reinstallSyncCapture();
        enableSync("pro");

        const id =
          table === "knowledge"
            ? ltm.create({
                projectPath: path,
                scope: "project",
                category: "decision",
                title: "Local document",
                content: "Only content belongs in sync",
              })
            : randomUUID();
        if (table === "entities") {
          db()
            .query(
              "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES (?, ?, 'tool', 'Local document', 0, ?, ?)",
            )
            .run(id, project, now, now);
        } else if (table === "distillations") {
          db()
            .query(
              "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES (?, ?, 'document-vector-session', '', '', 'Local document', '[]', 0, 2, ?, 0)",
            )
            .run(id, project, now);
        }

        const before = readOutbox(0);
        expect(before).toContainEqual(
          expect.objectContaining({
            table_name: table,
            row_id: id,
            op: "upsert",
          }),
        );
        const started = Promise.withResolvers<void>();
        const completed = Promise.withResolvers<Float32Array[]>();
        embedding._restoreProvider({
          provider: {
            maxBatchSize: 8,
            embed() {
              started.resolve();
              return completed.promise;
            },
          },
        });

        try {
          switch (table) {
            case "knowledge":
              embedding.embedKnowledgeEntry(
                id,
                "Local document",
                "Only content belongs in sync",
              );
              break;
            case "entities":
              embedding.embedEntity(id, "Local document", []);
              break;
            case "distillations":
              embedding.embedDistillation(id, "Local document");
              break;
            default:
              throw new Error("Unexpected document table");
          }
          await started.promise;
          completed.resolve([vector]);
          await embedding.settleDocumentEmbeds();

          const vectorTable =
            mode === "blob"
              ? table
              : {
                  knowledge: "knowledge_vec",
                  entities: "entity_vec",
                  distillations: "distillation_vec",
                }[table];
          const stored = db()
            .query(`SELECT embedding FROM ${vectorTable} WHERE id = ?`)
            .get(id) as {
            embedding: Buffer;
          };
          expect(Array.from(fromBlob(stored.embedding))).toEqual(
            Array.from(vector),
          );
          expect(readOutbox(0)).toEqual(before);

          const field = {
            knowledge: "title",
            entities: "canonical_name",
            distillations: "observations",
          }[table];
          db()
            .query(
              `UPDATE ${table} SET ${field} = 'Changed content' WHERE id = ?`,
            )
            .run(id);
          expect(readOutbox(0).slice(before.length)).toContainEqual(
            expect.objectContaining({
              table_name: table,
              row_id: id,
              op: "upsert",
            }),
          );
        } finally {
          completed.resolve([vector]);
          await embedding.settleDocumentEmbeds();
        }
      },
    );
  });
}
