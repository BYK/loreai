/** Integration coverage for UI-08 warming and cost-management routes. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { loopbackRequest } from "./helpers/loopback-request";
import type { SessionState } from "../src/translate/types";

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let closeDB: () => void;
let resetPipelineState: () => Promise<void>;
let envWarming: string | undefined;
let envBudget: string | undefined;

beforeAll(async () => {
  envWarming = process.env.LORE_WARMING_ENABLED;
  envBudget = process.env.LORE_DAILY_BUDGET;
  delete process.env.LORE_WARMING_ENABLED;
  delete process.env.LORE_DAILY_BUDGET;
  dbPath = `/tmp/lore-operations-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  process.env.LORE_DB_PATH = dbPath;
  process.env.LORE_LISTEN_PORT = "0";
  process.env.LORE_DEBUG = "false";

  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  const { resetPipelineState: reset } = await import("../src/pipeline");
  const { close } = await import("@loreai/core");
  const { clearAllCosts } = await import("../src/cost-tracker");

  closeDB = close;
  resetPipelineState = reset;
  closeDB();
  clearAllCosts();
  await resetPipelineState();
  server = await startServer({
    ...loadConfig(),
    port: 0,
    debug: false,
    remoteGateway: false,
    hostedMode: false,
    allowRemoteManagement: false,
  });
  baseURL = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.stop();
  if (closeDB) closeDB();
  if (resetPipelineState) await resetPipelineState();
  if (envWarming === undefined) delete process.env.LORE_WARMING_ENABLED;
  else process.env.LORE_WARMING_ENABLED = envWarming;
  if (envBudget === undefined) delete process.env.LORE_DAILY_BUDGET;
  else process.env.LORE_DAILY_BUDGET = envBudget;
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = `${dbPath}${suffix}`;
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* best-effort */
    }
  }
});

function api(path: string, init?: Parameters<typeof loopbackRequest>[1]) {
  return loopbackRequest(`${baseURL}${path}`, init);
}

async function body<T>(
  path: string,
  init?: Parameters<typeof loopbackRequest>[1],
) {
  const response = await api(path, init);
  return (await response.json()) as T;
}

