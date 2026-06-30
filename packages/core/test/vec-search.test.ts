import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { Database } from "#db/driver";
import { close, db, ensureProject, withTransaction } from "../src/db";
import {
  isVecAvailable,
  loadVecForConnection,
  vec0KnnSmokeOk,
} from "../src/db/vec";
import * as log from "../src/log";
import {
  toBlob,
  vectorSearch,
  vectorSearchAllDistillations,
  vectorSearchDistillations,
  vectorSearchTemporal,
} from "../src/embedding";
import { MAX_TEMPORAL_VECTOR_ROWS } from "../src/vector-query";

// Whether the running Node build supports the sqlite-vec extension. `node:sqlite`
// gained `allowExtension` in Node 23.5; below that we expect the JS fallback.
function nodeSupportsVec(): boolean {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  return maj > 23 || (maj === 23 && min >= 5);
}

function unit(v: number[]): Float32Array {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return new Float32Array(v.map((x) => x / n));
}

const PROJECT = "/test/vec-search";

describe("sqlite-vec extension loading", () => {
  test("extension is actually loaded on supported runtimes", () => {
    // Trigger connection open (+ loadVecExtension) via any db() use.
    ensureProject(PROJECT);
    if (nodeSupportsVec()) {
      // Regression guard: if this fails, the loader broke and every other
      // vector-search test silently exercises only the JS fallback.
      expect(isVecAvailable()).toBe(true);
      const row = db().query("SELECT vec_version() AS v").get() as {
        v: string;
      };
      expect(typeof row.v).toBe("string");
      expect(row.v.length).toBeGreaterThan(0);
    } else {
      expect(isVecAvailable()).toBe(false);
    }
  });

  // Proves the vec SQL branch is actually executed (not silently falling back
  // to JS). The two paths agree only for L2-normalized vectors; for a NON-
  // normalized stored vector they diverge because vec_distance_cosine()
  // normalizes internally while the JS dot product does not. Stored [2,0,0]
  // vs query [1,0,0]: vec → cosine 1.0; JS → raw dot 2.0. Asserting ~1.0 fails
  // if the vec branch is removed.
  test("vec branch is exercised when available (not silent fallback)", async () => {
    if (!isVecAvailable()) return; // JS-only runtime: nothing to prove here
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge").run();
    const now = Date.now();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, embedding, logical_id) VALUES (?, ?, 'test', 'NonNorm', '', ?, ?, ?, ?)",
      )
      .run(
        "k-nonnorm",
        pid,
        now,
        now,
        toBlob(new Float32Array([2, 0, 0])),
        "k-nonnorm",
      );
    const hits = await vectorSearch(new Float32Array([1, 0, 0]), 1);
    expect(hits.length).toBe(1);
    expect(hits[0].similarity).toBeCloseTo(1.0, 5); // vec (normalized), not 2.0 (raw dot)
  });
});

// The loader emits exactly one status line per connection so a deploy can be
// verified from `journalctl` (LORE_DEBUG=1) without a manual probe: an "enabled"
// line on the native path, or a reason on each fallback. These tests pin those
// lines so the diagnostic can't silently regress.
describe("loadVecExtension startup logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LORE_DISABLE_VEC;
    close(); // fresh connection (+ reset vec state) for the next test/suite
  });

  function infoLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((c: unknown[]) => c.map(String).join(" "));
  }

  test("logs the enabled line on supported runtimes", () => {
    if (!nodeSupportsVec()) return; // JS-only runtime: see the kill-switch leg
    close(); // drop the connection opened by earlier suites + reset vec state
    const info = vi.spyOn(log, "info");
    ensureProject(PROJECT); // opens a fresh connection → runs loadVecExtension
    expect(isVecAvailable()).toBe(true);
    expect(
      infoLines(info).some((l) => l.includes("native vector search enabled")),
    ).toBe(true);
  });

  test("logs the disabled reason under the LORE_DISABLE_VEC kill-switch", () => {
    close(); // reset vec state so the env var is re-read on the next open
    process.env.LORE_DISABLE_VEC = "1";
    const info = vi.spyOn(log, "info");
    ensureProject(PROJECT);
    expect(isVecAvailable()).toBe(false);
    expect(infoLines(info).some((l) => l.includes("LORE_DISABLE_VEC"))).toBe(
      true,
    );
  });
});

