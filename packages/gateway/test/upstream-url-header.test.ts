import { describe, test, expect } from "vitest";
import {
  extractUpstreamUrlHeader,
  providerForUpstreamOrigin,
} from "../src/config";

// ---------------------------------------------------------------------------
// extractUpstreamUrlHeader
// ---------------------------------------------------------------------------

describe("extractUpstreamUrlHeader", () => {
  test("returns undefined when header is absent", () => {
    expect(extractUpstreamUrlHeader({})).toBeUndefined();
    expect(extractUpstreamUrlHeader({ "x-api-key": "sk-abc" })).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "" }),
    ).toBeUndefined();
  });

  test("returns undefined for whitespace-only string", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "   " }),
    ).toBeUndefined();
  });

  test("extracts valid http URL", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000",
      }),
    ).toBe("http://localhost:8000");
  });

  test("extracts valid https URL", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "https://my-server.example.com:4000",
      }),
    ).toBe("https://my-server.example.com:4000");
  });

  test("preserves non-/v1 path component", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000/api",
      }),
    ).toBe("http://localhost:8000/api");
  });

  test("strips trailing /v1 (common user mistake from local LLM docs)", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000/v1",
      }),
    ).toBe("http://localhost:8000");
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000/v1/",
      }),
    ).toBe("http://localhost:8000");
  });

  test("does not strip /v1 when it is part of a longer path", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000/api/v1",
      }),
    ).toBe("http://localhost:8000/api");
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000/v1beta",
      }),
    ).toBe("http://localhost:8000/v1beta");
  });

  test("strips trailing slashes from path", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000/",
      }),
    ).toBe("http://localhost:8000");
  });

  test("strips multiple trailing slashes", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000///",
      }),
    ).toBe("http://localhost:8000");
  });

  test("trims surrounding whitespace", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "  http://localhost:8000  ",
      }),
    ).toBe("http://localhost:8000");
  });

  test("rejects non-http protocol (ftp)", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "ftp://files.example.com",
      }),
    ).toBeUndefined();
  });

  test("rejects non-http protocol (file)", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "file:///etc/passwd" }),
    ).toBeUndefined();
  });

  test("rejects invalid URL", () => {
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": "not a url" }),
    ).toBeUndefined();
  });

  test("strips control characters before validation", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000\x00\x1f",
      }),
    ).toBe("http://localhost:8000");
  });

  test("rejects oversized value (> 2048 chars)", () => {
    const longUrl = `http://localhost:8000/${"a".repeat(2048)}`;
    expect(
      extractUpstreamUrlHeader({ "x-lore-upstream-url": longUrl }),
    ).toBeUndefined();
  });

  test("accepts value at exactly 2048 chars", () => {
    // "http://localhost:8000/" = 22 chars, pad path to reach 2048 total
    const path = "a".repeat(2048 - "http://localhost:8000/".length);
    const url = `http://localhost:8000/${path}`;
    expect(url.length).toBe(2048);
    const result = extractUpstreamUrlHeader({ "x-lore-upstream-url": url });
    expect(result).toBe(url);
  });

  test("strips query parameters (origin + pathname only)", () => {
    const result = extractUpstreamUrlHeader({
      "x-lore-upstream-url": "http://localhost:8000/api?key=val",
    });
    expect(result).toBe("http://localhost:8000/api");
  });

  test("strips fragment from URL", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://localhost:8000/api#section",
      }),
    ).toBe("http://localhost:8000/api");
  });

  test("rejects URL with embedded credentials", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://user:pass@localhost:8000",
      }),
    ).toBeUndefined();
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "http://user@localhost:8000",
      }),
    ).toBeUndefined();
  });

  test("rejects javascript: protocol", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "javascript:alert(1)",
      }),
    ).toBeUndefined();
  });

  test("rejects data: protocol", () => {
    expect(
      extractUpstreamUrlHeader({
        "x-lore-upstream-url": "data:text/html,<h1>hi</h1>",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// providerForUpstreamOrigin — maps a raw upstream URL to a known provider id
// ---------------------------------------------------------------------------

describe("providerForUpstreamOrigin", () => {
  test("maps a known provider host to its provider id", () => {
    // OpenRouter is a known provider route (openai protocol) — a user's
    // ANTHROPIC_BASE_URL=openrouter.ai must resolve so the gateway flips
    // protocol + scheme correctly.
    expect(providerForUpstreamOrigin("https://openrouter.ai/api")).toBe(
      "openrouter",
    );
  });

  test("normalizes a trailing /v1 the same way the header path does", () => {
    // extractUpstreamUrlHeader strips a trailing /v1; the reverse-map key is
    // normalized the same way, so both forms resolve identically.
    const withV1 = providerForUpstreamOrigin("https://openrouter.ai/api/v1");
    const without = providerForUpstreamOrigin("https://openrouter.ai/api");
    expect(withV1).toBe(without);
  });

  test("returns undefined for an unknown / self-hosted host", () => {
    expect(
      providerForUpstreamOrigin("https://my-proxy.internal.example.com"),
    ).toBeUndefined();
  });

  test("returns undefined for an unparseable value", () => {
    expect(providerForUpstreamOrigin("not a url")).toBeUndefined();
  });
});
