import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  close,
  db,
  ensureProject,
  saveSessionTracking,
  MIGRATIONS,
  isCurrentDatabase,
  mergeProjectInternal,
} from "../src/db";
import { withTenant } from "../src/tenant";
import { clearProject, deleteSession } from "../src/data";
import {
  SemanticTokenCache,
  SEMANTIC_TOKEN_CACHE_MAX_ENTRIES,
  SEMANTIC_TOKEN_CACHE_MAX_SESSIONS,
} from "../src/semantic-token-cache";
import * as tokenize from "../src/tokenize";

const scope = {
  projectPath: "/test/token-cache",
  sessionID: "token-session",
  noStore: false,
};
const visible = '[{"type":"text","text":"public projection"}]';
const provenance =
  '[{"type":"opaque","raw":{"encrypted_content":"synthetic private reasoning AABCD123456789"}}]';
function parent(s = scope) {
  ensureProject(s.projectPath);
  saveSessionTracking(s.sessionID, {});
}
function fill(s = scope) {
  const cache = new SemanticTokenCache(s);
  cache.count(visible, provenance);
  cache.persist();
  return cache;
}
function payload() {
  return (
    db().query("SELECT payload FROM semantic_token_cache").get() as {
      payload: string;
    }
  ).payload;
}
beforeEach(() => {
  db().exec("DELETE FROM semantic_token_cache");
  parent();
});
afterEach(() => vi.restoreAllMocks());