// The load-time vec0 KNN smoke guard. `vec_version()` only proves the scalar
// SQL functions registered; the loader additionally round-trips a tiny vec0 KNN
// query before trusting the native fast path. This matters because a cut-over
// (vec0-only) DB has no base `embedding` BLOB column to fall back to — a
// loads-but-broken vec0 must be demoted to the JS fallback here, not discovered
// at query time.
describe("vec0 KNN smoke guard (vec0KnnSmokeOk)", () => {
  test("passes on a vec-loaded connection and is repeatable", () => {
    if (!isVecAvailable()) return; // JS-only runtime: nothing to probe
    ensureProject(PROJECT); // ensure the shared connection is open + vec-loaded
    // Twice over, to prove the probe drops its scratch table each call so a
    // re-probe on the same connection still works (the worker-reader pattern).
    expect(vec0KnnSmokeOk(db())).toBe(true);
    expect(vec0KnnSmokeOk(db())).toBe(true);
  });

  test("leaves no scratch table behind", () => {
    if (!isVecAvailable()) return;
    ensureProject(PROJECT);
    vec0KnnSmokeOk(db());
    const leftover = db()
      .query(
        "SELECT name FROM temp.sqlite_master WHERE name = '__lore_vec0_smoke'",
      )
      .get() as { name?: string } | null | undefined;
    expect(leftover ?? null).toBeNull();
  });

  // Fail-closed / non-vacuous: a connection that never loaded sqlite-vec has no
  // `vec0` module, so `CREATE VIRTUAL TABLE … USING vec0` throws and the guard
  // reports false. If the guard ever stopped genuinely exercising vec0 (e.g.
  // returned a constant `true`), THIS assertion would fail — which is the point.
  test("fails closed when the vec0 module is absent", () => {
    const raw = new Database(":memory:"); // no loadExtension → no vec0 module
    try {
      expect(vec0KnnSmokeOk(raw)).toBe(false);
    } finally {
      raw.close();
    }
  });

  // The probe writes (CREATE temp table + INSERT), so it requires a writable
  // connection. This is WHY only the main writer connection runs it and the
  // query_only reader path (loadVecForConnection) does not — see below.
  test("returns false on a query_only (read-only) connection", () => {
    if (!isVecAvailable()) return;
    ensureProject(PROJECT);
    const raw = new Database(":memory:");
    loadVecForConnection(raw); // vec0 module IS loaded on this connection…
    raw.exec("PRAGMA query_only = TRUE"); // …but writes are now forbidden
    try {
      // false because the probe can't write — NOT because vec0 is missing
      // (read-only `MATCH` would still work; see the reader-path test below).
      expect(vec0KnnSmokeOk(raw)).toBe(false);
    } finally {
      raw.close();
    }
  });
});

// Worker readers load sqlite-vec on their OWN connection via
// `loadVecForConnection` (see db/reader.ts) — a path the main-connection tests
// never exercise (the gap tracked in #1033). Unlike the main loader it does NOT
// run the write-based vec0 KNN smoke, because reader connections are opened
// `query_only = TRUE`; the host-level vec0 capability is proven once on the
// writable main connection. Here it runs against throwaway in-memory connections.
describe("loadVecForConnection (worker reader path)", () => {
  test("loads on a fresh connection iff the runtime is vec-capable", () => {
    ensureProject(PROJECT); // (re)open the main connection so isVecAvailable() is current
    const raw = new Database(":memory:");
    try {
      // Reaches the same load verdict as the main loader: extension loads +
      // vec_version() comes back (true) on a capable runtime, JS fallback
      // (false) on one without the extension.
      expect(loadVecForConnection(raw)).toBe(isVecAvailable());
    } finally {
      raw.close();
    }
  });

  // 🔴 Regression guard (the bug the SEA binary smoke test caught): a real
  // reader connection is `query_only = TRUE`, so it can only SELECT. A
  // write-based vec0 probe (CREATE temp table + INSERT) would throw
  // "readonly database" and FALSELY demote a working read-only connection to
  // the JS fallback. `loadVecForConnection` must therefore NOT probe with
  // writes — a query_only reader must still report vec available.
  test("reports vec available on a query_only reader connection", () => {
    ensureProject(PROJECT);
    const raw = new Database(":memory:");
    raw.exec("PRAGMA query_only = TRUE"); // mirror db/reader.ts
    try {
      expect(loadVecForConnection(raw)).toBe(isVecAvailable());
    } finally {
      raw.close();
    }
  });

  test("honours the LORE_DISABLE_VEC kill-switch", () => {
    const prev = process.env.LORE_DISABLE_VEC;
    process.env.LORE_DISABLE_VEC = "1";
    const raw = new Database(":memory:");
    try {
      expect(loadVecForConnection(raw)).toBe(false);
    } finally {
      raw.close();
      if (prev === undefined) delete process.env.LORE_DISABLE_VEC;
      else process.env.LORE_DISABLE_VEC = prev;
    }
  });
});

