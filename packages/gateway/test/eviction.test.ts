/**
 * Tests for idle session eviction.
 *
 * Uses the extracted `evictIdleSessions()` function directly — no timer
 * involvement — to verify the full eviction pipeline: guards, persistence,
 * cleanup, and consolidation cooldown removal.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { resetPipelineState } from "../src/pipeline";
import {
  setSessionAuth,
  getSessionAuth,
  deleteSessionAuth,
  _resetAuthForTest,
} from "../src/auth";
import { _resetForTest as resetCch } from "../src/cch";
import { clearAllCosts } from "../src/cost-tracker";
import {
  evictSession as evictGradientSession,
  inspectSessionState,
  distillLimiter,
  curatorLimiter,
} from "@loreai/core";
import { startIdleScheduler, evictIdleSessions } from "../src/idle";
import { loadConfig } from "../src/config";
import type { GatewayConfig } from "../src/config";
import type { SessionState } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    port: 0,
    portExplicit: false,
    hosts: ["127.0.0.1"],
    upstreamAnthropic: "https://api.anthropic.com",
    upstreamOpenAI: "https://api.openai.com",
    idleTimeoutSeconds: 60,
    sessionEvictionTimeoutSeconds: 1800,
    debug: false,
    hostedMode: false,
    remoteGateway: false,
    ...overrides,
  };
}

function makeSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionID: "test-session",
    projectPath: "/tmp/test-project",
    fingerprint: "fp-123",
    lastRequestTime: Date.now(),
    lastUserTurnTime: 0,
    messageCount: 5,
    turnsSinceCuration: 2,
    consecutiveTextOnlyTurns: 0,
    recallStore: new Map(),
    upstreamByProvider: new Map(),
    cacheAnalytics: {
      lastRequestBody: null,
      lastRequestBodyLength: 0,
      lastCacheRead: 0,
      lastCacheCreation: 0,
      turnCount: 0,
      bustCount: 0,
    },
    ...overrides,
  };
}

const EMPTY_SET = new Set<string>();

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await resetPipelineState();
  _resetAuthForTest();
  resetCch();
  clearAllCosts();
  distillLimiter.clear();
  curatorLimiter.clear();
});

// ---------------------------------------------------------------------------
// Per-module cleanup — unit tests
// ---------------------------------------------------------------------------

describe("session cleanup helpers", () => {
  test("deleteSessionAuth clears auth credentials", () => {
    setSessionAuth("evict-auth-sess", { scheme: "bearer", value: "tok-abc" });
    expect(getSessionAuth("evict-auth-sess")).not.toBeNull();

    deleteSessionAuth("evict-auth-sess");
    expect(getSessionAuth("evict-auth-sess")).toBeNull();
  });

  test("evictGradientSession does not throw for unknown sessions", () => {
    expect(inspectSessionState("grad-evict-sess")).toBeNull();
    evictGradientSession("grad-evict-sess");
    expect(inspectSessionState("grad-evict-sess")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("sessionEvictionTimeoutSeconds config", () => {
  test("defaults to 1800 when env var is unset", () => {
    const config = loadConfig();
    expect(config.sessionEvictionTimeoutSeconds).toBe(1800);
  });

  test("allows 0 to disable eviction", () => {
    const original = process.env.LORE_SESSION_EVICTION_TIMEOUT;
    try {
      process.env.LORE_SESSION_EVICTION_TIMEOUT = "0";
      const config = loadConfig();
      expect(config.sessionEvictionTimeoutSeconds).toBe(0);
    } finally {
      if (original === undefined) {
        delete process.env.LORE_SESSION_EVICTION_TIMEOUT;
      } else {
        process.env.LORE_SESSION_EVICTION_TIMEOUT = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// evictIdleSessions — integration tests (no timers needed)
// ---------------------------------------------------------------------------

describe("evictIdleSessions", () => {
  test("evicts sessions past the eviction timeout", () => {
    const sessions = new Map<string, SessionState>();
    sessions.set(
      "idle-sess",
      makeSessionState({
        sessionID: "idle-sess",
        lastRequestTime: Date.now() - 2_000_000, // ~33 min ago
      }),
    );
    sessions.set(
      "active-sess",
      makeSessionState({
        sessionID: "active-sess",
        lastRequestTime: Date.now() - 5_000, // 5 seconds ago
      }),
    );

    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    const evicted = evictIdleSessions(
      config,
      sessions,
      EMPTY_SET,
      EMPTY_SET,
      Date.now(),
    );

    expect(evicted).toBe(1);
    expect(sessions.has("idle-sess")).toBe(false);
    expect(sessions.has("active-sess")).toBe(true);
  });

  test("calls onEvict callback for each evicted session", () => {
    const sessions = new Map<string, SessionState>();
    sessions.set(
      "sess-a",
      makeSessionState({
        sessionID: "sess-a",
        lastRequestTime: Date.now() - 2_000_000,
      }),
    );
    sessions.set(
      "sess-b",
      makeSessionState({
        sessionID: "sess-b",
        lastRequestTime: Date.now() - 2_000_000,
      }),
    );

    const evictedIds: string[] = [];
    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    const evicted = evictIdleSessions(
      config,
      sessions,
      EMPTY_SET,
      EMPTY_SET,
      Date.now(),
      (sid) => {
        evictedIds.push(sid);
      },
    );

    expect(evicted).toBe(2);
    expect(evictedIds).toContain("sess-a");
    expect(evictedIds).toContain("sess-b");
    expect(sessions.size).toBe(0);
  });

  test("cleans up auth credentials on eviction", () => {
    setSessionAuth("auth-evict", { scheme: "bearer", value: "tok-abc" });
    expect(getSessionAuth("auth-evict")).not.toBeNull();

    const sessions = new Map<string, SessionState>();
    sessions.set(
      "auth-evict",
      makeSessionState({
        sessionID: "auth-evict",
        lastRequestTime: Date.now() - 2_000_000,
      }),
    );

    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    evictIdleSessions(config, sessions, EMPTY_SET, EMPTY_SET, Date.now());

    expect(getSessionAuth("auth-evict")).toBeNull();
    expect(sessions.has("auth-evict")).toBe(false);
  });

  test("cleans up session-limiter instances on eviction", () => {
    // Create limiter instances for the session
    const distillOriginal = distillLimiter.get("limiter-evict");
    const curatorOriginal = curatorLimiter.get("limiter-evict");

    const sessions = new Map<string, SessionState>();
    sessions.set(
      "limiter-evict",
      makeSessionState({
        sessionID: "limiter-evict",
        lastRequestTime: Date.now() - 2_000_000,
      }),
    );

    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    evictIdleSessions(config, sessions, EMPTY_SET, EMPTY_SET, Date.now());

    // After eviction, .get() should return a new (different) instance
    expect(distillLimiter.get("limiter-evict")).not.toBe(distillOriginal);
    expect(curatorLimiter.get("limiter-evict")).not.toBe(curatorOriginal);
  });

  test("sub-agent sessions evict after 5 minutes", () => {
    const sessions = new Map<string, SessionState>();
    sessions.set(
      "subagent-old",
      makeSessionState({
        sessionID: "subagent-old",
        isSubagent: true,
        lastRequestTime: Date.now() - 6 * 60 * 1000, // 6 min ago
      }),
    );
    sessions.set(
      "subagent-recent",
      makeSessionState({
        sessionID: "subagent-recent",
        isSubagent: true,
        lastRequestTime: Date.now() - 3 * 60 * 1000, // 3 min ago
      }),
    );
    sessions.set(
      "regular-6min",
      makeSessionState({
        sessionID: "regular-6min",
        lastRequestTime: Date.now() - 6 * 60 * 1000, // 6 min ago — NOT evicted (< 30min)
      }),
    );

    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    const evicted = evictIdleSessions(
      config,
      sessions,
      EMPTY_SET,
      EMPTY_SET,
      Date.now(),
    );

    expect(evicted).toBe(1);
    expect(sessions.has("subagent-old")).toBe(false); // 6min > 5min → evicted
    expect(sessions.has("subagent-recent")).toBe(true); // 3min < 5min → kept
    expect(sessions.has("regular-6min")).toBe(true); // 6min < 30min → kept
  });

  test("sub-agent timeout capped by configurable timeout when lower", () => {
    const sessions = new Map<string, SessionState>();
    sessions.set(
      "subagent",
      makeSessionState({
        sessionID: "subagent",
        isSubagent: true,
        lastRequestTime: Date.now() - 3 * 60 * 1000, // 3 min ago
      }),
    );

    // Config timeout is 2 min — lower than the 5 min sub-agent constant
    const config = makeConfig({ sessionEvictionTimeoutSeconds: 120 });
    const evicted = evictIdleSessions(
      config,
      sessions,
      EMPTY_SET,
      EMPTY_SET,
      Date.now(),
    );

    // 3 min > 2 min → evicted (Math.min picks the config value)
    expect(evicted).toBe(1);
    expect(sessions.has("subagent")).toBe(false);
  });

  test("does not evict when timeout is 0 (disabled)", () => {
    const sessions = new Map<string, SessionState>();
    sessions.set(
      "old-sess",
      makeSessionState({
        sessionID: "old-sess",
        lastRequestTime: Date.now() - 999_999_999,
      }),
    );

    const config = makeConfig({ sessionEvictionTimeoutSeconds: 0 });
    const evicted = evictIdleSessions(
      config,
      sessions,
      EMPTY_SET,
      EMPTY_SET,
      Date.now(),
    );

    expect(evicted).toBe(0);
    expect(sessions.has("old-sess")).toBe(true);
  });

  test("does not evict sessions with in-flight idle work", () => {
    const sessions = new Map<string, SessionState>();
    sessions.set(
      "busy-sess",
      makeSessionState({
        sessionID: "busy-sess",
        lastRequestTime: Date.now() - 2_000_000,
      }),
    );

    const inProgress = new Set(["busy-sess"]);
    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    const evicted = evictIdleSessions(
      config,
      sessions,
      inProgress,
      EMPTY_SET,
      Date.now(),
    );

    expect(evicted).toBe(0);
    expect(sessions.has("busy-sess")).toBe(true);
  });

  test("does not evict sessions with in-flight warmup", () => {
    const sessions = new Map<string, SessionState>();
    sessions.set(
      "warming-sess",
      makeSessionState({
        sessionID: "warming-sess",
        lastRequestTime: Date.now() - 2_000_000,
      }),
    );

    const warmupInProgress = new Set(["warming-sess"]);
    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    const evicted = evictIdleSessions(
      config,
      sessions,
      EMPTY_SET,
      warmupInProgress,
      Date.now(),
    );

    expect(evicted).toBe(0);
    expect(sessions.has("warming-sess")).toBe(true);
  });

  test("does not evict sessions still executing tools", () => {
    const sessions = new Map<string, SessionState>();
    sessions.set(
      "tool-sess",
      makeSessionState({
        sessionID: "tool-sess",
        lastRequestTime: Date.now() - 2_000_000,
        lastStopReason: "tool_use",
      }),
    );

    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    const evicted = evictIdleSessions(
      config,
      sessions,
      EMPTY_SET,
      EMPTY_SET,
      Date.now(),
    );

    expect(evicted).toBe(0);
    expect(sessions.has("tool-sess")).toBe(true);
  });

  test("returns count of evicted sessions", () => {
    const sessions = new Map<string, SessionState>();
    for (let i = 0; i < 5; i++) {
      sessions.set(
        `sess-${i}`,
        makeSessionState({
          sessionID: `sess-${i}`,
          lastRequestTime: Date.now() - 2_000_000,
        }),
      );
    }
    sessions.set(
      "active",
      makeSessionState({
        sessionID: "active",
        lastRequestTime: Date.now(),
      }),
    );

    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    const evicted = evictIdleSessions(
      config,
      sessions,
      EMPTY_SET,
      EMPTY_SET,
      Date.now(),
    );

    expect(evicted).toBe(5);
    expect(sessions.size).toBe(1);
    expect(sessions.has("active")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// startIdleScheduler — compatibility tests
// ---------------------------------------------------------------------------

describe("startIdleScheduler", () => {
  test("accepts optional onEvict callback", () => {
    const sessions = new Map<string, SessionState>();
    const config = makeConfig();
    const stop = startIdleScheduler(config, sessions, async () => {});
    stop();
  });

  test("accepts onEvict callback without error", () => {
    const sessions = new Map<string, SessionState>();
    const config = makeConfig();
    const stop = startIdleScheduler(
      config,
      sessions,
      async () => {},
      (_sid) => {},
    );
    stop();
    expect(typeof stop).toBe("function");
  });
});
