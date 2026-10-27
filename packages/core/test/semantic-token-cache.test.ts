import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Tokenizer } from "ai-tokenizer";
import {
  close,
  db,
  ensureProject,
  saveSessionTracking,
  MIGRATIONS,
  isCurrentDatabase,
  mergeProjectInternal,
} from "../src/db";
import { currentTenantId, withTenant } from "../src/tenant";
import { clearProject, deleteSession } from "../src/data";
import {
  SemanticTokenCache,
  SEMANTIC_TOKEN_CACHE_MAX_ENTRIES,
  SEMANTIC_TOKEN_CACHE_MAX_SESSIONS,
} from "../src/semantic-token-cache";
import * as tokenize from "../src/tokenize";
import * as log from "../src/log";
import { decodeTokenCounts } from "../src/token-count-codec";

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
  saveSessionTracking(s.sessionID, {
    projectPath: s.projectPath,
    projectPathProvisional: false,
  });
}
function fill(s = scope) {
  const cache = new SemanticTokenCache(s);
  cache.count(visible, provenance);
  cache.persist();
  return cache;
}
function payload() {
  const value = (
    db().query("SELECT payload FROM semantic_token_cache").get() as {
      payload: string | Uint8Array;
    }
  ).payload;
  if (typeof value === "string") return value;
  const version = `${tokenize.TOKEN_ESTIMATE_CACHE_VERSION}:hidden-input-v1`;
  const data = [
    ...decodeTokenCounts(
      value,
      version,
      SEMANTIC_TOKEN_CACHE_MAX_ENTRIES,
      1_000_000,
    )!,
  ];
  return JSON.stringify([
    version,
    data,
    createHash("sha256").update(JSON.stringify(data)).digest("hex"),
  ]);
}
beforeEach(() => {
  db().exec("DELETE FROM semantic_token_cache");
  parent();
});
afterEach(() => vi.restoreAllMocks());

