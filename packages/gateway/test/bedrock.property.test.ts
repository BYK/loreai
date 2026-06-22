/**
 * Property-based tests for the AWS Bedrock translation layer.
 *
 * The recent Seer findings (stream field in body, wrong Accept header, wrong
 * SigV4 service, unreachable routes) were all INVARIANT violations — the kind
 * of bug example tests miss but property tests pin down across a wide input
 * space. Here we assert the load-bearing invariants of the pure translation
 * functions over generated inputs; failing cases shrink to a minimal repro.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  resolveBedrockModelID,
  bedrockInvokeUrl,
  bedrockInvokeNoStreamUrl,
  buildBedrockHeaders,
  buildBedrockRequestBody,
} from "../src/translate/bedrock";
import type { GatewayRequest } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** AWS region-shaped strings (alphanumeric + hyphen, e.g. "us-east-1"). */
const regionArb = fc
  .stringMatching(/^[a-z]{2}-[a-z]+-[0-9]$/)
  .filter((s) => s.length > 0);

/** Bedrock model-ID-shaped strings (letters, digits, dots, colons, hyphens). */
const modelIdArb = fc
  .stringMatching(/^[a-zA-Z0-9.:-]+$/)
  .filter((s) => s.length > 0);

/** Arbitrary header bag (lowercased keys, string values). */
const headersArb = fc.dictionary(
  fc.stringMatching(/^[a-z][a-z0-9-]*$/).filter((s) => s.length > 0),
  fc.string(),
);

