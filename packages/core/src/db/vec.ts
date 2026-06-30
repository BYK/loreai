// sqlite-vec native extension loader.
//
// Vector search has two interchangeable implementations:
//   1. Native sqlite-vec (this module) — `vec_distance_cosine()` runs the
//      similarity scan in C. Used when the extension loads successfully.
//   2. Pure-JS brute-force (embedding.ts) — the fallback when the extension
//      is unavailable: Bun on macOS (system SQLite blocks extensions unless
//      `Database.setCustomSQLite()`), Node < 23.5 (no `allowExtension`), a
//      missing platform binary, the `LORE_DISABLE_VEC` kill-switch, or any
//      load error. At Lore's row caps (~500) the JS path is sub-millisecond,
//      so results are identical — only the constant factor differs.
//
// For L2-normalized embeddings (which Lore always produces), the SQL form
// `1 - vec_distance_cosine(a, b)` equals the JS dot product to float32
// precision, so the two paths return the same ordering and the same scores.
//
// The loader is PATH-BASED (resolve a .so/.dylib/.dll path, then loadExtension)
// so the same code serves both the npm path (binary from the sqlite-vec
// package's platform optionalDependency, via `getLoadablePath()`) and the
// future SEA path (binary extracted from an embedded asset; the extractor sets
// `globalThis.__LORE_VEC_EXTENSION_PATH__` — see native-loader.cjs / #956).
//
// Never throws. A failure leaves availability `false` and callers fall back.

import type { Database } from "#db/driver";
import * as sqliteVec from "sqlite-vec";
import * as log from "../log";

let vecAvailable = false;
let attempted = false;

/** Resolve the native extension path: SEA-embedded first, then npm package. */
function resolveExtensionPath(): string | null {
  // Set by native-loader.cjs inside the SEA binary after extracting the
  // embedded vec0 extension to disk. Absent in npm/dev/test.
  const seaPath = (globalThis as { __LORE_VEC_EXTENSION_PATH__?: unknown })
    .__LORE_VEC_EXTENSION_PATH__;
  if (typeof seaPath === "string" && seaPath.length > 0) return seaPath;
  try {
    // `getLoadablePath()` reads the platform optionalDependency's binary path.
    // In the SEA bundle `sqlite-vec` is stubbed, so this returns undefined.
    const getPath = (sqliteVec as { getLoadablePath?: () => string })
      .getLoadablePath;
    return typeof getPath === "function" ? (getPath() ?? null) : null;
  } catch {
    return null;
  }
}

/** Scratch table name for the load-time vec0 KNN probe (temp schema, so it is
 *  private to the connection and never touches the on-disk DB). */
const SMOKE_TABLE = "temp.__lore_vec0_smoke";

/**
 * Prove the `vec0` KNN path actually works on THIS host — not merely that the
 * extension's scalar SQL functions registered.
 *
 * `vec_version()` only confirms the functions loaded; it does NOT exercise the
 * `vec0` virtual table or the `MATCH … AND k = ?` KNN operator, which can fail
 * independently (e.g. a binary that loads yet whose `vec0` module is broken on
 * a particular CPU / SQLite build). That distinction is now load-bearing: once
 * a DB has cut over to vec0-only storage the base `embedding` BLOB columns are
 * dropped, so there is no brute-force column left to fall back to — a `vec0`
 * that loads-but-doesn't-work would make every vector read throw at query time
 * with no recovery. Probe the real round-trip once at load: build a tiny temp
 * `vec0` table, insert one row, run a `k = 1` MATCH, and confirm the hit. Any
 * throw or miss ⇒ report unavailable so callers route to the JS fallback (which
 * still has BLOBs to scan, because a vec0-only DB never reaches this on an
 * incapable runtime). Never throws.
 *
 * 🔴 Requires a WRITABLE connection: the probe CREATEs a temp table and INSERTs
 * a row, so it throws "readonly database" on a `query_only` connection. Run it
 * only on the main writer connection (`loadVecExtension`). Reader connections
 * (db/reader.ts, `query_only = TRUE`) must NOT use it — their read-only
 * `MATCH … k = ?` works fine and the host-level capability is already proven by
 * the main loader.
 */
export function vec0KnnSmokeOk(database: Database): boolean {
  // Bind the probe vector as a Float32Array BLOB — byte-for-byte the same param
  // shape every production vec0 read/write uses (`toBlob()` in vector-query.ts /
  // vec-store.ts). Mirroring the real path means the probe proves exactly what
  // production relies on, identically under node:sqlite and bun:sqlite (a raw
  // Buffer binds as a BLOB on both; a JSON-text vector would exercise a
  // different, less-tested binding). `Buffer` is a runtime global — no import.
  const probe = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
  try {
    database.query(`DROP TABLE IF EXISTS ${SMOKE_TABLE}`).run();
    database
      .query(
        `CREATE VIRTUAL TABLE ${SMOKE_TABLE} USING vec0(` +
          "id TEXT PRIMARY KEY, embedding float[4] distance_metric=cosine)",
      )
      .run();
    database
      .query(`INSERT INTO ${SMOKE_TABLE}(id, embedding) VALUES ('probe', ?)`)
      .run(probe);
    const hit = database
      .query(`SELECT id FROM ${SMOKE_TABLE} WHERE embedding MATCH ? AND k = 1`)
      .get(probe) as { id?: string } | undefined;
    database.query(`DROP TABLE ${SMOKE_TABLE}`).run();
    return hit?.id === "probe";
  } catch {
    // Best-effort cleanup so a retry on the same connection starts clean.
    try {
      database.query(`DROP TABLE IF EXISTS ${SMOKE_TABLE}`).run();
    } catch {
      /* ignore — the connection is about to fall back to JS anyway */
    }
    return false;
  }
}