describe("GET /api/v1/warming", () => {
  it("returns the current global state, empty live rows and project histograms", async () => {
    const response = await api("/api/v1/warming");
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      enabled: boolean;
      can_edit: boolean;
      can_toggle: boolean;
      summary: { live_sessions: number; tripped_buckets: number };
      circuit_breaker: { entries: unknown[] };
      sessions: unknown[];
      histograms: unknown[];
    };
    expect(data.can_edit).toBe(true);
    expect(data.can_toggle).toBe(true);
    expect(data.summary.live_sessions).toBe(0);
    expect(data.circuit_breaker.entries).toEqual([]);
    expect(data.sessions).toEqual([]);
    expect(data.histograms).toEqual([]);
  });

  it("honors the environment override and refuses a misleading runtime toggle", async () => {
    process.env.LORE_WARMING_ENABLED = "0";
    const snapshot = await body<{
      enabled: boolean;
      env_forced: boolean;
      can_toggle: boolean;
    }>("/api/v1/warming");
    expect(snapshot).toMatchObject({
      enabled: false,
      env_forced: true,
      can_toggle: false,
    });

    const response = await api("/api/v1/warming/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(409);
    expect(
      ((await response.json()) as { error: { type: string } }).error.type,
    ).toBe("conflict");
    delete process.env.LORE_WARMING_ENABLED;
  });

  it("returns persisted project histograms after restart without live sessions", async () => {
    const core = await import("@loreai/core");
    const warmer = await import("../src/cache-warmer");
    const previousBreaker = core.getKV("warmup_circuit_breaker");
    const path = `/tmp/operations-histogram-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const projectId = core.ensureProject(path, "Retained History Project");
    const counts = Array(warmer.HISTOGRAM_BINS.length + 1).fill(0);
    counts[0] = 2;
    counts[counts.length - 1] = 3;
    core
      .db()
      .query(
        `INSERT INTO warmup_histograms (project_id, time_slot, counts, total, updated_at)
         VALUES (?, 'all', ?, ?, ?)`,
      )
      .run(projectId, JSON.stringify(counts), 5, Date.now());
    // Simulate a fresh gateway process: its in-memory histogram cache is empty.
    warmer._resetForTest();

    try {
      const snapshot = await body<{
        sessions: unknown[];
        histograms: Array<{
          project_id: string;
          project_name: string | null;
          total: number;
          counts: number[];
        }>;
      }>("/api/v1/warming");
      expect(snapshot.sessions).toEqual([]);
      expect(snapshot.histograms).toContainEqual(
        expect.objectContaining({
          project_id: projectId,
          project_name: "Retained History Project",
          total: 5,
          counts,
        }),
      );
    } finally {
      core
        .db()
        .query("DELETE FROM warmup_histograms WHERE project_id = ?")
        .run(projectId);
      core.data.deleteProject(projectId);
      warmer._resetForTest();
      if (previousBreaker === null) {
        core
          .db()
          .query("DELETE FROM kv_meta WHERE key = ?")
          .run("warmup_circuit_breaker");
      } else {
        core.setKV("warmup_circuit_breaker", previousBreaker);
      }
    }
  });

  it("distinguishes tripped routes while hiding upstream URL paths and credentials", async () => {
    const core = await import("@loreai/core");
    const warmer = await import("../src/cache-warmer");
    const key = "warmup_circuit_breaker";
    const previousBreaker = core.getKV(key);
    const trippedAt = Date.now();
    const session = "same-session";
    const model = "claude-sonnet-4-20250514";
    core.setKV(
      key,
      JSON.stringify({
        version: 2,
        buckets: {
          [`${session}\x1f${model}\x1fhttps://api.example.test/tenant-alpha/v1/messages?token=secret`]:
            {
              trippedAt,
            },
          [`${session}\x1f${model}\x1fhttps://api.example.test/tenant-beta/v1/messages?token=secret`]:
            {
              trippedAt,
            },
        },
      }),
    );
    warmer._forceReloadForTest();

    try {
      const snapshot = await body<{
        circuit_breaker: {
          entries: Array<{
            session_id: string;
            model: string;
            upstream: string;
          }>;
        };
      }>("/api/v1/warming");
      const entries = snapshot.circuit_breaker.entries.filter(
        (entry) => entry.session_id === session,
      );
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((entry) => entry.upstream)).size).toBe(2);
      expect(entries[0]?.upstream).toContain("https://api.example.test");
      expect(JSON.stringify(entries)).not.toContain("tenant-alpha");
      expect(JSON.stringify(entries)).not.toContain("tenant-beta");
      expect(JSON.stringify(entries)).not.toContain("secret");
    } finally {
      if (previousBreaker === null)
        core.db().query("DELETE FROM kv_meta WHERE key = ?").run(key);
      else core.setKV(key, previousBreaker);
      warmer._forceReloadForTest();
    }
  });
});

