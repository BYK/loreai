/**
 * Test harness for the Lore gateway replay integration tests.
 *
 * Creates an isolated gateway instance on a random port with its own
 * temporary DB, wires in a replay interceptor from a fixture array, and
 * provides helper methods for sending requests and asserting DB state.
 *
 * Usage:
 *   const harness = await createHarness({ fixtures });
 *   const resp = await harness.chat(body);
 *   harness.teardown();
 */
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { FixtureEntry } from "../../src/recorder";
import type { SimulatedCacheTurn } from "./simulated-cache";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  fixtures: FixtureEntry[];
  /** Override any config values */
  configOverrides?: Partial<{ port: number; debug: boolean }>;
  /**
   * Compute realistic prompt-cache usage (cache_read / cache_creation) from the
   * actual upstream body prefix-stability and inject it into each replayed
   * response — so the gateway's own cache oracles (categorizeBust,
   * recordCacheUsage, calibrate) see production-faithful numbers instead of the
   * static zero-cache usage that replay fixtures otherwise report. Required for
   * any test that asserts on cache busts. Drive NON-streaming turns when using
   * this (the simulated cache only re-stamps JSON responses). Read the per-turn
   * trace via `harness.cacheTurns()`.
   */
  simulateCache?: boolean;
  /**
   * Optional budget config written into a project `.lore.json` so a session can
   * reach a target compression layer deterministically (e.g.
   * `{ maxLayer0Tokens: 40000 }` to force layer-1 compression). Written into
   * `projectPath` (defaults to the harness project dir); the pipeline calls
   * config.load(projectPath) per request, so it is honored.
   */
  budget?: { maxLayer0Tokens?: number };
  /** Project path to bind requests to (and where `budget` .lore.json is written). */
  projectPath?: string;
}