describe("exact derived provenance counts", () => {
  it("pins the persistent algorithm key to the installed tokenizer", () => {
    const entry = createRequire(import.meta.url).resolve("ai-tokenizer");
    const pkg = JSON.parse(
      readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"),
    );
    expect(tokenize.TOKEN_ESTIMATE_CACHE_VERSION).toContain(
      `ai-tokenizer@${pkg.version}:cl100k_base:`,
    );
  });

  it("survives a database close/reopen without retaining source content", () => {
    const first = fill();
    const saved = payload();
    expect(saved).not.toContain("public projection");
    expect(saved).not.toContain("private reasoning");
    close();
    const count = vi.spyOn(tokenize, "estimateTokens");
    const next = new SemanticTokenCache(scope);
    expect(next.count(visible, provenance)).toBeGreaterThanOrEqual(0);
    expect(count).not.toHaveBeenCalled();
    expect(first.stats.misses).toBe(1);
    expect(next.stats.hits).toBe(1);
  });

  it.each([
    [visible, provenance, visible + " ", provenance],
    [visible, provenance, visible, provenance + " "],
    [
      '[{"type":"thinking","signature":"a"}]',
      provenance,
      '[{"type":"thinking","signature":"b"}]',
      provenance,
    ],
    [
      '[{"type":"tool_result","isError":false}]',
      provenance,
      '[{"type":"tool_result","isError":true}]',
      provenance,
    ],
    [
      visible,
      JSON.stringify([{ raw: { data: "x".repeat(128) + "old tail" } }]),
      visible,
      JSON.stringify([{ raw: { data: "x".repeat(128) + "new tail" } }]),
    ],
    [visible, provenance, visible, provenance.replace("AABCD", "ZZBCD")],
  ])("recomputes on every full-content difference (%#)", (oldV, oldP, v, p) => {
    const first = new SemanticTokenCache(scope);
    first.count(oldV, oldP);
    first.persist();
    const estimate = vi.spyOn(tokenize, "estimateTokens");
    const cache = new SemanticTokenCache(scope);
    const result = cache.count(v, p);
    expect(estimate).toHaveBeenCalledTimes(2);
    expect(result).toBe(
      Math.max(0, tokenize.estimateTokens(p) - tokenize.estimateTokens(v)),
    );
    expect(cache.stats.misses).toBe(1);
  });

  it("uses framed input pairs and retains exact zero counts", () => {
    const cache = new SemanticTokenCache(scope);
    const count = vi.spyOn(tokenize, "estimateTokens");
    expect(cache.count("abcd", "")).toBe(0);
    cache.count("ab", "cd");
    expect(cache.stats.misses).toBe(2);
    count.mockClear();
    expect(cache.count("abcd", "")).toBe(0);
    expect(count).not.toHaveBeenCalled();
  });

  it("isolates the same session and source bytes across tenants and projects", () => {
    fill();
    const other = { ...scope, projectPath: "/test/other-token-project" };
    parent(other);
    expect(fill(other).stats.misses).toBe(1);
    withTenant("other-tenant", () => {
      parent();
      expect(fill().stats.misses).toBe(1);
    });
    expect(
      new SemanticTokenCache(scope).count(visible, provenance),
    ).toBeGreaterThanOrEqual(0);
    expect(
      (
        db().query("SELECT COUNT(*) AS n FROM semantic_token_cache").get() as {
          n: number;
        }
      ).n,
    ).toBe(3);
  });

  it("never reads or writes a durable cache in no-store mode", () => {
    fill();
    const before = db().query("SELECT total_changes() AS n").get();
    const cache = fill({ ...scope, noStore: true });
    expect(cache.stats.misses).toBe(1);
    expect(db().query("SELECT total_changes() AS n").get()).toEqual(before);
  });

  it.each(["json", "checksum", "version", "entry", "oversize"])(
    "treats %s corruption as a miss",
    (kind) => {
      fill();
      const envelope = JSON.parse(payload());
      if (kind === "checksum") envelope[1][0][1] += 1;
      if (kind === "version") envelope[0] = "future-tokenizer";
      if (kind === "entry") {
        envelope[1][0][1] = -1;
        envelope[2] = createHash("sha256")
          .update(JSON.stringify(envelope[1]))
          .digest("hex");
      }
      if (kind === "oversize")
        envelope[1] = Array.from(
          { length: SEMANTIC_TOKEN_CACHE_MAX_ENTRIES + 1 },
          () => ["a", 0],
        );
      db()
        .query("UPDATE semantic_token_cache SET payload = ?")
        .run(kind === "json" ? "{" : JSON.stringify(envelope));
      expect(fill().stats.misses).toBe(1);
    },
  );

  it("bounds per-request and persisted entries, retaining recent inputs", () => {
    const count = vi.spyOn(tokenize, "estimateTokens").mockReturnValue(1);
    const cache = new SemanticTokenCache(scope);
    for (let i = 0; i < SEMANTIC_TOKEN_CACHE_MAX_ENTRIES + 3; i++)
      cache.count("", String(i));
    cache.persist();
    expect(JSON.parse(payload())[1]).toHaveLength(
      SEMANTIC_TOKEN_CACHE_MAX_ENTRIES,
    );
    const next = new SemanticTokenCache(scope);
    count.mockClear();
    next.count("", String(SEMANTIC_TOKEN_CACHE_MAX_ENTRIES + 2));
    expect(count).not.toHaveBeenCalled();
    next.count("", "0");
    expect(count).toHaveBeenCalledTimes(2);
  });

  it("bounds persisted session caches", () => {
    for (let i = 0; i < SEMANTIC_TOKEN_CACHE_MAX_SESSIONS + 2; i++) {
      const s = { ...scope, sessionID: `bounded-${i}` };
      parent(s);
      fill(s);
    }
    expect(
      db().query("SELECT COUNT(*) AS n FROM semantic_token_cache").get(),
    ).toEqual({ n: SEMANTIC_TOKEN_CACHE_MAX_SESSIONS });
  });

  it("does not resurrect deleted projects or sessions from a pending write", () => {
    const pending = new SemanticTokenCache(scope);
    pending.count(visible, provenance);
    deleteSession(scope.projectPath, scope.sessionID);
    pending.persist();
    expect(
      db().query("SELECT COUNT(*) AS n FROM semantic_token_cache").get(),
    ).toEqual({ n: 0 });
    expect(
      db()
        .query("SELECT session_id FROM session_state WHERE session_id = ?")
        .get(scope.sessionID),
    ).toBeNull();
  });

  it("does not reopen a closed database for a delayed write", () => {
    const connection = db();
    const pending = new SemanticTokenCache(scope);
    pending.count(visible, provenance);
    close();
    pending.persist();
    expect(isCurrentDatabase(connection)).toBe(false);
    expect(
      db().query("SELECT COUNT(*) AS n FROM semantic_token_cache").get(),
    ).toEqual({ n: 0 });
  });

  it("clears pre-response derived data and rejects an outstanding publication", () => {
    fill();
    const pending = new SemanticTokenCache(scope);
    pending.count(visible, provenance);
    expect(
      db().query("SELECT COUNT(*) AS n FROM temporal_messages").get(),
    ).toEqual({ n: 0 });
    clearProject(scope.projectPath);
    expect(
      db().query("SELECT COUNT(*) AS n FROM semantic_token_cache").get(),
    ).toEqual({ n: 0 });
    pending.persist();
    expect(
      db().query("SELECT COUNT(*) AS n FROM semantic_token_cache").get(),
    ).toEqual({ n: 0 });
  });

  it.each([false, true])(
    "rejects publication after session recreation (external=%s)",
    (external) => {
      const pending = new SemanticTokenCache(scope);
      pending.count(visible, provenance);
      if (external) {
        const other = new DatabaseSync(process.env.LORE_DB_PATH!);
        try {
          other.exec("BEGIN IMMEDIATE");
          other
            .prepare("DELETE FROM session_state WHERE session_id = ?")
            .run(scope.sessionID);
          other
            .prepare(
              "INSERT INTO session_state (session_id, updated_at) VALUES (?, ?)",
            )
            .run(scope.sessionID, Date.now());
          other.exec("COMMIT");
        } finally {
          other.close();
        }
      } else {
        deleteSession(scope.projectPath, scope.sessionID);
        parent();
      }
      pending.persist();
      expect(
        db().query("SELECT COUNT(*) AS n FROM semantic_token_cache").get(),
      ).toEqual({ n: 0 });
    },
  );

  it("skips a competing writer promptly and restores the caller's busy timeout", () => {
    fill();
    const before = payload();
    const pending = new SemanticTokenCache(scope);
    pending.count(visible, provenance + " ");
    const other = new DatabaseSync(process.env.LORE_DB_PATH!);
    db().exec("PRAGMA busy_timeout = 1375");
    try {
      other.exec("BEGIN IMMEDIATE");
      const started = performance.now();
      pending.persist();
      expect(performance.now() - started).toBeLessThan(500);
      expect(db().query("PRAGMA busy_timeout").get()).toEqual({
        timeout: 1375,
      });
      expect(pending.stats.unavailable).toBe(1);
      expect(payload()).toBe(before);
    } finally {
      other.exec("ROLLBACK");
      other.close();
      db().exec("PRAGMA busy_timeout = 5000");
    }
  });

  it("rolls back derived-cache publication with the caller's transaction", () => {
    db().exec("SAVEPOINT test_cache_rollback");
    fill();
    db().exec("ROLLBACK TO test_cache_rollback; RELEASE test_cache_rollback");
    expect(fill().stats.misses).toBe(1);
  });

  it("does not reuse a merged project's derived cache under another owner", () => {
    const source = ensureProject(scope.projectPath);
    const target = ensureProject("/test/merged-token-project");
    fill();
    mergeProjectInternal(source, target);
    expect(
      db()
        .query(
          "SELECT project_id FROM semantic_token_cache WHERE project_id = ?",
        )
        .get(source),
    ).toBeNull();
  });

  it("migrates v85 and repairs a missing derived table without touching source data", () => {
    db().exec(
      "DROP TABLE semantic_token_cache; UPDATE schema_version SET version = 85",
    );
    close();
    expect(db().query("SELECT version FROM schema_version").get()).toEqual({
      version: MIGRATIONS.length,
    });
    fill();
    db().exec("DROP TABLE semantic_token_cache");
    close();
    expect(
      db().query("SELECT COUNT(*) AS n FROM semantic_token_cache").get(),
    ).toEqual({ n: 0 });
  });
});
