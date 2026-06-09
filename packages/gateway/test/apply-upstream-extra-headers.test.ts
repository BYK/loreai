/**
 * Tests for `applyUpstreamExtraHeaders` precedence in the translate/types layer.
 *
 * The function is a final-overlay merge applied AFTER:
 *   1. client-forwarded headers (from `forwardClientHeaders`)
 *   2. gateway-managed headers (`x-api-key`, `Authorization`, `x-lore-*`,
 *      `content-type`, framing headers)
 *
 * Precedence (lowest → highest): client forwarded → gateway managed → user
 * extras. This means a user-supplied `Authorization: Bearer svc-token`
 * OVERRIDES the session's reconstructed auth — which is the intended
 * corporate-proxy / service-account behavior.
 */
import { describe, test, expect } from "vitest";
import { applyUpstreamExtraHeaders } from "../src/translate/types";

describe("applyUpstreamExtraHeaders", () => {
  test("is a no-op when extras is undefined", () => {
    const headers = {
      "x-api-key": "session-key",
      "content-type": "application/json",
    };
    applyUpstreamExtraHeaders(headers);
    expect(headers).toEqual({
      "x-api-key": "session-key",
      "content-type": "application/json",
    });
  });

  test("is a no-op when extras is empty", () => {
    const headers = { "x-api-key": "session-key" };
    applyUpstreamExtraHeaders(headers, {});
    expect(headers).toEqual({ "x-api-key": "session-key" });
  });

  test("adds new headers without clobbering existing ones", () => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": "session-key",
    };
    applyUpstreamExtraHeaders(headers, {
      "x-corp-token": "abc",
      "x-tenant": "acme",
    });
    expect(headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "session-key",
      "x-corp-token": "abc",
      "x-tenant": "acme",
    });
  });

  test("user-supplied Authorization OVERRIDES the session's", () => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: "Bearer session-key",
    };
    applyUpstreamExtraHeaders(headers, {
      authorization: "Bearer svc-account-token",
    });
    expect(headers.authorization).toBe("Bearer svc-account-token");
  });

  test("user-supplied x-api-key OVERRIDES the session's", () => {
    const headers: Record<string, string> = {
      "x-api-key": "session-key",
    };
    applyUpstreamExtraHeaders(headers, { "x-api-key": "corp-shared-key" });
    expect(headers["x-api-key"]).toBe("corp-shared-key");
  });

  test("extras can introduce gateway-managed blocklisted keys (caller's responsibility)", () => {
    // The function does NOT enforce the gateway blocklist — that's the
    // caller's job (each builder decides what to do after the overlay).
    // This test documents the current contract.
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    applyUpstreamExtraHeaders(headers, { "x-lore-project": "/tmp/leak" });
    expect(headers["x-lore-project"]).toBe("/tmp/leak");
  });
});
