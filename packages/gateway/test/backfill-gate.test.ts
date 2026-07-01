import { describe, expect, test } from "vitest";
import { makeTemporalBackfillGate } from "../src/backfill-gate";

describe("makeTemporalBackfillGate", () => {
  test("parks when background work is paused (breaker tripped), regardless of sessions", () => {
    const gate = makeTemporalBackfillGate({
      isPaused: () => true,
      activeSessions: () => [],
      windowMs: 1000,
      now: () => 10_000,
    });
    expect(gate()).toBe(true);
  });

  test("parks when a session was active within the window", () => {
    const gate = makeTemporalBackfillGate({
      isPaused: () => false,
      activeSessions: () => [{ lastRequestTime: 9_600 }],
      windowMs: 1000,
      now: () => 10_000, // 400ms ago < 1000ms window
    });
    expect(gate()).toBe(true);
  });

  test("runs when all sessions are idle beyond the window and the breaker is clear", () => {
    const gate = makeTemporalBackfillGate({
      isPaused: () => false,
      activeSessions: () => [
        { lastRequestTime: 0 },
        { lastRequestTime: 8_000 },
      ],
      windowMs: 1000,
      now: () => 10_000, // most recent is 2000ms ago >= window
    });
    expect(gate()).toBe(false);
  });

  test("runs when there are no active sessions and the breaker is clear", () => {
    const gate = makeTemporalBackfillGate({
      isPaused: () => false,
      activeSessions: () => [],
      windowMs: 1000,
      now: () => 10_000,
    });
    expect(gate()).toBe(false);
  });

  test("boundary: activity exactly windowMs ago does NOT park (strict <)", () => {
    const gate = makeTemporalBackfillGate({
      isPaused: () => false,
      activeSessions: () => [{ lastRequestTime: 9_000 }],
      windowMs: 1000,
      now: () => 10_000, // exactly 1000ms ago
    });
    expect(gate()).toBe(false);
  });

  test("re-reads sessions live on every call (no snapshot)", () => {
    let sessions: Array<{ lastRequestTime: number }> = [];
    const gate = makeTemporalBackfillGate({
      isPaused: () => false,
      activeSessions: () => sessions,
      windowMs: 1000,
      now: () => 10_000,
    });
    expect(gate()).toBe(false); // idle
    sessions = [{ lastRequestTime: 9_500 }]; // a request just arrived
    expect(gate()).toBe(true); // reflected without rebuilding the gate
  });
});
