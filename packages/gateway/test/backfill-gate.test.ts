import { describe, expect, test } from "vitest";
import { makeTemporalBackfillGate } from "../src/backfill-gate";

describe("makeTemporalBackfillGate", () => {
  test("parks when background work is paused (breaker tripped), regardless of embed load", () => {
    const gate = makeTemporalBackfillGate({
      isPaused: () => true,
      isEmbedBusy: () => false,
    });
    expect(gate()).toBe(true);
  });

  test("parks when the embed worker is serving a live recall lookup", () => {
    const gate = makeTemporalBackfillGate({
      isPaused: () => false,
      isEmbedBusy: () => true,
    });
    expect(gate()).toBe(true);
  });

  test("runs when the breaker is clear and the embed worker is idle", () => {
    const gate = makeTemporalBackfillGate({
      isPaused: () => false,
      isEmbedBusy: () => false,
    });
    expect(gate()).toBe(false);
  });

  test("parks when both signals are set", () => {
    const gate = makeTemporalBackfillGate({
      isPaused: () => true,
      isEmbedBusy: () => true,
    });
    expect(gate()).toBe(true);
  });

  test("short-circuits: a tripped breaker parks without consulting embed load", () => {
    let embedChecked = false;
    const gate = makeTemporalBackfillGate({
      isPaused: () => true,
      isEmbedBusy: () => {
        embedChecked = true;
        return false;
      },
    });
    expect(gate()).toBe(true);
    expect(embedChecked).toBe(false);
  });

  test("re-reads both signals live on every call (no snapshot)", () => {
    let paused = false;
    let busy = false;
    const gate = makeTemporalBackfillGate({
      isPaused: () => paused,
      isEmbedBusy: () => busy,
    });
    expect(gate()).toBe(false); // idle
    busy = true; // a recall embed just started
    expect(gate()).toBe(true); // reflected without rebuilding the gate
    busy = false;
    paused = true; // breaker trips
    expect(gate()).toBe(true);
    paused = false;
    expect(gate()).toBe(false); // both clear again
  });
});
