import { afterEach, describe, test, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { db, ensureProject } from "../src/db";
import { LOCAL_MODEL_PATH_ENV } from "../src/embedding-vendor";
import {
  cosineSimilarity,
  toBlob,
  fromBlob,
  isAvailable,
  vectorSearch,
  vectorSearchEntities,
  checkConfigChange,
  _saveAndClearProvider,
  _restoreProvider,
  embed,
  runStartupBackfill,
  LocalProviderUnavailableError,
  pickRemoteFallback,
  _resetLocalProviderProbe,
  _markLocalProviderUnavailable,
} from "../src/embedding";

describe("cosineSimilarity", () => {
  test("identical vectors return 1.0", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 5);
  });

  test("opposite vectors return -1.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test("orthogonal vectors return 0.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test("similar vectors return high positive value", () => {
    const a = new Float32Array([1, 0.1, 0]);
    const b = new Float32Array([0.9, 0.2, 0]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  test("zero vector returns 0", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("both zero vectors return 0", () => {
    const a = new Float32Array([0, 0, 0]);
    expect(cosineSimilarity(a, a)).toBe(0);
  });
});

describe("BLOB round-trip", () => {
  test("Float32Array survives toBlob → fromBlob", () => {
    const original = new Float32Array([0.123, -0.456, 0.789, 1.0, -1.0]);
    const blob = toBlob(original);
    const restored = fromBlob(blob);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 6);
    }
  });

  test("single element array", () => {
    const original = new Float32Array([42.5]);
    const restored = fromBlob(toBlob(original));
    expect(restored[0]).toBeCloseTo(42.5, 5);
  });

  test("empty array", () => {
    const original = new Float32Array([]);
    const restored = fromBlob(toBlob(original));
    expect(restored.length).toBe(0);
  });

  test("large array (1024 dims)", () => {
    const original = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) original[i] = Math.random() * 2 - 1;
    const restored = fromBlob(toBlob(original));
    expect(restored.length).toBe(1024);
    for (let i = 0; i < 1024; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 6);
    }
  });
});

describe("isAvailable", () => {
  // Reset the local-provider probe before each assertion. These tests assert
  // the OPTIMISTIC pre-probe state (isAvailable() === true). Without this
  // reset, an earlier test (or a prior test file) that probed the real ONNX
  // worker and hit a transient model-download failure would poison the
  // module-global probe flag and make these fail spuriously.
  beforeEach(() => {
    _resetLocalProviderProbe();
  });

  test("returns true with default local provider (no API key needed)", () => {
    // Default provider is "local" — no API key needed.
    // LocalProvider construction always succeeds; the ONNX model init
    // happens lazily on first embed() call, so isAvailable() is true.
    expect(isAvailable()).toBe(true);
  });

  test("returns true with default config (provider not yet probed)", () => {
    expect(isAvailable()).toBe(true);
  });
});

describe("local provider unavailable fallback", () => {
  // Simulates a failure path: the local provider's ONNX runtime can't
  // initialize. Callers should see `isAvailable() === false` and never
  // have to handle a thrown error from deep inside `embed()`.
  //
  // These tests assert the *no-fallback* behaviour, so we explicitly strip
  // any VOYAGE_API_KEY / OPENAI_API_KEY that happens to be in the dev env.

  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;
  let savedProvider: unknown;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Save the real provider (with its live worker) and clear the cache
    // so these tests get a fresh LocalProvider with _markLocalProviderUnavailable.
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    // Restore real probe state + original provider for subsequent tests.
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
  });

  test("isAvailable() returns false once local provider is known broken", () => {
    _resetLocalProviderProbe();
    expect(isAvailable()).toBe(true); // optimistic before probe runs

    _markLocalProviderUnavailable();
    expect(isAvailable()).toBe(false);
  });

  test("embed() throws LocalProviderUnavailableError when local provider is broken", async () => {
    _markLocalProviderUnavailable();

    let caught: unknown;
    try {
      await embed(["test"], "query");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LocalProviderUnavailableError);
  });

  test("isAvailable() flips to false after the first embed() failure", async () => {
    _markLocalProviderUnavailable();

    await expect(embed(["test"], "query")).rejects.toBeInstanceOf(
      LocalProviderUnavailableError,
    );
    expect(isAvailable()).toBe(false);
  });

  test("runStartupBackfill returns zeroed stats when the provider is unavailable", async () => {
    _markLocalProviderUnavailable();
    const stats = await runStartupBackfill();
    expect(stats).toEqual({
      pendingKnowledge: 0,
      pendingDistillations: 0,
      knowledgeEmbedded: 0,
      distillationEmbedded: 0,
      entityEmbedded: 0,
      knowledgeTotal: 0,
      knowledgeWithEmbedding: 0,
      distillationTotal: 0,
      distillationWithEmbedding: 0,
    });
  });
});

