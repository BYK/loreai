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
import { unlinkSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { FixtureEntry } from "../../src/recorder";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  fixtures: FixtureEntry[];
  /** Override any config values */
  configOverrides?: Partial<{ port: number; debug: boolean }>;
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
  /** Clear in-memory pipeline/core state while preserving the temp DB/server. */
  restartPipeline(): Promise<void>;
  /** Stop the gateway and clean up */
  teardown(): void;
}

// ---------------------------------------------------------------------------
// createHarness
// ---------------------------------------------------------------------------

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  // --- 1. Isolated temp DB path ---
  const dbPath = `/tmp/lore-gateway-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

  // Set env vars BEFORE any gateway/core imports so db.ts picks up the right path
  process.env.LORE_DB_PATH = dbPath;

  // --- 2. Random port in [20000, 50000) ---
  const port =
    opts.configOverrides?.port ?? 20000 + Math.floor(Math.random() * 30000);

  process.env.LORE_LISTEN_PORT = String(port);

  // Suppress debug noise in tests unless explicitly enabled
  if (!process.env.LORE_DEBUG) {
    process.env.LORE_DEBUG = "false";
  }

  // --- 3. Dynamic imports so env vars take effect before module-level code runs ---
  const { makeReplayInterceptor } = await import("./replay");
  const { setUpstreamInterceptor, resetPipelineState } = await import(
    "../../src/pipeline"
  );
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
  const replay = makeReplayInterceptor(opts.fixtures);
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
        // biome-ignore lint/suspicious/noExplicitAny: node:sqlite stmt.all() accepts variadic args
        return stmt.all(...((params ?? []) as any)) as T[];
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
        "x-lore-project": process.cwd(),
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
    restartPipeline,
    teardown,
  };
}
