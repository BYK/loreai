import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { close, db, ensureProject } from "../src/db";
import { isVecAvailable } from "../src/db/vec";
import * as log from "../src/log";
import {
  toBlob,
  vectorSearch,
  vectorSearchAllDistillations,
  vectorSearchDistillations,
  vectorSearchTemporal,
} from "../src/embedding";

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
  test("vec branch is exercised when available (not silent fallback)", () => {
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
    const hits = vectorSearch(new Float32Array([1, 0, 0]), 1);
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

  test("excludes the named category on the vec path", () => {
    if (!isVecAvailable()) return; // JS leg below covers the fallback branch
    const pid = ensureProject(PROJECT);
    seedTwoCategories(pid);
    const ids = vectorSearch(new Float32Array([1, 0, 0]), 10, [
      "preference",
    ]).map((h) => h.id);
    expect(ids).toContain("k-keep");
    expect(ids).not.toContain("k-drop");
  });

  test("excludes the named category on the JS fallback path", () => {
    const pid = ensureProject(PROJECT);
    seedTwoCategories(pid);
    close();
    process.env.LORE_DISABLE_VEC = "1";
    try {
      expect(isVecAvailable()).toBe(false);
      const ids = vectorSearch(new Float32Array([1, 0, 0]), 10, [
        "preference",
      ]).map((h) => h.id);
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

  test("ranks by similarity and excludes archived", () => {
    const pid = ensureProject(PROJECT);
    insertDistillation("d-near", pid, unit([1, 0, 0]));
    insertDistillation("d-mid", pid, unit([0.6, 0.4, 0]));
    insertDistillation("d-far", pid, unit([0, 1, 0]));
    insertDistillation("d-archived", pid, unit([1, 0, 0]), { archived: 1 });

    const hits = vectorSearchDistillations(new Float32Array([1, 0, 0]), 10);
    const ids = hits.map((h) => h.id);
    expect(ids).toEqual(["d-near", "d-mid", "d-far"]);
    expect(ids).not.toContain("d-archived");
    expect(hits[0].similarity).toBeGreaterThan(hits[1].similarity);
    expect(hits[1].similarity).toBeGreaterThan(hits[2].similarity);
  });

  test("allDistillations includes archived and returns session_id", () => {
    const pid = ensureProject(PROJECT);
    insertDistillation("a-near", pid, unit([1, 0, 0]), {
      archived: 1,
      session: "sX",
    });
    insertDistillation("a-far", pid, unit([0, 1, 0]), { session: "sY" });

    const hits = vectorSearchAllDistillations(
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
  ): void {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, embedding) VALUES (?, ?, ?, 'user', 'msg', 0, 0, ?, ?)",
      )
      .run(id, pid, session, now, toBlob(vec));
  }

  test("ranks by similarity, scoped to project", () => {
    const pid = ensureProject(PROJECT);
    insertTemporal("t-near", pid, "s1", unit([1, 0, 0]));
    insertTemporal("t-far", pid, "s1", unit([0, 1, 0]));

    const hits = vectorSearchTemporal(new Float32Array([1, 0, 0]), pid, 10);
    expect(hits.map((h) => h.id)).toEqual(["t-near", "t-far"]);
  });

  test("optional session scoping", () => {
    const pid = ensureProject(PROJECT);
    insertTemporal("t-s1", pid, "s1", unit([1, 0, 0]));
    insertTemporal("t-s2", pid, "s2", unit([1, 0, 0]));

    const hits = vectorSearchTemporal(
      new Float32Array([1, 0, 0]),
      pid,
      10,
      "s1",
    );
    expect(hits.map((h) => h.id)).toEqual(["t-s1"]);
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

  test("identical top-k from vec and JS paths on the same data", () => {
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
    const vecHits = vectorSearch(query, 10);

    // Force the JS fallback: kill-switch + fresh connection.
    close();
    process.env.LORE_DISABLE_VEC = "1";
    expect(isVecAvailable()).toBe(false);
    const jsHits = vectorSearch(query, 10);

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