describe("read-only operations snapshots", () => {
  it("keeps live session, core strategy and breaker KV unchanged across both GET routes", async () => {
    const [pipeline, warmer, core] = await Promise.all([
      import("../src/pipeline"),
      import("../src/cache-warmer"),
      import("@loreai/core"),
    ]);
    const sessionId = `operations-read-only-${Date.now()}`;
    const survivalModel = warmer.createHistogram();
    for (let i = 0; i < 100; i++) warmer.recordGap(survivalModel, 5_000);
    const state = {
      sessionID: sessionId,
      projectPath: "/tmp/operations-read-only-project",
      fingerprint: "operations-read-only",
      lastRequestTime: Date.now() - 275_000,
      lastUserTurnTime: Date.now() - 275_000,
      messageCount: 20,
      turnsSinceCuration: 2,
      consecutiveTextOnlyTurns: 0,
      recallStore: new Map(),
      survivalModel,
      cacheAnalytics: {
        lastRequestBody: new Uint8Array([1]),
        lastRequestBodyLength: 1,
        lastCacheRead: 0,
        lastCacheCreation: 0,
        turnCount: 0,
        bustCount: 0,
      },
      lastUpstream: {
        url: "https://api.anthropic.com",
        protocol: "anthropic" as const,
        model: "claude-sonnet-4-20250514",
        headers: {},
      },
      upstreamByProvider: new Map(),
      resolvedConversationTTL: "5m" as const,
      lastInputTokens: 100_000,
    } as unknown as SessionState;
    const active = pipeline.getActiveSessions() as unknown as Map<
      string,
      SessionState
    >;
    const breakerKey = "warmup_circuit_breaker";
    const previousBreaker = core.getKV(breakerKey);
    const legacyBreaker = JSON.stringify({ tripped: true, failures: 3 });

    try {
      warmer._resetForTest();
      core.setKV(breakerKey, legacyBreaker);
      warmer._forceReloadForTest();
      core.setCacheSizeSnapshot(sessionId, 580_000, 190_000);
      expect(core.getCacheStrategy(sessionId)).toBeNull();
      active.set(sessionId, state);
      const before = structuredClone(state);

      for (const path of ["/api/v1/warming", "/api/v1/costs"]) {
        const response = await api(path);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        expect(state).toEqual(before);
        expect(core.getCacheStrategy(sessionId)).toBeNull();
        expect(core.getKV(breakerKey)).toBe(legacyBreaker);
      }
    } finally {
      active.delete(sessionId);
      core.evictSession(sessionId);
      if (previousBreaker === null)
        core.db().query("DELETE FROM kv_meta WHERE key = ?").run(breakerKey);
      else core.setKV(breakerKey, previousBreaker);
      warmer._forceReloadForTest();
    }
  });
});

describe("cost snapshots for resumed sessions", () => {
  it("hydrates persisted cost before the session leaves historical totals", async () => {
    const core = await import("@loreai/core");
    const tracker = await import("../src/cost-tracker");
    const sessionId = `operations-resumed-cost-${Date.now()}`;
    const projectId = core.ensureProject(
      `/tmp/operations-resumed-cost-${Date.now()}`,
      "Resumed Cost Project",
    );
    const createdAt = Date.now();
    core
      .db()
      .query(
        `INSERT INTO temporal_messages
           (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
         VALUES (?, ?, ?, 'user', 'resumed cost test', 10, 0, ?, NULL)`,
      )
      .run(
        `operations-resumed-msg-${sessionId}`,
        projectId,
        sessionId,
        createdAt,
      );
    core.saveSessionCosts(sessionId, {
      conversationCost: 2,
      workerCost: 0,
      conversationTurns: 1,
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupSavings: 0,
      warmupCost: 0,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
      workerBreakdown: {
        distillation: { cost: 0, calls: 0 },
        curation: { cost: 0, calls: 0 },
        compaction: { cost: 0, calls: 0 },
        recall: { cost: 0, calls: 0 },
        warmup: { cost: 0, calls: 0 },
      },
    });
    tracker.deleteSessionCosts(sessionId);
    tracker.invalidateHistoricalCache();

    try {
      const before = await body<{
        totals: { combined_session_count: number; spend: number };
        historical: {
          session_count: number;
          persisted_conversation_cost: number;
        };
      }>("/api/v1/costs");
      expect(before.historical).toMatchObject({
        session_count: 1,
        persisted_conversation_cost: 2,
      });

      const model = "claude-sonnet-4-20250514";
      const usage = { input_tokens: 100_000, output_tokens: 30 };
      const increment = tracker.computeCallCost(
        model,
        usage,
        "conversation",
      ).total;
      tracker.recordConversationCost(sessionId, model, usage);

      const after = await body<{
        live: { session_count: number; conversation_spend: number };
        totals: { combined_session_count: number; spend: number };
        historical: {
          session_count: number;
          persisted_conversation_cost: number;
        };
      }>("/api/v1/costs");
      expect(after.live.session_count).toBe(1);
      expect(after.live.conversation_spend).toBeCloseTo(2 + increment);
      expect(after.historical).toMatchObject({
        session_count: 0,
        persisted_conversation_cost: 0,
      });
      expect(after.totals.combined_session_count).toBe(1);
      expect(after.totals.spend).toBeCloseTo(before.totals.spend + increment);
    } finally {
      tracker.deleteSessionCosts(sessionId);
      tracker.invalidateHistoricalCache();
      core
        .db()
        .query("DELETE FROM session_state WHERE session_id = ?")
        .run(sessionId);
      core
        .db()
        .query("DELETE FROM temporal_messages WHERE session_id = ?")
        .run(sessionId);
      core.data.deleteProject(projectId);
    }
  });
});