describe("exact visible-content counts", () => {
  it.each([false, true])(
    "keeps expensive zero-overhead provenance when cheap visible counts overflow (retained=%s)",
    (retainUnused) => {
      // Equal token counts do not imply cheap work: comparing two large native
      // envelopes can cost thousands of BPE tokens while their difference is zero.
      const largeVisible = "large visible source ".repeat(1024);
      const largeProvenance = "large native source ".repeat(1024);
      const count = vi
        .spyOn(tokenize, "estimateTokens")
        .mockReturnValue(10_000);
      const first = new SemanticTokenCache({ ...scope, retainUnused });
      expect(first.count(largeVisible, largeProvenance)).toBe(0);
      for (let i = 0; i < SEMANTIC_TOKEN_CACHE_MAX_ENTRIES * 2 + 3; i++)
        first.countTokens(
          `small-${i}`.padEnd(256, "x"),
          "cl100k_base",
          () => 1,
        );
      first.persist();
      expect(JSON.parse(payload())[1]).toHaveLength(
        SEMANTIC_TOKEN_CACHE_MAX_ENTRIES,
      );

      count.mockClear();
      const retry = new SemanticTokenCache({ ...scope, retainUnused });
      expect(retry.count(largeVisible, largeProvenance)).toBe(0);
      expect(count).not.toHaveBeenCalled();
      expect(retry.stats.hits).toBe(1);
    },
  );

  it.each(["local", "external"])(
    "does not lazily read a recreated %s owner",
    (kind) => {
      const text = "same source bytes before and after recreation ".repeat(32);
      const first = new SemanticTokenCache(scope);
      first.runVisible(() => tokenize.estimateTokens(text));
      first.persist();
      const saved = db()
        .query(
          "SELECT project_id, payload FROM semantic_token_cache WHERE session_id = ?",
        )
        .get(scope.sessionID) as { project_id: string; payload: Uint8Array };
      const pending = new SemanticTokenCache(scope);
      if (kind === "local") {
        deleteSession(scope.projectPath, scope.sessionID);
        parent();
        const successor = new SemanticTokenCache(scope);
        successor.runVisible(() => tokenize.estimateTokens(text));
        successor.persist();
      } else {
        const external = new DatabaseSync(process.env.LORE_DB_PATH!);
        try {
          external.exec("PRAGMA foreign_keys = ON");
          external
            .prepare("DELETE FROM semantic_token_cache WHERE session_id = ?")
            .run(scope.sessionID);
          external
            .prepare("DELETE FROM session_state WHERE session_id = ?")
            .run(scope.sessionID);
          external
            .prepare(
              "INSERT INTO session_state (session_id, updated_at) VALUES (?, ?)",
            )
            .run(scope.sessionID, Date.now());
          external
            .prepare(
              "INSERT INTO session_state_owners (session_id, tenant_id) VALUES (?, ?)",
            )
            .run(scope.sessionID, currentTenantId());
          external
            .prepare(
              "INSERT INTO semantic_token_cache (project_id, session_id, payload, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run(saved.project_id, scope.sessionID, saved.payload, Date.now());
        } finally {
          external.close();
        }
      }
      const before = payload();
      const count = vi.spyOn(Tokenizer.prototype, "count");
      pending.runVisible(() => tokenize.estimateTokens(text));
      expect(count).toHaveBeenCalledTimes(1);
      expect(pending.visibleStats.hits).toBe(0);
      pending.persist();
      expect(payload()).toBe(before);
    },
  );

  it("avoids loading a durable payload or hashing cheap short text", () => {
    const populate = new SemanticTokenCache(scope);
    populate.runVisible(() =>
      tokenize.estimateTokens("long stored text ".repeat(100)),
    );
    populate.persist();
    const queries: string[] = [];
    const silent = { info() {}, warn() {}, error() {}, captureException() {} };
    log.registerSink({
      ...silent,
      withDbSpan(sql, fn) {
        queries.push(sql);
        return fn();
      },
    });
    try {
      const count = vi.spyOn(Tokenizer.prototype, "count");
      const cache = new SemanticTokenCache(scope);
      cache.runVisible(() => {
        tokenize.estimateTokens("cheap short text");
        tokenize.estimateTokens("cheap short text");
      });
      cache.persist();
      expect(count).toHaveBeenCalledTimes(2);
      expect(
        queries.some((sql) =>
          sql.includes("SELECT payload FROM semantic_token_cache"),
        ),
      ).toBe(false);
    } finally {
      log.registerSink(silent);
    }
  });

  it("does not rewrite an unchanged retained window on every turn", () => {
    const retained = { ...scope, retainUnused: true };
    const first = new SemanticTokenCache(retained);
    first.runVisible(() =>
      tokenize.estimateTokens("unchanged retained window".repeat(32)),
    );
    first.persist();
    const next = new SemanticTokenCache(retained);
    const before = db().query("SELECT total_changes() AS n").get();
    next.runVisible(() =>
      tokenize.estimateTokens("unchanged retained window".repeat(32)),
    );
    next.persist();
    expect(db().query("SELECT total_changes() AS n").get()).toEqual(before);
    next.runVisible(() =>
      tokenize.estimateTokens("newly appended text".repeat(32)),
    );
    next.persist();
    expect(db().query("SELECT total_changes() AS n").get()).not.toEqual(before);
  });

  it("keeps encoding-specific counts across reopen without retaining text", () => {
    const text = "Private visible text Merhaba 🇹🇷 漢字 <|endoftext|>".repeat(
      32,
    );
    const options = [{}, { modelID: "gpt-4o" }, { providerID: "anthropic" }];
    const expected = options.map((opts) => tokenize.estimateTokens(text, opts));
    const cache = new SemanticTokenCache(scope);
    expect(
      cache.runVisible(() =>
        options.map((opts) => tokenize.estimateTokens(text, opts)),
      ),
    ).toEqual(expected);
    expect(cache.visibleStats.misses).toBe(3);
    cache.persist();
    expect(payload()).not.toContain("Private visible text");
    close();
    const count = vi.spyOn(Tokenizer.prototype, "count");
    const next = new SemanticTokenCache(scope);
    expect(
      next.runVisible(() =>
        options.map((opts) => tokenize.estimateTokens(text, opts)),
      ),
    ).toEqual(expected);
    expect(count).not.toHaveBeenCalled();
    expect(next.visibleStats.hits).toBe(3);
  });

  it("keys the entire original string, including tails and lone surrogates", () => {
    const cache = new SemanticTokenCache(scope);
    const values = [
      "a".repeat(512) + "old",
      "a".repeat(512) + "new",
      "\ud800".repeat(256),
      "\ud801".repeat(256),
      "\ufffd".repeat(256),
    ];
    for (const [i, text] of values.entries()) {
      const compute = vi.fn(() => i + 1);
      expect(cache.countTokens(text, "cl100k_base", compute)).toBe(i + 1);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(cache.countTokens(text, "cl100k_base", compute)).toBe(i + 1);
      expect(compute).toHaveBeenCalledTimes(1);
    }
  });

  it("does not add counts across BPE boundaries or reuse tokenizer failures", () => {
    const cache = new SemanticTokenCache(scope);
    const strings = [
      "a".repeat(256),
      "b".repeat(256),
      "ab".repeat(256),
      "a".repeat(300),
    ];
    const expected = strings.map((text) => tokenize.estimateTokens(text));
    const count = vi.spyOn(Tokenizer.prototype, "count");
    cache.runVisible(() => {
      count.mockImplementationOnce(() => {
        throw new Error("private tokenizer failure");
      });
      expect(tokenize.estimateTokens(strings[3])).toBe(
        Math.ceil(strings[3].length / 3),
      );
      for (const [i, text] of strings.entries())
        expect(tokenize.estimateTokens(text)).toBe(expected[i]);
      expect(count).toHaveBeenCalledTimes(5);
      count.mockClear();
      for (const [i, text] of strings.entries())
        expect(tokenize.estimateTokens(text)).toBe(expected[i]);
      expect(count).not.toHaveBeenCalled();
    });
  });

  it("preserves provenance counts and visible zero counts in the same envelope", () => {
    const cache = new SemanticTokenCache(scope);
    const hidden = cache.count(visible, provenance);
    cache.countTokens("zero".repeat(128), "cl100k_base", () => 0);
    cache.persist();
    const next = new SemanticTokenCache(scope);
    const count = vi.spyOn(Tokenizer.prototype, "count");
    expect(next.count(visible, provenance)).toBe(hidden);
    expect(
      next.countTokens("zero".repeat(128), "cl100k_base", () => {
        throw new Error("cache miss");
      }),
    ).toBe(0);
    expect(count).not.toHaveBeenCalled();
  });

  it("scopes no-store reuse to one request and never retains durable content", () => {
    const before = db().query("SELECT total_changes() AS n").get();
    const count = vi.spyOn(Tokenizer.prototype, "count");
    for (let request = 0; request < 2; request++) {
      const cache = new SemanticTokenCache({ ...scope, noStore: true });
      cache.runVisible(() => {
        tokenize.estimateTokens("private no-store text".repeat(32));
        tokenize.estimateTokens("private no-store text".repeat(32));
      });
      cache.persist();
    }
    expect(count).toHaveBeenCalledTimes(2);
    expect(db().query("SELECT total_changes() AS n").get()).toEqual(before);
  });

  it("restores nested and asynchronous counting scopes without crossing tenants", async () => {
    const first = new SemanticTokenCache({ ...scope, noStore: true });
    const second = withTenant(
      "other-tenant",
      () => new SemanticTokenCache({ ...scope, noStore: true }),
    );
    const count = vi.spyOn(Tokenizer.prototype, "count");
    await Promise.all([
      first.runVisible(async () => {
        tokenize.estimateTokens("same source".repeat(32));
        await Promise.resolve();
        tokenize.estimateTokens("same source".repeat(32));
      }),
      withTenant("other-tenant", () =>
        second.runVisible(async () => {
          tokenize.estimateTokens("same source".repeat(32));
          await Promise.resolve();
          tokenize.estimateTokens("same source".repeat(32));
        }),
      ),
    ]);
    expect(count).toHaveBeenCalledTimes(2);
    withTenant("other-tenant", () =>
      first.runVisible(() => tokenize.estimateTokens("same source".repeat(32))),
    );
    expect(count).toHaveBeenCalledTimes(3);
    first.runVisible(() => {
      expect(() =>
        second.runVisible(() => {
          throw new Error("nested");
        }),
      ).toThrow("nested");
      tokenize.estimateTokens("same source".repeat(32));
    });
    expect(count).toHaveBeenCalledTimes(3);
    tokenize.estimateTokens("same source".repeat(32));
    expect(count).toHaveBeenCalledTimes(4);
  });

  it("bounds visible entries together with provenance and evicts safely", () => {
    const cache = new SemanticTokenCache(scope);
    const count = vi.spyOn(Tokenizer.prototype, "count").mockReturnValue(1);
    cache.runVisible(() => {
      for (let i = 0; i < SEMANTIC_TOKEN_CACHE_MAX_ENTRIES + 3; i++)
        tokenize.estimateTokens(`text-${i}`.repeat(64));
    });
    cache.persist();
    expect(JSON.parse(payload())[1]).toHaveLength(
      SEMANTIC_TOKEN_CACHE_MAX_ENTRIES,
    );
    const next = new SemanticTokenCache(scope);
    count.mockClear();
    next.runVisible(() => {
      tokenize.estimateTokens(
        `text-${SEMANTIC_TOKEN_CACHE_MAX_ENTRIES + 2}`.repeat(64),
      );
      expect(count).not.toHaveBeenCalled();
      tokenize.estimateTokens("text-0".repeat(64));
      expect(count).toHaveBeenCalledTimes(1);
    });
  });
});

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
    [
      JSON.stringify([
        { type: "opaque", raw: { data: "x".repeat(128) + "old tail" } },
      ]),
      provenance,
      JSON.stringify([
        { type: "opaque", raw: { data: "x".repeat(128) + "new tail" } },
      ]),
      provenance,
    ],
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
      // The globally keyed state belongs to the original tenant. Its presence
      // must not authorize another tenant's disposable cache publication.
      ensureProject(scope.projectPath);
      expect(() => saveSessionTracking(scope.sessionID, {})).toThrow(
        "session state ownership unavailable",
      );
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
    ).toBe(2);
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
          other
            .prepare(
              "INSERT INTO session_state_owners (session_id, tenant_id) VALUES (?, ?)",
            )
            .run(scope.sessionID, "");
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
