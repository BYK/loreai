import { createHash } from "node:crypto";
import { db, isCurrentDatabase, projectId, withSavepoint } from "./db";
import { currentTenantId } from "./tenant";
import { estimateTokens, TOKEN_ESTIMATE_CACHE_VERSION } from "./tokenize";

const VERSION = `${TOKEN_ESTIMATE_CACHE_VERSION}:hidden-input-v1`;
export const SEMANTIC_TOKEN_CACHE_MAX_ENTRIES = 8192;
export const SEMANTIC_TOKEN_CACHE_MAX_SESSIONS = 64;
const MAX_PAYLOAD = 1_000_000;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * Exact, disposable derived counts. This is NOT an ingestion frontier: saving
 * it cannot claim that a source message or response has been persisted.
 * Only hashes and integers survive the request. Current wire content always
 * remains authoritative; all bytes are checked, including encrypted data.
 */
export class SemanticTokenCache {
  readonly stats = {
    hits: 0,
    misses: 0,
    bpe_bytes: 0,
    bpe_ms: 0,
    unavailable: 0,
  };
  private readonly entries = new Map<string, number>();
  private readonly used = new Map<string, number>();
  private readonly tenant = currentTenantId();
  private pid?: string;
  private readonly connection: ReturnType<typeof db> | undefined;
  private revision?: { changes: number; data_version: number };

  constructor(
    private readonly scope: {
      projectPath: string;
      sessionID: string;
      noStore: boolean;
      retainUnused?: boolean;
    },
  ) {
    if (scope.noStore) return;
    try {
      this.connection = db();
      this.pid = projectId(scope.projectPath);
      if (!this.pid) return;
      this.revision = this.connection
        .query(
          "SELECT total_changes() AS changes, data_version FROM pragma_data_version",
        )
        .get() as { changes: number; data_version: number };
      const row = this.connection
        .query(
          "SELECT payload FROM semantic_token_cache WHERE project_id = ? AND session_id = ? AND length(payload) <= ?",
        )
        .get(this.pid, scope.sessionID, MAX_PAYLOAD) as {
        payload: string;
      } | null;
      if (!row) return;
      const decoded: unknown = JSON.parse(row.payload);
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 3 ||
        decoded[0] !== VERSION ||
        !Array.isArray(decoded[1]) ||
        decoded[1].length > SEMANTIC_TOKEN_CACHE_MAX_ENTRIES
      )
        return;
      const data: unknown[] = decoded[1];
      if (decoded[2] !== digest(JSON.stringify(data))) return;
      for (const entry of data) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry[0]) ||
          !Number.isSafeInteger(entry[1]) ||
          entry[1] < 0
        ) {
          this.entries.clear();
          return;
        }
        this.entries.set(entry[0], entry[1]);
      }
    } catch {
      // Cache damage or unavailable storage must never fail a foreground turn.
      this.entries.clear();
      this.stats.unavailable++;
    }
  }

  count(visibleJson: string, provenanceJson: string): number {
    // Length framing prevents (a, bc) colliding with (ab, c). Existing source
    // IDs intentionally omit some fields and are unsuitable for cache keys.
    const key = createHash("sha256")
      .update(`${visibleJson.length}:`)
      .update(visibleJson)
      .update(provenanceJson)
      .digest("hex");
    let value = this.used.get(key) ?? this.entries.get(key);
    if (value === undefined) {
      this.stats.misses++;
      this.stats.bpe_bytes +=
        Buffer.byteLength(visibleJson) + Buffer.byteLength(provenanceJson);
      const started = performance.now();
      value = Math.max(
        0,
        estimateTokens(provenanceJson) - estimateTokens(visibleJson),
      );
      this.stats.bpe_ms += performance.now() - started;
    } else this.stats.hits++;
    this.used.delete(key);
    this.used.set(key, value);
    if (this.used.size > SEMANTIC_TOKEN_CACHE_MAX_ENTRIES)
      this.used.delete(this.used.keys().next().value!);
    return value;
  }

  persist(): void {
    if (
      this.scope.noStore ||
      !this.connection ||
      !this.pid ||
      !this.revision ||
      !this.used.size
    )
      return;
    try {
      // Do not publish into a replacement connection/generation or owner.
      if (
        !isCurrentDatabase(this.connection) ||
        currentTenantId() !== this.tenant
      )
        return;
      const retained = this.scope.retainUnused
        ? new Map(this.entries)
        : new Map<string, number>();
      for (const [key, value] of this.used) {
        retained.delete(key);
        retained.set(key, value);
      }
      const data = [...retained].slice(-SEMANTIC_TOKEN_CACHE_MAX_ENTRIES);
      const payload = JSON.stringify([
        VERSION,
        data,
        digest(JSON.stringify(data)),
      ]);
      if (payload.length > MAX_PAYLOAD) return;
      const { timeout } = this.connection
        .query("PRAGMA busy_timeout")
        .get() as { timeout: number };
      this.connection.exec("PRAGMA busy_timeout = 0");
      try {
        withSavepoint("semantic_token_cache", () => {
          // The INSERT acquires the writer lock before checking local writes and
          // external commits. Even deletion followed by same-ID recreation makes
          // this request obsolete; dropping disposable counts is always safe.
          const result =
            this.connection!.query(`INSERT INTO semantic_token_cache (project_id, session_id, payload, updated_at)
          SELECT p.id, s.session_id, ?, ? FROM projects p, session_state s
          WHERE p.id = ? AND p.tenant_id = ? AND s.session_id = ?
            AND total_changes() = ? AND (SELECT data_version FROM pragma_data_version) = ?
          ON CONFLICT(project_id, session_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`).run(
              payload,
              Date.now(),
              this.pid!,
              this.tenant,
              this.scope.sessionID,
              this.revision!.changes,
              this.revision!.data_version,
            );
          if (!result.changes) return;
          // Globally bounded disposable cache. Eviction only incurs recomputation.
          this.connection!.query(`DELETE FROM semantic_token_cache WHERE rowid IN
          (SELECT rowid FROM semantic_token_cache ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(
            SEMANTIC_TOKEN_CACHE_MAX_SESSIONS,
          );
        });
      } finally {
        this.connection.exec(`PRAGMA busy_timeout = ${timeout}`);
      }
    } catch {
      this.stats.unavailable++;
    }
  }
}
