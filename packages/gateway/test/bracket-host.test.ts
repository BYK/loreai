/**
 * Unit tests for `bracketHost()` — the shared IPv6 host bracketing helper used
 * by both the request path (`handleNodeRequest` in server.ts) and the probe
 * path (`probeUrlFor` in cli/start.ts).
 *
 * Regression guard for issue #907: an unbracketed IPv6 literal interpolated
 * into a URL (`http://::1:3207/...`) is invalid and makes `new Request()` throw.
 */
import { describe, test, expect } from "vitest";
import { bracketHost } from "../src/server";

describe("bracketHost", () => {
  test("brackets a bare IPv6 loopback literal", () => {
    expect(bracketHost("::1")).toBe("[::1]");
  });

  test("brackets a full IPv6 literal (e.g. a Tailscale v6 address)", () => {
    expect(bracketHost("fd7a:115c:a1e0::1")).toBe("[fd7a:115c:a1e0::1]");
  });

  test("leaves an IPv4 address untouched", () => {
    expect(bracketHost("127.0.0.1")).toBe("127.0.0.1");
  });

  test("leaves a hostname untouched", () => {
    expect(bracketHost("localhost")).toBe("localhost");
  });

  test("is idempotent — an already-bracketed literal is unchanged", () => {
    expect(bracketHost("[::1]")).toBe("[::1]");
  });
});
