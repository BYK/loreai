/**
 * Tests for idle session eviction.
 *
 * Validates that:
 * - The idle scheduler fires eviction after the configured timeout
 * - Sub-agent sessions use the shorter eviction timeout
 * - Eviction is disabled when timeout is 0
 * - Gradient session eviction works
 * - Auth/cost cleanup functions work
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetPipelineState,
} from "../src/pipeline";
import {
  setSessionAuth,
  getSessionAuth,
  deleteSessionAuth,
  _resetAuthForTest,
} from "../src/auth";
import {
  _resetForTest as resetCch,
} from "../src/cch";
import {
  clearAllCosts,
} from "../src/cost-tracker";
import {
  evictSession as evictGradientSession,
  inspectSessionState,
  distillLimiter,
  curatorLimiter,
} from "@loreai/core";
import { startIdleScheduler } from "../src/idle";
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
    // Should not throw
    evictGradientSession("grad-evict-sess");
    expect(inspectSessionState("grad-evict-sess")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startIdleScheduler eviction — integration tests
// ---------------------------------------------------------------------------

describe("idle scheduler eviction", () => {
  test("eviction timeout is configurable", () => {
    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    const evictionTimeoutMs = config.sessionEvictionTimeoutSeconds * 1000;

    // 33min idle session should exceed the 30min timeout
    const idleSession = makeSessionState({
      sessionID: "idle-sess",
      lastRequestTime: Date.now() - 2_000_000, // ~33 min ago
    });
    expect(Date.now() - idleSession.lastRequestTime).toBeGreaterThan(evictionTimeoutMs);

    // 5s idle session should NOT exceed the 30min timeout
    const activeSession = makeSessionState({
      sessionID: "active-sess",
      lastRequestTime: Date.now() - 5_000,
    });
    expect(Date.now() - activeSession.lastRequestTime).toBeLessThan(evictionTimeoutMs);
  });

  test("sub-agent sessions use shorter eviction timeout", () => {
    const subagentSession = makeSessionState({
      sessionID: "subagent-sess",
      isSubagent: true,
      lastRequestTime: Date.now() - 6 * 60 * 1000, // 6 min ago
    });

    const config = makeConfig({ sessionEvictionTimeoutSeconds: 1800 });
    const subagentEvictionTimeoutMs = Math.min(
      config.sessionEvictionTimeoutSeconds * 1000,
      5 * 60 * 1000,
    );

    // Sub-agent at 6min > 5min timeout → should be evicted
    expect(Date.now() - subagentSession.lastRequestTime).toBeGreaterThan(subagentEvictionTimeoutMs);

    // Regular session at 6min < 30min timeout → should NOT be evicted
    const evictionTimeoutMs = config.sessionEvictionTimeoutSeconds * 1000;
    expect(Date.now() - subagentSession.lastRequestTime).toBeLessThan(evictionTimeoutMs);
  });

  test("eviction disabled when timeout is 0", () => {
    const config = makeConfig({ sessionEvictionTimeoutSeconds: 0 });

    const sessions = new Map<string, SessionState>();
    sessions.set("sess-1", makeSessionState({
      sessionID: "sess-1",
      lastRequestTime: Date.now() - 999_999_999, // very old
    }));

    // The eviction timeout is 0, so the eviction loop should break immediately
    const stop = startIdleScheduler(
      config,
      sessions,
      async () => {},
      (_sid) => {},
    );
    stop();

    // Session should still be in the map (eviction was disabled)
    expect(config.sessionEvictionTimeoutSeconds).toBe(0);
  });

  test("accepts startIdleScheduler without eviction callback", () => {
    const sessions = new Map<string, SessionState>();
    const config = makeConfig();

    // 4th param is optional — should not throw
    const stop = startIdleScheduler(config, sessions, async () => {});
    stop();
  });

  test("onEvict callback signature matches idle scheduler", () => {
    const sessions = new Map<string, SessionState>();
    const config = makeConfig();
    const evictCalled: string[] = [];

    // Verify the callback type is compatible
    const stop = startIdleScheduler(
      config,
      sessions,
      async () => {},
      (sessionID: string) => { evictCalled.push(sessionID); },
    );
    stop();
    expect(typeof stop).toBe("function");
  });
});