describe("operations rows for project path aliases", () => {
  it("resolves a live session to the canonical project and keeps its links", async () => {
    const [core, pipeline, tracker] = await Promise.all([
      import("@loreai/core"),
      import("../src/pipeline"),
      import("../src/cost-tracker"),
    ]);
    const sessionId = `operations-alias-${Date.now()}`;
    const canonicalPath = `/tmp/operations-alias-canonical-${Date.now()}`;
    const aliasPath = `${canonicalPath}-worktree`;
    const projectId = core.ensureProject(canonicalPath, "Canonical Project");
    core
      .db()
      .query(
        "INSERT INTO project_path_aliases (path, project_id) VALUES (?, ?)",
      )
      .run(aliasPath, projectId);
    const active = pipeline.getActiveSessions() as unknown as Map<
      string,
      SessionState
    >;
    const state = {
      sessionID: sessionId,
      projectPath: aliasPath,
      fingerprint: "operations-alias",
      lastRequestTime: Date.now(),
      lastUserTurnTime: Date.now(),
      messageCount: 2,
      turnsSinceCuration: 1,
      consecutiveTextOnlyTurns: 0,
      recallStore: new Map(),
      survivalModel: (await import("../src/cache-warmer")).createHistogram(),
      cacheAnalytics: {
        lastRequestBody: new Uint8Array([1]),
        lastRequestBodyLength: 1,
        lastCacheRead: 0,
        lastCacheCreation: 0,
        turnCount: 0,
        bustCount: 0,
      },
      lastUpstream: {
        url: "https://api.anthropic.com",
        protocol: "anthropic" as const,
        model: "claude-sonnet-4-20250514",
        headers: {},
      },
      upstreamByProvider: new Map(),
      resolvedConversationTTL: "5m" as const,
      lastInputTokens: 100,
    } as unknown as SessionState;

    try {
      active.set(sessionId, state);
      tracker.recordConversationCost(sessionId, "test-model", {
        input_tokens: 100,
        output_tokens: 10,
      });
      const snapshot = await body<{
        sessions: Array<{
          session_id: string;
          project_id: string | null;
          project_name: string | null;
          project_path: string | null;
        }>;
      }>("/api/v1/costs");
      expect(snapshot.sessions).toContainEqual(
        expect.objectContaining({
          session_id: sessionId,
          project_id: projectId,
          project_name: "Canonical Project",
          project_path: aliasPath,
        }),
      );
    } finally {
      active.delete(sessionId);
      tracker.deleteSessionCosts(sessionId);
      core
        .db()
        .query("DELETE FROM project_path_aliases WHERE path = ?")
        .run(aliasPath);
      core.data.deleteProject(projectId);
    }
  });
});