describe("local provider unavailable — no auto-fallback (remote is opt-in)", () => {
  let savedProvider: unknown;

  beforeEach(() => {
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
  });

  test("embed() throws LocalProviderUnavailableError when local is broken (no auto-switch to Voyage)", async () => {
    _markLocalProviderUnavailable();
    await expect(embed(["test query"], "query")).rejects.toBeInstanceOf(
      LocalProviderUnavailableError,
    );
  });

  test("embed() throws LocalProviderUnavailableError when local is broken (no auto-switch to OpenAI)", async () => {
    _markLocalProviderUnavailable();
    await expect(embed(["test query"], "query")).rejects.toBeInstanceOf(
      LocalProviderUnavailableError,
    );
  });

  test("isAvailable() returns false when local provider is broken", () => {
    _markLocalProviderUnavailable();
    expect(isAvailable()).toBe(false);
  });
});

describe("pickRemoteFallback", () => {
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    else delete process.env.VOYAGE_API_KEY;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    else delete process.env.OPENAI_API_KEY;
  });

  test("returns null when neither key is set", () => {
    expect(pickRemoteFallback()).toBeNull();
  });

  test("returns Voyage when only VOYAGE_API_KEY is set", () => {
    process.env.VOYAGE_API_KEY = "vk-test-key-that-is-long-enough";
    const result = pickRemoteFallback();
    expect(result?.name).toBe("voyage");
  });

  test("returns OpenAI when only OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test-key-that-is-long-enough";
    const result = pickRemoteFallback();
    expect(result?.name).toBe("openai");
  });

  test("Voyage wins when both keys are set", () => {
    process.env.VOYAGE_API_KEY = "vk-test-key-that-is-long-enough";
    process.env.OPENAI_API_KEY = "sk-test-key-that-is-long-enough";
    const result = pickRemoteFallback();
    expect(result?.name).toBe("voyage");
  });

  test("rejects placeholder API keys (e.g. 'nokey')", () => {
    process.env.OPENAI_API_KEY = "nokey";
    expect(pickRemoteFallback()).toBeNull();
  });
});

describe("vectorSearch", () => {
  const PROJECT = "/test/embedding/vectorsearch";

  beforeEach(() => {
    db().query("DELETE FROM knowledge").run();
  });

  test("returns entries sorted by similarity descending", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    const vecA = new Float32Array([1, 0, 0]);
    const vecB = new Float32Array([0, 1, 0]);
    const vecC = new Float32Array([0.9, 0.1, 0]);

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "embed-a",
        pid,
        "test",
        "Entry A",
        "Perfect match",
        1.0,
        now,
        now,
        toBlob(vecA),
      );
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "embed-b",
        pid,
        "test",
        "Entry B",
        "Orthogonal",
        1.0,
        now,
        now,
        toBlob(vecB),
      );
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "embed-c",
        pid,
        "test",
        "Entry C",
        "Similar",
        1.0,
        now,
        now,
        toBlob(vecC),
      );

    const query = new Float32Array([1, 0, 0]);
    const results = vectorSearch(query, 10);

    expect(results.length).toBe(3);
    expect(results[0].id).toBe("embed-a");
    expect(results[0].similarity).toBeCloseTo(1.0, 3);
    expect(results[1].id).toBe("embed-c");
    expect(results[1].similarity).toBeGreaterThan(0.9);
    expect(results[2].id).toBe("embed-b");
    expect(results[2].similarity).toBeCloseTo(0.0, 3);
  });

  test("respects limit parameter", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      const vec = new Float32Array([Math.random(), Math.random(), 0]);
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `embed-limit-${i}`,
          pid,
          "test",
          `Entry ${i}`,
          `Content ${i}`,
          1.0,
          now,
          now,
          toBlob(vec),
        );
    }

    const query = new Float32Array([1, 0, 0]);
    const results = vectorSearch(query, 2);
    expect(results.length).toBe(2);
  });

  test("skips entries without embeddings", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "embed-yes",
        pid,
        "test",
        "Has Embedding",
        "Content",
        1.0,
        now,
        now,
        toBlob(new Float32Array([1, 0, 0])),
      );

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("embed-no", pid, "test", "No Embedding", "Content", 1.0, now, now);

    const query = new Float32Array([1, 0, 0]);
    const results = vectorSearch(query, 10);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("embed-yes");
  });

  test("skips low-confidence entries", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "embed-high",
        pid,
        "test",
        "High Confidence",
        "Content",
        1.0,
        now,
        now,
        toBlob(new Float32Array([1, 0, 0])),
      );

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "embed-low",
        pid,
        "test",
        "Low Confidence",
        "Content",
        0.1,
        now,
        now,
        toBlob(new Float32Array([1, 0, 0])),
      );

    const query = new Float32Array([1, 0, 0]);
    const results = vectorSearch(query, 10);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("embed-high");
  });
});