/**
 * Attempt to load sqlite-vec into the given connection. Runs once per process
 * (guarded by `attempted`); call `resetVecState()` when the connection closes
 * so the next connection re-loads. Never throws — any failure routes callers
 * to the JS brute-force fallback.
 */
export function loadVecExtension(database: Database): void {
  if (attempted) return;
  attempted = true;
  // LORE_DISABLE_VEC=1 forces the JS brute-force vector-search path. Useful as
  // a production kill-switch if the native extension causes issues, and as a
  // test seam for the JS fallback. Set before the first `db()` call — once
  // attempted=true is sticky for the connection lifetime, the env var won't be
  // re-read until resetVecState() runs (in close()).
  if (process.env.LORE_DISABLE_VEC === "1") {
    log.info(
      "sqlite-vec: disabled via LORE_DISABLE_VEC — using JS brute-force vector search",
    );
    return; // kill-switch → JS fallback
  }
  // Capture success details and emit the "enabled" line OUTSIDE the try block,
  // so a misbehaving log sink can never flip vecAvailable back to false after a
  // genuine load. The loader's contract (never throw, fall back on failure)
  // stays intact.
  let loadedPath: string | null = null;
  let version = "unknown";
  try {
    const path = resolveExtensionPath();
    if (!path) {
      log.warn(
        "sqlite-vec: no native binary for this platform/runtime — using JS brute-force vector search",
      );
      return;
    }
    // node:sqlite gates the loadExtension() C-API behind enableLoadExtension();
    // bun:sqlite has no such method (extensions enabled by default on Linux).
    const conn = database as unknown as {
      loadExtension: (p: string) => void;
      enableLoadExtension?: (on: boolean) => void;
    };
    conn.enableLoadExtension?.(true);
    conn.loadExtension(path);
    // Close the SQL-level load_extension() surface now that vec is registered;
    // the loaded functions stay available for the connection's lifetime.
    conn.enableLoadExtension?.(false);
    // Confirm registration before trusting the fast path.
    const row = database.query("SELECT vec_version() AS v").get() as
      | { v?: string }
      | undefined;
    version = row?.v ?? "unknown";
    // …and confirm the vec0 KNN path itself works, not just the scalar funcs —
    // a loads-but-broken vec0 has no blob fallback on a cut-over DB.
    if (!vec0KnnSmokeOk(database)) {
      log.warn(
        `sqlite-vec: extension loaded (${version}) but vec0 KNN smoke test failed — using JS brute-force vector search`,
      );
      return; // vecAvailable stays false → JS fallback
    }
    loadedPath = path;
    vecAvailable = true;
  } catch (e) {
    vecAvailable = false;
    log.warn(
      `sqlite-vec: native extension failed to load (${(e as Error).message}) — using JS brute-force vector search`,
    );
    return;
  }
  log.info(
    `sqlite-vec: native vector search enabled (${version}, ${loadedPath})`,
  );
}

/**
 * Load sqlite-vec into an ARBITRARY connection and report whether it took.
 *
 * Unlike {@link loadVecExtension} this is pure per-connection: it does NOT
 * touch the module-level `attempted`/`vecAvailable` singleton state and does
 * not log. Used by read-worker reader connections (vector-pool.ts), each of
 * which loads the extension independently on its own connection and tracks its
 * own availability. Never throws — a failure returns `false` and the caller
 * routes to the JS brute-force fallback.
 */
export function loadVecForConnection(database: Database): boolean {
  if (process.env.LORE_DISABLE_VEC === "1") return false;
  try {
    const path = resolveExtensionPath();
    if (!path) return false;
    const conn = database as unknown as {
      loadExtension: (p: string) => void;
      enableLoadExtension?: (on: boolean) => void;
    };
    conn.enableLoadExtension?.(true);
    conn.loadExtension(path);
    conn.enableLoadExtension?.(false);
    const row = database.query("SELECT vec_version() AS v").get() as
      | { v?: string }
      | undefined;
    // NOTE: deliberately NO vec0 KNN smoke here. Reader connections are opened
    // `query_only = TRUE` (see db/reader.ts), so the write-based smoke (it
    // CREATEs + INSERTs into a temp vec0 table) would throw "readonly database"
    // and falsely demote a perfectly-good read-only connection to JS fallback.
    // The vec0 KNN capability is a property of the host + extension binary, not
    // of an individual connection — it is proven once on the writable main
    // connection in `loadVecExtension`. A reader loads the SAME binary on the
    // SAME host, so a successful `vec_version()` is sufficient here; its actual
    // job (read-only `MATCH … k = ?`) works fine under `query_only`.
    return typeof row?.v === "string" && row.v.length > 0;
  } catch {
    return false;
  }
}

/** Whether sqlite-vec loaded successfully on the active connection. */
export function isVecAvailable(): boolean {
  return vecAvailable;
}

/** Reset loader state — call when the DB connection is closed/swapped. */
export function resetVecState(): void {
  vecAvailable = false;
  attempted = false;
}