describe("warming mutations", () => {
  it("persists the global toggle and resets all circuit-breaker buckets", async () => {
    const { db, getKV } = await import("@loreai/core");
    const previous = getKV("warming_enabled");
    try {
      const changed = await body<{
        enabled: boolean;
        override: boolean | null;
      }>("/api/v1/warming/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(changed).toEqual({ enabled: false, override: false });

      const { setKV } = await import("@loreai/core");
      setKV(
        "warmup_circuit_breaker",
        JSON.stringify({ version: 2, buckets: {} }),
      );
      const reset = await body<{ reset: boolean; tripped_count: number }>(
        "/api/v1/warming/circuit-breaker/reset",
        { method: "POST" },
      );
      expect(reset).toEqual({ reset: true, tripped_count: 0 });
    } finally {
      if (previous === null)
        db().query("DELETE FROM kv_meta WHERE key = ?").run("warming_enabled");
      else (await import("@loreai/core")).setKV("warming_enabled", previous);
    }
  });

  it("validates per-session modes and changes keep/stop/auto on a live session", async () => {
    const { getActiveSessions } = await import("../src/pipeline");
    type WarmupTestSession = {
      sessionID: string;
      warmup?: {
        lastWarmupAt: number;
        warmupCount: number;
        totalWarmups: number;
        warmupHits: number;
        disabled: boolean;
        userStopped?: boolean;
        forceKeepWarm?: boolean;
      };
      _dirty?: boolean;
    };
    const active = getActiveSessions() as unknown as Map<
      string,
      WarmupTestSession
    >;
    const state: WarmupTestSession = { sessionID: "active-session" };
    active.set("active-session", state);
    try {
      const invalid = await api(
        "/api/v1/warming/sessions/active-session/mode",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "sometimes" }),
        },
      );
      expect(invalid.status).toBe(400);

      for (const [mode, disabled, forceKeep] of [
        ["keep", false, true],
        ["stop", true, false],
        ["auto", false, false],
      ] as const) {
        const result = await body<{
          session_id: string;
          mode: string;
          disabled: boolean;
          force_keep_warm: boolean;
        }>("/api/v1/warming/sessions/active-session/mode", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        expect(result).toEqual({
          session_id: "active-session",
          mode,
          disabled,
          force_keep_warm: forceKeep,
        });
        expect(state._dirty).toBe(true);
        expect(state.warmup?.userStopped).toBe(mode === "stop");
      }
    } finally {
      active.delete("active-session");
    }
  });

  it("rejects all mutations in hosted mode before changing state", async () => {
    const { enableHostedMode, _resetHostedModeForTest, getKV } =
      await import("@loreai/core");
    const previous = getKV("daily_budget");
    enableHostedMode();
    try {
      const response = await api("/api/v1/costs/budget", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 5 }),
      });
      expect(response.status).toBe(403);
      expect(
        ((await response.json()) as { error: { type: string } }).error.type,
      ).toBe("forbidden");
      expect(getKV("daily_budget")).toBe(previous);
    } finally {
      _resetHostedModeForTest();
    }
  });
});

describe("hosted config before data-plane initialization", () => {
  it("enforces hosted read and write policy from route config while the core flag is false", async () => {
    const { createGatewayApp } = await import("../src/app");
    const { loadConfig } = await import("../src/config");
    const { isHostedMode, _resetHostedModeForTest } =
      await import("@loreai/core");
    _resetHostedModeForTest();
    const app = createGatewayApp({
      ...loadConfig(),
      port: 0,
      hosts: ["127.0.0.1"],
      remoteGateway: true,
      hostedMode: true,
      gatewayAuthToken: "test-token",
      allowRemoteManagement: false,
    });
    const request = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://127.0.0.1${path}`, init), {
        peerAddress: "127.0.0.1",
      });

    try {
      expect(isHostedMode()).toBe(false);
      const warming = await request("/api/v1/warming");
      expect(warming.status).toBe(200);
      expect(await warming.json()).toMatchObject({
        can_edit: false,
        can_toggle: false,
      });

      const costs = await request("/api/v1/costs");
      expect(costs.status).toBe(200);
      expect(await costs.json()).toMatchObject({
        daily: { budget: { can_edit: false } },
      });

      const mutations: Array<[string, string, unknown?]> = [
        ["PATCH", "/api/v1/warming/settings", { enabled: false }],
        ["POST", "/api/v1/warming/circuit-breaker/reset"],
        ["PATCH", "/api/v1/warming/sessions/active/mode", { mode: "stop" }],
        ["PATCH", "/api/v1/costs/budget", { amount: 5 }],
      ];
      for (const [method, path, body] of mutations) {
        const response = await request(path, {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { type: "forbidden" },
        });
      }
      expect(isHostedMode()).toBe(false);
    } finally {
      _resetHostedModeForTest();
    }
  });
});