describe("vectorSearchEntities", () => {
  const PROJECT = "/test/embedding/entity-vectorsearch";

  beforeEach(() => {
    db().query("DELETE FROM entity_aliases").run();
    db().query("DELETE FROM entities").run();
  });

  function insertEntity(id: string, name: string, vec: Float32Array): void {
    const pid = ensureProject(PROJECT);
    const now = Date.now();
    db()
      .query(
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at, embedding) VALUES (?, ?, 'tool', ?, 0, ?, ?, ?)",
      )
      .run(id, pid, name, now, now, toBlob(vec));
  }

  test("returns entities sorted by similarity descending", () => {
    insertEntity("ent-a", "Exact", new Float32Array([1, 0, 0]));
    insertEntity("ent-b", "Orthogonal", new Float32Array([0, 1, 0]));
    insertEntity("ent-c", "Close", new Float32Array([0.9, 0.1, 0]));

    const results = vectorSearchEntities(new Float32Array([1, 0, 0]), 10);
    expect(results.map((r) => r.id)).toEqual(["ent-a", "ent-c", "ent-b"]);
    expect(results[0].similarity).toBeCloseTo(1, 5);
  });

  test("ignores entities with no embedding and respects limit", () => {
    insertEntity("ent-x", "Has vec", new Float32Array([1, 0, 0]));
    const pid = ensureProject(PROJECT);
    const now = Date.now();
    db()
      .query(
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES ('ent-novec', ?, 'tool', 'No vec', 0, ?, ?)",
      )
      .run(pid, now, now);

    const results = vectorSearchEntities(new Float32Array([1, 0, 0]), 1);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("ent-x");
  });
});

function assertLocalModelAvailable(): void {
  const path = process.env[LOCAL_MODEL_PATH_ENV];
  if (!path) {
    throw new Error(
      `Local embedding model not available: ${LOCAL_MODEL_PATH_ENV} is not set. ` +
        `Set it to the vendored model cache root (e.g. .vendor-build/.model-cache) ` +
        `to run end-to-end embedding tests. See packages/core/src/embedding-vendor.ts.`,
    );
  }
  if (!existsSync(path)) {
    throw new Error(
      `Local embedding model not available: ${LOCAL_MODEL_PATH_ENV}="${path}" ` +
        `does not exist. Vendor the model or unset the env var.`,
    );
  }
}

const localModelAvailable = (() => {
  try {
    assertLocalModelAvailable();
    return true;
  } catch {
    return false;
  }
})();

const describeLocalProvider = localModelAvailable ? describe : describe.skip;

