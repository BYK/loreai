import { describe, test, expect } from "vitest";
import { requestEnablesLongContext } from "../src/compaction";
import { __testing } from "../src/llm-adapter";
import type { GatewayRequest } from "../src/translate/types";

const { hasLongContextBeta, stripBetaHeaders, isBetaRelated400 } = __testing;

/**
 * `requestEnablesLongContext` gates the client-usage cap: only when the request
 * opts into the 1M window via the `context-1m` beta does the gateway report
 * usage against the model's real (1M) window instead of clamping to 200K. See
 * the #910 / MiniMax-M3 regression in compaction.test.ts.
 */
function makeRequest(rawHeaders: Record<string, string>): GatewayRequest {
  return {
    protocol: "anthropic",
    model: "MiniMax-M3",
    system: "",
    messages: [],
    tools: [],
    stream: true,
    maxTokens: 32_000,
    metadata: {},
    rawHeaders,
  };
}

describe("requestEnablesLongContext", () => {
  test("false when there is no anthropic-beta header (the MiniMax-M3 case)", () => {
    expect(requestEnablesLongContext(makeRequest({}))).toBe(false);
  });

  test("true when anthropic-beta carries a context-1m token", () => {
    expect(
      requestEnablesLongContext(
        makeRequest({ "anthropic-beta": "context-1m-2025-08-07" }),
      ),
    ).toBe(true);
  });

  test("true when context-1m sits alongside other betas", () => {
    expect(
      requestEnablesLongContext(
        makeRequest({
          "anthropic-beta":
            "oauth-2025-04-20,context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14",
        }),
      ),
    ).toBe(true);
  });

  test("header name match is case-insensitive", () => {
    expect(
      requestEnablesLongContext(
        makeRequest({ "Anthropic-Beta": "context-1m-2025-08-07" }),
      ),
    ).toBe(true);
  });

  test("false for an unrelated beta (must not over-enable the 1M window)", () => {
    expect(
      requestEnablesLongContext(
        makeRequest({ "anthropic-beta": "prompt-caching-2024-07-31" }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `hasLongContextBeta` / `stripBetaHeaders` / `isBetaRelated400` — helpers
// used by the runtime 400-retry-without-beta safety net in the worker retry
// loop. After #1571 the upfront strip makes this safety net dead code for
// `context-1m` specifically, but the helpers remain as the explicit fallback
// for any future beta the upstream rejects. These unit tests pin the helper
// behavior so a future refactor (a) doesn't accidentally drop the OAuth gate
// during strip, (b) doesn't accept unrelated betas as "beta-related", and
// (c) doesn't lose case-insensitivity on the header key match.
// ---------------------------------------------------------------------------

describe("hasLongContextBeta (worker retry-loop guard, #1571)", () => {
  test("false on empty headers", () => {
    expect(hasLongContextBeta({})).toBe(false);
  });

  test("false when anthropic-beta carries an unrelated token", () => {
    expect(
      hasLongContextBeta({ "anthropic-beta": "prompt-caching-2024-07-31" }),
    ).toBe(false);
  });

  test("true when anthropic-beta carries a context-1m token", () => {
    expect(
      hasLongContextBeta({ "anthropic-beta": "context-1m-2025-08-07" }),
    ).toBe(true);
  });

  test("true when context-1m sits alongside the OAuth gate", () => {
    expect(
      hasLongContextBeta({
        "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07",
      }),
    ).toBe(true);
  });

  test("true on a date-suffixed context-1m variant", () => {
    expect(
      hasLongContextBeta({ "anthropic-beta": "context-1m-2099-12-31" }),
    ).toBe(true);
  });

  test("matches the header key case-insensitively", () => {
    expect(
      hasLongContextBeta({
        "Anthropic-Beta": "oauth-2025-04-20,context-1m-2025-08-07",
      }),
    ).toBe(true);
  });

  test("false on a token that doesn't contain the context-1m substring at all", () => {
    // The guard uses a SUBSTRING match (`/context-1m/i`), so a token like
    // `context-1m0` WOULD over-trigger — that's intentional, the precise
    // strip lives in `stripBetaHeaders` / `stripLongContextBetaForWorker`
    // (both anchored on the full token). This test pins the loose-match
    // contract: false ONLY when there's no `context-1m` substring anywhere.
    expect(hasLongContextBeta({ "anthropic-beta": "context-100m" })).toBe(
      false,
    );
    expect(
      hasLongContextBeta({ "anthropic-beta": "prompt-caching-2024-07-31" }),
    ).toBe(false);
  });
});

describe("stripBetaHeaders (worker retry-loop recovery, #1571)", () => {
  test("returns a fresh headers object (does not mutate the input)", () => {
    const input = {
      "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07",
      "content-type": "application/json",
    };
    const snapshot = JSON.stringify(input);
    const out = stripBetaHeaders(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
  });

  test("removes only context-1m, preserves oauth-2025-04-20 and other betas", () => {
    const out = stripBetaHeaders({
      "anthropic-beta":
        "oauth-2025-04-20,context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14",
    });
    expect(out["anthropic-beta"]).toBe(
      "oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
    );
  });

  test("drops the entire anthropic-beta header when stripping leaves no betas", () => {
    const out = stripBetaHeaders({
      "anthropic-beta": "context-1m-2025-08-07",
      "content-type": "application/json",
    });
    expect(out).not.toHaveProperty("anthropic-beta");
    expect(out["content-type"]).toBe("application/json");
  });

  test("matches context-1m case-insensitively (defense-in-depth)", () => {
    const out = stripBetaHeaders({
      "anthropic-beta": "Context-1M-2025-08-07",
    });
    expect(out).not.toHaveProperty("anthropic-beta");
  });

  test("preserves the header key case (only mutates the value)", () => {
    const out = stripBetaHeaders({
      "Anthropic-Beta": "oauth-2025-04-20,context-1m-2025-08-07",
    });
    expect(out).toHaveProperty("Anthropic-Beta");
    expect(out["Anthropic-Beta"]).toBe("oauth-2025-04-20");
  });

  test("preserves non-anthropic-beta headers verbatim", () => {
    const out = stripBetaHeaders({
      "anthropic-beta": "context-1m-2025-08-07",
      "content-type": "application/json",
      "x-custom": "user-value",
    });
    expect(out["content-type"]).toBe("application/json");
    expect(out["x-custom"]).toBe("user-value");
  });

  test("does not match context-100m, context-1m0, acme-context-1m (precision)", () => {
    const out = stripBetaHeaders({
      "anthropic-beta": "context-100m,context-1m0,acme-context-1m",
    });
    // None of these are valid context-1m variants, so the strip is a no-op
    // and the header is preserved verbatim.
    expect(out["anthropic-beta"]).toBe(
      "context-100m,context-1m0,acme-context-1m",
    );
  });

  test("returns an empty object when the only header is context-1m-only", () => {
    const out = stripBetaHeaders({ "anthropic-beta": "context-1m-2025-08-07" });
    expect(out).toEqual({});
  });
});

describe("isBetaRelated400 (worker retry-loop heuristic, #1571)", () => {
  test("true for Anthropic's long-context 400 message", () => {
    expect(
      isBetaRelated400(
        "The long context beta is not yet available for this subscription.",
      ),
    ).toBe(true);
  });

  test("true for a generic unsupported-beta message", () => {
    expect(isBetaRelated400("unsupported beta: foo-bar-2026-01-01")).toBe(true);
    expect(isBetaRelated400("beta is not enabled for your account")).toBe(true);
    expect(isBetaRelated400("invalid beta token: foo")).toBe(true);
  });

  test("false for a 400 that does not mention 'beta'", () => {
    expect(isBetaRelated400("model not found")).toBe(false);
    expect(isBetaRelated400("bad max_tokens")).toBe(false);
    expect(isBetaRelated400("prompt too long")).toBe(false);
  });

  test("false for a 400 that mentions 'beta' but without a rejection verb", () => {
    // The heuristic requires BOTH the word 'beta' AND a rejection verb
    // (not available / unsupported / not enabled / invalid). A 400 that just
    // mentions the beta name in a different context should NOT trigger the
    // safety net (would cause a wasted retry).
    expect(isBetaRelated400("the beta field is required")).toBe(false);
    expect(isBetaRelated400("beta: usage exceeded")).toBe(false);
  });
});