describe("GET/PATCH /api/v1/costs", () => {
  it("returns daily, live and historical summaries with a 14-day trend", async () => {
    const data = await body<{
      live: {
        session_count: number;
        spend: number;
        workers: { warmup: { cost: number } };
      };
      totals: { spend: number; net_savings: number };
      historical: {
        session_count: number;
        worker_breakdown: { recall: { cost: number } };
      };
      daily: {
        entries: Array<{ date: string; cost: number }>;
        budget: { amount: number };
      };
      sessions: unknown[];
    }>("/api/v1/costs");
    expect(data.live).toMatchObject({
      session_count: 0,
      spend: 0,
      workers: { warmup: { cost: 0 } },
    });
    expect(data.totals.spend).toBe(0);
    expect(data.historical).toMatchObject({
      session_count: 0,
      worker_breakdown: { recall: { cost: 0 } },
    });
    expect(data.daily.entries).toHaveLength(14);
    expect(data.daily.budget.amount).toBe(0);
    expect(data.sessions).toEqual([]);
  });

  it("sets and disables the daily budget, and rejects invalid values", async () => {
    const { db, getKV, setKV } = await import("@loreai/core");
    const previous = getKV("daily_budget");
    try {
      const saved = await body<{ amount: number; disabled: boolean }>(
        "/api/v1/costs/budget",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ amount: 12.5 }),
        },
      );
      expect(saved).toEqual({ amount: 12.5, disabled: false });

      const disabled = await body<{ amount: number; disabled: boolean }>(
        "/api/v1/costs/budget",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ amount: 0 }),
        },
      );
      expect(disabled).toEqual({ amount: 0, disabled: true });

      const invalid = await api("/api/v1/costs/budget", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: -1 }),
      });
      expect(invalid.status).toBe(400);
    } finally {
      if (previous === null)
        db().query("DELETE FROM kv_meta WHERE key = ?").run("daily_budget");
      else setKV("daily_budget", previous);
    }
  });

  it("ignores ineffective environment budget values just like the cost tracker", async () => {
    const { db, getKV, setKV } = await import("@loreai/core");
    const previous = getKV("daily_budget");
    const envBefore = process.env.LORE_DAILY_BUDGET;
    try {
      setKV("daily_budget", "12");
      for (const envValue of ["0", "-1", "not-a-budget", "Infinity", "1e309"]) {
        process.env.LORE_DAILY_BUDGET = envValue;
        const snapshot = await body<{
          daily: {
            budget: {
              amount: number;
              env_override: string | null;
              can_edit: boolean;
            };
          };
        }>("/api/v1/costs");
        expect(snapshot.daily.budget).toMatchObject({
          amount: 12,
          env_override: null,
          can_edit: true,
        });

        const response = await api("/api/v1/costs/budget", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ amount: 9 }),
        });
        expect(response.status).toBe(200);
        setKV("daily_budget", "12");
      }
    } finally {
      if (envBefore === undefined) delete process.env.LORE_DAILY_BUDGET;
      else process.env.LORE_DAILY_BUDGET = envBefore;
      if (previous === null)
        db().query("DELETE FROM kv_meta WHERE key = ?").run("daily_budget");
      else setKV("daily_budget", previous);
    }
  });

  it("advertises PATCH for loopback-origin management preflights", async () => {
    const response = await api("/api/v1/warming/settings", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5500" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PATCH",
    );
  });
});