describeLocalProvider("LocalProvider integration", () => {
  const PROJECT = "/test/embedding/local";

  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  test("embed produces Float32Array vectors with 768 dimensions", async () => {
    const { embed } = await import("../src/embedding");
    const [vec] = await embed(["test query for embedding"], "query");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
    // Vector should not be all zeros
    const norm = Array.from(vec).reduce((sum, v) => sum + v * v, 0);
    expect(norm).toBeGreaterThan(0);
  }, 60_000);

  test("query and document embeddings have reasonable similarity", async () => {
    const { embed, cosineSimilarity } = await import("../src/embedding");
    const [queryVec] = await embed(["database migration"], "query");
    const [docVec] = await embed(
      ["PostgreSQL database schema migration tool"],
      "document",
    );
    const [unrelatedVec] = await embed(
      ["chocolate cake recipe with frosting"],
      "document",
    );

    const relevantSim = cosineSimilarity(queryVec, docVec);
    const unrelatedSim = cosineSimilarity(queryVec, unrelatedVec);

    // Relevant doc should have higher similarity than unrelated
    expect(relevantSim).toBeGreaterThan(unrelatedSim);
  }, 60_000);

  test("vectorSearch returns results using local embeddings", async () => {
    const { embed, toBlob, vectorSearch } = await import("../src/embedding");
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    const texts = [
      "PostgreSQL database migration",
      "React server components",
      "Kubernetes deployment strategy",
    ];
    const vecs = await embed(texts, "document");

    for (let i = 0; i < texts.length; i++) {
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `local-${i}`,
          pid,
          "test",
          `Entry ${i}`,
          texts[i],
          1.0,
          now,
          now,
          toBlob(vecs[i]),
        );
    }

    const [queryVec] = await embed(["database schema changes"], "query");
    const results = vectorSearch(queryVec, 3);

    expect(results.length).toBe(3);
    // The PostgreSQL entry should be most relevant
    expect(results[0].id).toBe("local-0");
    expect(results[0].similarity).toBeGreaterThan(0.3);
  }, 60_000);
});

describeLocalProvider("LocalProvider worker thread", () => {
  test("embed produces Float32Array vectors with 768 dimensions through worker", async () => {
    const [vec] = await embed(["test query via worker"], "query");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
    const norm = Array.from(vec).reduce((sum, v) => sum + v * v, 0);
    expect(norm).toBeGreaterThan(0);
  }, 60_000);

  test("concurrent embed() calls are serialized correctly", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      embed([`concurrent test ${i}`], "document"),
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(5);
    for (const [vec] of results) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
    }
  }, 60_000);

  test("query embed interleaved with document batch resolves correctly", async () => {
    const docPromise = embed(
      Array.from({ length: 5 }, (_, i) => `document text ${i}`),
      "document",
    );
    const queryPromise = embed(["urgent query"], "query");

    const [docs, [queryVec]] = await Promise.all([docPromise, queryPromise]);
    expect(docs).toHaveLength(5);
    for (const vec of docs) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
    }
    expect(queryVec).toBeInstanceOf(Float32Array);
    expect(queryVec.length).toBe(768);
  }, 60_000);
});

describe("checkConfigChange", () => {
  const PROJECT = "/test/embedding/configchange";

  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM kv_meta WHERE key LIKE 'lore:%'").run();
  });

  test("first call stores fingerprint and returns true", () => {
    const changed = checkConfigChange();
    expect(changed).toBe(true);

    const row = db()
      .query("SELECT value FROM kv_meta WHERE key = 'lore:embedding_config'")
      .get() as { value: string } | null;
    expect(row).not.toBeNull();
    // Default provider is now "local" with nomic-ai/nomic-embed-text-v1.5:768
    expect(row?.value).toContain("local");
    expect(row?.value).toContain("nomic-ai/nomic-embed-text-v1.5");
    expect(row?.value).toContain("768");
  });

  test("second call with same config returns false", () => {
    checkConfigChange();
    const changed = checkConfigChange();
    expect(changed).toBe(false);
  });

  test("clears embeddings when fingerprint changes", () => {
    const pid = ensureProject(PROJECT);
    const now = Date.now();

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, confidence, created_at, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "cc-1",
        pid,
        "test",
        "Test",
        "Content",
        1.0,
        now,
        now,
        toBlob(new Float32Array([1, 0, 0])),
      );

    // Store a different fingerprint (simulating a previous config)
    db()
      .query("INSERT INTO kv_meta (key, value) VALUES (?, ?)")
      .run("lore:embedding_config", "old-model:512");

    const changed = checkConfigChange();
    expect(changed).toBe(true);

    const row = db()
      .query("SELECT embedding FROM knowledge WHERE id = 'cc-1'")
      .get() as { embedding: Buffer | null };
    expect(row.embedding).toBeNull();
  });
});
