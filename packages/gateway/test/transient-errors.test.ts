import { describe, it, expect } from "vitest";
import {
  TRANSIENT_ERROR_PATTERNS,
  isTransientErrorMessage,
  eventHasTransientError,
  type TransientCheckEvent,
} from "../src/transient-errors";

/** Build a Sentry-event-ish object from a chain of `[type, value]` pairs. */
function eventFromChain(
  chain: Array<[string, string | undefined]>,
): TransientCheckEvent {
  return {
    exception: { values: chain.map(([type, value]) => ({ type, value })) },
  };
}

describe("isTransientErrorMessage", () => {
  it("matches the connection-layer causes added for fetch-failed/terminated noise", () => {
    // These are the inner causes seen in LOREAI-GATEWAY-2W/31/34 (undici).
    expect(
      isTransientErrorMessage("Error: connect ENETUNREACH 2607:6bc0::10:443"),
    ).toBe(true);
    expect(
      isTransientErrorMessage("Error: connect ETIMEDOUT 160.79.104.10:443"),
    ).toBe(true);
    expect(
      isTransientErrorMessage("Error: connect EHOSTUNREACH 10.0.0.1:443"),
    ).toBe(true);
    expect(
      isTransientErrorMessage("Error: getaddrinfo EAI_AGAIN api.anthropic.com"),
    ).toBe(true);
    expect(isTransientErrorMessage("SocketError: other side closed")).toBe(
      true,
    );
  });

  it("still matches the pre-existing transient patterns", () => {
    expect(isTransientErrorMessage("Error: read ECONNRESET")).toBe(true);
    expect(
      isTransientErrorMessage("Error: Worker upstream auth error: 403"),
    ).toBe(true);
    expect(isTransientErrorMessage("Error: Protobuf parsing failed.")).toBe(
      true,
    );
    expect(isTransientErrorMessage("Error: write EPIPE")).toBe(true);
  });

  it("does NOT match the generic undici wrappers on their own", () => {
    // We deliberately match the inner cause, not the wrapper, so a real bug
    // that merely wraps a fetch is never silenced.
    expect(isTransientErrorMessage("TypeError: fetch failed")).toBe(false);
    expect(isTransientErrorMessage("TypeError: terminated")).toBe(false);
  });

  it("does NOT match genuine application bugs", () => {
    expect(
      isTransientErrorMessage(
        "TypeError: Cannot read properties of undefined (reading 'id')",
      ),
    ).toBe(false);
    expect(
      isTransientErrorMessage("Error: recall follow-up upstream 400"),
    ).toBe(false);
    expect(isTransientErrorMessage("ReferenceError: x is not defined")).toBe(
      false,
    );
  });
});

describe("eventHasTransientError", () => {
  it("drops the real-world fetch-failed chain via its inner ENETUNREACH/ETIMEDOUT cause", () => {
    // Mirrors LOREAI-GATEWAY-2W: inner network errors wrapped by `fetch failed`.
    const event = eventFromChain([
      ["Error", "connect ENETUNREACH 2607:6bc0::10:443 - Local (:::0)"],
      ["Error", "connect ETIMEDOUT 160.79.104.10:443"],
      ["AggregateError", undefined],
      ["TypeError", "fetch failed"],
    ]);
    expect(eventHasTransientError(event)).toBe(true);
  });

  it("drops the real-world terminated chain via `other side closed`", () => {
    // Mirrors LOREAI-GATEWAY-34.
    const event = eventFromChain([
      ["SocketError", "other side closed"],
      ["TypeError", "terminated"],
    ]);
    expect(eventHasTransientError(event)).toBe(true);
  });

  it("keeps a real bug whose chain contains only the generic wrapper", () => {
    // A `fetch failed` with no transient inner cause is NOT dropped.
    const event = eventFromChain([["TypeError", "fetch failed"]]);
    expect(eventHasTransientError(event)).toBe(false);
  });

  it("keeps genuine application errors", () => {
    const event = eventFromChain([["Error", "recall follow-up upstream 400"]]);
    expect(eventHasTransientError(event)).toBe(false);
  });

  it("returns false for events with no exception payload", () => {
    expect(eventHasTransientError({})).toBe(false);
    expect(eventHasTransientError({ exception: {} })).toBe(false);
    expect(eventHasTransientError({ exception: { values: [] } })).toBe(false);
  });
});

describe("TRANSIENT_ERROR_PATTERNS", () => {
  it("every pattern is a RegExp (guards against accidental string entries)", () => {
    for (const p of TRANSIENT_ERROR_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});