// `vectorSearch` accepts an excludeCategories filter that must be honoured on
// BOTH the vec fast-path and the JS fallback. We seed two entries with
// IDENTICAL embeddings differing only by category, so without the filter both
// tie for the top slot; the excluded one must disappear.
describe("vectorSearch excludeCategories", () => {
  function seedTwoCategories(pid: string): void {
    db().query("DELETE FROM knowledge").run();
    const now = Date.now();
    const stmt = db().query(
      "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, embedding, logical_id) VALUES (?, ?, ?, '', '', ?, ?, ?, ?)",
    );
    stmt.run(
      "k-keep",
      pid,
      "decision",
      now,
      now,
      toBlob(unit([1, 0, 0])),
      "k-keep",
    );
    stmt.run(
      "k-drop",
      pid,
      "preference",
      now,
      now,
      toBlob(unit([1, 0, 0])),
      "k-drop",
    );
  }

  test("excludes the named category on the vec path", async () => {
    if (!isVecAvailable()) return; // JS leg below covers the fallback branch
    const pid = ensureProject(PROJECT);
    seedTwoCategories(pid);
    const ids = (
      await vectorSearch(new Float32Array([1, 0, 0]), 10, ["preference"])
    ).map((h) => h.id);
    expect(ids).toContain("k-keep");
    expect(ids).not.toContain("k-drop");
  });

  test("excludes the named category on the JS fallback path", async () => {
    const pid = ensureProject(PROJECT);
    seedTwoCategories(pid);
    close();
    process.env.LORE_DISABLE_VEC = "1";
    try {
      expect(isVecAvailable()).toBe(false);
      const ids = (
        await vectorSearch(new Float32Array([1, 0, 0]), 10, ["preference"])
      ).map((h) => h.id);
      expect(ids).toContain("k-keep");
      expect(ids).not.toContain("k-drop");
    } finally {
      delete process.env.LORE_DISABLE_VEC;
      close(); // re-enable vec for subsequent suites
    }
  });
});

describe("vectorSearchDistillations / vectorSearchAllDistillations", () => {
  beforeEach(() => {
    db().query("DELETE FROM distillations").run();
  });

  function insertDistillation(
    id: string,
    pid: string,
    vec: Float32Array,
    opts: { archived?: number; session?: string; createdAt?: number } = {},
  ): void {
    const now = opts.createdAt ?? Date.now();
    db()
      .query(
        "INSERT INTO distillations (id, project_id, session_id, narrative, facts, source_ids, generation, token_count, created_at, archived, embedding) VALUES (?, ?, ?, '', '', '', 0, 0, ?, ?, ?)",
      )
      .run(
        id,
        pid,
        opts.session ?? "sess-1",
        now,
        opts.archived ?? 0,
        toBlob(vec),
      );
  }

  test("ranks by similarity and excludes archived", async () => {
    const pid = ensureProject(PROJECT);
    insertDistillation("d-near", pid, unit([1, 0, 0]));
    insertDistillation("d-mid", pid, unit([0.6, 0.4, 0]));
    insertDistillation("d-far", pid, unit([0, 1, 0]));
    insertDistillation("d-archived", pid, unit([1, 0, 0]), { archived: 1 });

    const hits = await vectorSearchDistillations(
      new Float32Array([1, 0, 0]),
      10,
    );
    const ids = hits.map((h) => h.id);
    expect(ids).toEqual(["d-near", "d-mid", "d-far"]);
    expect(ids).not.toContain("d-archived");
    expect(hits[0].similarity).toBeGreaterThan(hits[1].similarity);
    expect(hits[1].similarity).toBeGreaterThan(hits[2].similarity);
  });

  test("allDistillations includes archived and returns session_id", async () => {
    const pid = ensureProject(PROJECT);
    insertDistillation("a-near", pid, unit([1, 0, 0]), {
      archived: 1,
      session: "sX",
    });
    insertDistillation("a-far", pid, unit([0, 1, 0]), { session: "sY" });

    const hits = await vectorSearchAllDistillations(
      new Float32Array([1, 0, 0]),
      pid,
      10,
    );
    expect(hits[0].id).toBe("a-near");
    expect(hits[0].session_id).toBe("sX");
    expect(hits.map((h) => h.id)).toContain("a-far");
  });
});