function reqWith(overrides: Partial<GatewayRequest>): GatewayRequest {
  return {
    model: "claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "",
    stream: false,
    maxTokens: 1024,
    protocol: "anthropic",
    tools: [],
    rawHeaders: {},
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveBedrockModelID
// ---------------------------------------------------------------------------

describe("resolveBedrockModelID (properties)", () => {
  test("is idempotent — resolving twice equals resolving once", () => {
    fc.assert(
      fc.property(fc.string(), (model) => {
        const once = resolveBedrockModelID(model);
        const twice = resolveBedrockModelID(once);
        expect(twice).toBe(once);
      }),
    );
  });

  test("unknown models (not anthropic.* and not a known alias) pass through unchanged", () => {
    fc.assert(
      fc.property(
        // Exclude anything that could be a mapped Anthropic alias or already-Bedrock
        fc
          .string()
          .filter(
            (s) => !s.startsWith("anthropic.") && !s.startsWith("claude-"),
          ),
        (model) => {
          expect(resolveBedrockModelID(model)).toBe(model);
        },
      ),
    );
  });

  test("output is always either the input or an anthropic.* Bedrock ID", () => {
    fc.assert(
      fc.property(fc.string(), (model) => {
        const out = resolveBedrockModelID(model);
        // Either unchanged, or mapped to a Bedrock-format ID.
        expect(out === model || out.startsWith("anthropic.")).toBe(true);
      }),
    );
  });

  test("already-Bedrock IDs (anthropic.*) are never rewritten", () => {
    fc.assert(
      fc.property(modelIdArb, (suffix) => {
        const bedrockId = `anthropic.${suffix}`;
        expect(resolveBedrockModelID(bedrockId)).toBe(bedrockId);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

describe("bedrockInvokeUrl / bedrockInvokeNoStreamUrl (properties)", () => {
  test("streaming URL always ends with /invoke-with-response-stream", () => {
    fc.assert(
      fc.property(regionArb, modelIdArb, (region, modelId) => {
        const url = bedrockInvokeUrl(region, modelId);
        expect(url.endsWith("/invoke-with-response-stream")).toBe(true);
      }),
    );
  });

  test("non-streaming URL ends with /invoke but NOT /invoke-with-response-stream", () => {
    fc.assert(
      fc.property(regionArb, modelIdArb, (region, modelId) => {
        const url = bedrockInvokeNoStreamUrl(region, modelId);
        expect(url.endsWith("/invoke")).toBe(true);
        expect(url.endsWith("/invoke-with-response-stream")).toBe(false);
      }),
    );
  });

  test("both URLs are parseable and target bedrock-runtime.<region>", () => {
    fc.assert(
      fc.property(regionArb, modelIdArb, (region, modelId) => {
        for (const url of [
          bedrockInvokeUrl(region, modelId),
          bedrockInvokeNoStreamUrl(region, modelId),
        ]) {
          const parsed = new URL(url);
          expect(parsed.protocol).toBe("https:");
          expect(parsed.hostname).toBe(
            `bedrock-runtime.${region}.amazonaws.com`,
          );
        }
      }),
    );
  });

  test("model ID is URL-encoded into the path and round-trips exactly (no raw colons)", () => {
    // NOTE: assert against the constructed string, NOT new URL(url).pathname —
    // pathological segments like "." / ".." are collapsed by URL path
    // normalization, which would mask the (correct) encoding the function does.
    fc.assert(
      fc.property(regionArb, modelIdArb, (region, modelId) => {
        const url = bedrockInvokeUrl(region, modelId);
        const encoded = encodeURIComponent(modelId);
        // The function embeds the encoded model verbatim in the path.
        expect(url).toContain(`/model/${encoded}/invoke-with-response-stream`);
        // Decoding the encoded segment recovers the exact model ID.
        expect(decodeURIComponent(encoded)).toBe(modelId);
        // Colons (present in real Bedrock IDs like ...-v2:0) are always encoded.
        expect(encoded).not.toContain(":");
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildBedrockRequestBody
// ---------------------------------------------------------------------------

describe("buildBedrockRequestBody (properties)", () => {
  test("NEVER includes a `stream` field (streaming is endpoint-controlled)", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 1, max: 200_000 }),
        (stream, maxTokens) => {
          const body = buildBedrockRequestBody(
            reqWith({ stream, maxTokens }),
          ) as Record<string, unknown>;
          expect("stream" in body).toBe(false);
        },
      ),
    );
  });

  test("ALWAYS sets anthropic_version to the Bedrock sentinel", () => {
    fc.assert(
      fc.property(fc.boolean(), (stream) => {
        const body = buildBedrockRequestBody(reqWith({ stream })) as Record<
          string,
          unknown
        >;
        expect(body.anthropic_version).toBe("bedrock-2023-05-31");
      }),
    );
  });

  test("preserves max_tokens verbatim", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200_000 }), (maxTokens) => {
        const body = buildBedrockRequestBody(reqWith({ maxTokens })) as Record<
          string,
          unknown
        >;
        expect(body.max_tokens).toBe(maxTokens);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildBedrockHeaders
// ---------------------------------------------------------------------------

describe("buildBedrockHeaders (properties)", () => {
  test("Accept is the AWS event-stream type IFF streaming, else JSON", () => {
    fc.assert(
      fc.property(fc.boolean(), headersArb, (stream, rawHeaders) => {
        const headers = buildBedrockHeaders(reqWith({ stream, rawHeaders }));
        expect(headers.accept).toBe(
          stream ? "application/vnd.amazon.eventstream" : "application/json",
        );
      }),
    );
  });

  test("NEVER forwards Anthropic-specific headers Bedrock rejects", () => {
    fc.assert(
      fc.property(fc.boolean(), headersArb, (stream, rawHeaders) => {
        // Inject the Anthropic-specific headers that must be stripped.
        const withAnthropic = {
          ...rawHeaders,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          "x-anthropic-billing-header": "cch=12345",
        };
        const headers = buildBedrockHeaders(
          reqWith({ stream, rawHeaders: withAnthropic }),
        );
        expect(headers["anthropic-version"]).toBeUndefined();
        expect(headers["anthropic-beta"]).toBeUndefined();
        expect(headers["x-anthropic-billing-header"]).toBeUndefined();
      }),
    );
  });

  test("content-type is always application/json regardless of stream/headers", () => {
    fc.assert(
      fc.property(fc.boolean(), headersArb, (stream, rawHeaders) => {
        const headers = buildBedrockHeaders(reqWith({ stream, rawHeaders }));
        expect(headers["content-type"]).toBe("application/json");
      }),
    );
  });
});
