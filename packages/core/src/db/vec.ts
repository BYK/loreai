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
  if (process.env.LORE_DISABLE_VEC === "1") return; // kill-switch → JS fallback
  try {
    const path = resolveExtensionPath();
    if (!path) return;
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
    database.query("SELECT vec_version()").get();
    vecAvailable = true;
  } catch {
    vecAvailable = false;
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