export interface Harness {
  /** Base URL of the gateway (http://127.0.0.1:<port>) */
  baseURL: string;
  /** Path to the isolated temp DB */
  dbPath: string;
  /** Send a POST /v1/messages request, return the raw Response */
  chat(
    requestBody: unknown,
    apiKey?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response>;
  /** Query the temporal DB directly via a read-only SQLite connection */
  queryDB<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  /**
   * The exact request bodies lore sent UPSTREAM (to the model), one per turn,
   * in order. This is the post-transform body (system blocks, LTM, cch,
   * gradient window) — i.e. exactly what Anthropic would see and key its prompt
   * cache on. Use this to assert cache-prefix stability across turns.
   */
  upstreamBodies(): string[];
  /**
   * Per-turn simulated cache observations (only populated when the harness was
   * created with `simulateCache: true`). Each entry reports the prefix-match and
   * the cache_read / cache_creation tokens that were injected into that turn's
   * response — the same numbers the gateway's bust oracles consumed.
   */
  cacheTurns(): SimulatedCacheTurn[];
  /** Clear in-memory pipeline/core state while preserving the temp DB/server. */
  restartPipeline(): Promise<void>;
  /** Stop the gateway and clean up */
  teardown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// createHarness
// ---------------------------------------------------------------------------

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  // --- 1. Isolated temp DB path ---
  const dbPath = `/tmp/lore-gateway-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

  // Set env vars BEFORE any gateway/core imports so db.ts picks up the right path
  process.env.LORE_DB_PATH = dbPath;

  // --- 2. Port 0 = OS-assigned ephemeral port ---
  // Binding to 0 lets the OS hand out a guaranteed-free port; startServer
  // resolves the actual bound port and exposes it as server.port (used for
  // baseURL below). This avoids the EADDRINUSE flakes that a random port in a
  // fixed range produced when two harnesses drew the same number or a just-
  // stopped server hadn't released its port yet. See issue #931.
  const port = opts.configOverrides?.port ?? 0;

  process.env.LORE_LISTEN_PORT = String(port);

  // Suppress debug noise in tests unless explicitly enabled
  if (!process.env.LORE_DEBUG) {
    process.env.LORE_DEBUG = "false";
  }

  // --- 3. Dynamic imports so env vars take effect before module-level code runs ---
  const { makeReplayInterceptor } = await import("./replay");
  const { withSimulatedCache } = await import("./simulated-cache");
  const { setUpstreamInterceptor, resetPipelineState } =
    await import("../../src/pipeline");
  const { startServer } = await import("../../src/server");
  const { loadConfig } = await import("../../src/config");
  // Import close() so we can reset the DB singleton between harnesses.
  // This allows each harness to open a fresh DB at its own LORE_DB_PATH.
  const { close: closeDB } = await import("@loreai/core");

  // Reset any leftover singleton state from a previous harness in this process.
  // Must close the DB BEFORE resetting pipeline state (which may use the DB).
  closeDB();
  await resetPipelineState();

  // --- 4. Wire in replay interceptor (streaming-aware: emits SSE for
  // streaming turns, JSON otherwise), wrapped to capture the exact upstream
  // request body lore sends each turn (for cache-stability assertions). ---
  const capturedBodies: string[] = [];
  const baseReplay = makeReplayInterceptor(opts.fixtures);
  // Optionally wrap the replay so each response carries cache usage computed
  // from real prompt-prefix stability — see simulated-cache.ts for why this is
  // required for any test that asserts on cache busts.
  const { interceptor: replay, turns: simCacheTurns } = opts.simulateCache
    ? withSimulatedCache(baseReplay)
    : { interceptor: baseReplay, turns: [] as SimulatedCacheTurn[] };
  function installReplayInterceptor() {
    setUpstreamInterceptor(
      async (requestBody, model, wasStreaming, makeReal) => {
        capturedBodies.push(
          typeof requestBody === "string"
            ? requestBody
            : JSON.stringify(requestBody),
        );
        return replay(requestBody, model, wasStreaming, makeReal);
      },
    );
  }
  installReplayInterceptor();

  // --- 4b. Optional per-project budget config (written before server start so
  // the first request's config.load(projectPath) picks it up). ---
  const projectPath = opts.projectPath ?? process.cwd();
  if (opts.budget) {
    try {
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(
        `${projectPath}/.lore.json`,
        JSON.stringify({ budget: opts.budget }),
      );
    } catch {
      // best-effort; tests that need this will fail loudly on the layer assertion
    }
  }

  // --- 5. Start gateway ---
  const config = loadConfig();
  const server = await startServer(config);

  const baseURL = `http://127.0.0.1:${server.port}`;

  // --- 6. Read-only DB handle for assertions (separate connection, no shared state) ---
  function queryDB<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): T[] {
    // Open a fresh read-only connection every query — avoids locking races
    // and ensures we always see the latest committed state.
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const stmt = db.prepare(sql);
        return stmt.all(...((params ?? []) as SQLInputValue[])) as T[];
      } finally {
        db.close();
      }
    } catch {
      // DB may not exist yet (before first request completes) — return empty
      return [];
    }
  }

  // --- 7. chat() helper ---
  async function chat(
    requestBody: unknown,
    apiKey = "test-key",
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Provide a confident project binding by default so the synthetic
        // project-resolution probe is never triggered in harness-based tests.
        // Tests that intentionally test path-less sessions can override this
        // via extraHeaders (set to empty string to suppress).
        "x-lore-project": projectPath,
        ...extraHeaders,
      },
      body: JSON.stringify(requestBody),
    });
  }

  // --- 8. teardown() ---
  async function teardown(): Promise<void> {
    server.stop();
    // Close the core DB singleton first so the next harness can open a fresh
    // DB at its own LORE_DB_PATH.
    closeDB();
    await resetPipelineState();
    setUpstreamInterceptor(undefined);

    // Delete DB files (main + WAL + SHM)
    for (const suffix of ["", "-shm", "-wal"]) {
      const file = `${dbPath}${suffix}`;
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // best-effort
      }
    }
  }

  function upstreamBodies(): string[] {
    return capturedBodies.slice();
  }

  function cacheTurns(): SimulatedCacheTurn[] {
    return simCacheTurns.slice();
  }

  async function restartPipeline(): Promise<void> {
    closeDB();
    await resetPipelineState({ fast: true });
    installReplayInterceptor();
  }

  return {
    baseURL,
    dbPath,
    chat,
    queryDB,
    upstreamBodies,
    cacheTurns,
    restartPipeline,
    teardown,
  };
}
