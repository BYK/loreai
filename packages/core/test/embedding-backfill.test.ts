import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import {
  _restoreProvider,
  _saveAndClearProvider,
  backfillDistillationEmbeddings,
  backfillEmbeddings,
  backfillEntityEmbeddings,
  fromBlob,
} from "../src/embedding";

const PROJECT = "/test/embedding-backfill";

function unit(v: number[]): Float32Array {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return new Float32Array(v.map((x) => x / n));
}

const VEC = unit([1, 0, 0]);

// A mock provider returning one fixed unit vector per input text. The real local
// ONNX provider isn't available in CI, so without this stub the backfill loops
// short-circuit at `getProvider()`/`embed()` and their write path —
// `storeEmbedding(db(), <table>, …)` in embedding.ts — is never exercised. This
// drives the real production backfill end-to-end and asserts the BLOB lands.
function installMockProvider(): unknown {
  const token = _saveAndClearProvider();
  _restoreProvider({
    provider: {
      maxBatchSize: 8,
      async embed(texts: string[], _inputType: "document" | "query") {
        return texts.map(() => VEC);
      },
    },
  });
  return token;
}

describe("backfill writes embeddings through storeEmbedding (blob layout)", () => {
  let token: unknown;
  let pid: string;

  beforeEach(() => {
    pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge").run();
    db().query("DELETE FROM distillations").run();
    db().query("DELETE FROM entities").run();
    db().query("DELETE FROM kv_meta WHERE key LIKE 'lore:%'").run();
    token = installMockProvider();
  });

  afterEach(() => {
    _restoreProvider(token);
  });

  function embeddingOf(table: string, id: string): Buffer | null {
    const row = db()
      .query(`SELECT embedding FROM ${table} WHERE id = ?`)
      .get(id) as { embedding: Buffer | null } | null;
    return row?.embedding ?? null;
  }

  test("backfillEmbeddings populates knowledge.embedding", async () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES ('bk', ?, 'test', 'T', 'C', ?, ?, 'bk')",
      )
      .run(pid, now, now);
    expect(embeddingOf("knowledge", "bk")).toBeNull();

    const n = await backfillEmbeddings();

    expect(n).toBe(1);
    const blob = embeddingOf("knowledge", "bk");
    expect(blob).not.toBeNull();
    expect(Array.from(fromBlob(blob as Buffer))).toEqual(Array.from(VEC));
  });

  test("backfillDistillationEmbeddings populates distillations.embedding", async () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES ('bd', ?, 's', '', '', 'some observation text', '', 0, 0, ?, 0)",
      )
      .run(pid, now);
    expect(embeddingOf("distillations", "bd")).toBeNull();

    const n = await backfillDistillationEmbeddings();

    expect(n).toBe(1);
    const blob = embeddingOf("distillations", "bd");
    expect(blob).not.toBeNull();
    expect(Array.from(fromBlob(blob as Buffer))).toEqual(Array.from(VEC));
  });

  test("backfillEntityEmbeddings populates entities.embedding", async () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES ('be', ?, 'tool', 'Entity', 0, ?, ?)",
      )
      .run(pid, now, now);
    expect(embeddingOf("entities", "be")).toBeNull();

    const n = await backfillEntityEmbeddings();

    expect(n).toBe(1);
    const blob = embeddingOf("entities", "be");
    expect(blob).not.toBeNull();
    expect(Array.from(fromBlob(blob as Buffer))).toEqual(Array.from(VEC));
  });
});