describe("vectorSearchTemporal", () => {
  beforeEach(() => {
    db().query("DELETE FROM temporal_messages").run();
  });

  function insertTemporal(
    id: string,
    pid: string,
    session: string,
    vec: Float32Array,
    createdAt?: number,
  ): void {
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, embedding) VALUES (?, ?, ?, 'user', 'msg', 0, 0, ?, ?)",
      )
      .run(id, pid, session, createdAt ?? Date.now(), toBlob(vec));
  }

  test("ranks by similarity, scoped to project", async () => {
    const pid = ensureProject(PROJECT);
    insertTemporal("t-near", pid, "s1", unit([1, 0, 0]));
    insertTemporal("t-far", pid, "s1", unit([0, 1, 0]));

    const hits = await vectorSearchTemporal(
      new Float32Array([1, 0, 0]),
      pid,
      10,
    );
    expect(hits.map((h) => h.id)).toEqual(["t-near", "t-far"]);
  });

  test("optional session scoping", async () => {
    const pid = ensureProject(PROJECT);
    insertTemporal("t-s1", pid, "s1", unit([1, 0, 0]));
    insertTemporal("t-s2", pid, "s2", unit([1, 0, 0]));

    const hits = await vectorSearchTemporal(
      new Float32Array([1, 0, 0]),
      pid,
      10,
      "s1",
    );
    expect(hits.map((h) => h.id)).toEqual(["t-s1"]);
  });

  // Stopgap recency cap (MAX_TEMPORAL_VECTOR_ROWS): only the most-recent N rows
  // are scored, so a vector search can never fan out across an unbounded
  // temporal_messages table. Guards both the vec subquery and the JS LIMIT.
  test("recency cap ages the oldest rows out of the temporal vector window", async () => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM temporal_messages").run();
    const match = unit([1, 0, 0]);
    const noMatch = unit([0, 1, 0]);
    // The oldest row uniquely matches the query but sits one slot *beyond* the
    // window: cap non-matching rows sit on top of it, and a newest row also
    // matches. With the cap, only "t-recent" comes back; "t-old" is invisible.
    // Without the cap both matches would tie for #1 — that's the regression
    // this guards (revert the cap → "t-old" reappears → this fails).
    withTransaction(() => {
      insertTemporal("t-old", pid, "s1", match, 1);
      for (let i = 0; i < MAX_TEMPORAL_VECTOR_ROWS; i++) {
        insertTemporal(`t-mid-${i}`, pid, "s1", noMatch, 1_000 + i);
      }
      insertTemporal("t-recent", pid, "s1", match, 9_000_000);
    });

    const assertCapped = async () => {
      // Project-only path (the shape the sole production caller uses).
      const projIds = (
        await vectorSearchTemporal(new Float32Array([1, 0, 0]), pid, 10)
      ).map((h) => h.id);
      expect(projIds).toContain("t-recent"); // newest match survives the cap
      expect(projIds).not.toContain("t-old"); // oldest match aged out of window
      // Session-scoped path exercises the separate session cap params (the
      // 5-tuple vec / 3-tuple JS bindings). All rows live in session "s1", so
      // the recency window — and thus the result — is identical.
      const sessIds = (
        await vectorSearchTemporal(new Float32Array([1, 0, 0]), pid, 10, "s1")
      ).map((h) => h.id);
      expect(sessIds).toContain("t-recent");
      expect(sessIds).not.toContain("t-old");
    };

    // Default path (vec when the runtime supports it).
    await assertCapped();

    // Force the JS brute-force fallback over the SAME rows and re-check.
    close();
    process.env.LORE_DISABLE_VEC = "1";
    try {
      expect(isVecAvailable()).toBe(false);
      await assertCapped();
    } finally {
      delete process.env.LORE_DISABLE_VEC;
      close(); // re-enable vec for subsequent suites
    }
  });
});

// The vec fast-path and the JS brute-force fallback must produce identical
// results. We compute via vec (default), then force the fallback via the
// LORE_DISABLE_VEC kill-switch and assert the rankings match byte-for-byte.
describe("vec path vs JS fallback parity", () => {
  afterAll(() => {
    // Restore default state for any later work in this file.
    delete process.env.LORE_DISABLE_VEC;
    close();
  });

  test("identical top-k from vec and JS paths on the same data", async () => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge").run();
    // 40 deterministic pseudo-random normalized vectors in 8 dims.
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const dims = 8;
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      const v = unit(Array.from({ length: dims }, () => rand() * 2 - 1));
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, embedding, logical_id) VALUES (?, ?, 'test', ?, '', ?, ?, ?, ?)",
        )
        .run(`k-${i}`, pid, `E${i}`, now, now, toBlob(v), `k-${i}`);
    }
    const query = unit(Array.from({ length: dims }, () => rand() * 2 - 1));

    // Vec path (only meaningful when the extension is actually loaded).
    const skipVecLeg = !isVecAvailable();
    const vecHits = await vectorSearch(query, 10);

    // Force the JS fallback: kill-switch + fresh connection.
    close();
    process.env.LORE_DISABLE_VEC = "1";
    expect(isVecAvailable()).toBe(false);
    const jsHits = await vectorSearch(query, 10);

    // Restore vec for the rest of the suite.
    delete process.env.LORE_DISABLE_VEC;
    close();

    expect(jsHits.length).toBe(10);
    if (!skipVecLeg) {
      expect(vecHits.map((h) => h.id)).toEqual(jsHits.map((h) => h.id));
      for (let i = 0; i < vecHits.length; i++) {
        expect(vecHits[i].similarity).toBeCloseTo(jsHits[i].similarity, 5);
      }
    }
  });
});
