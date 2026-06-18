import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  signBody,
  resignBody,
  hasBillingHeader,
  captureBillingPrefix,
  captureSessionHeaders,
  buildBillingBlock,
  buildCodexWorkerHeaders,
  buildOAuthWorkerHeaders,
  deleteBillingPrefix,
  isClaudeCodeOAuthSession,
  validateSeed,
  resolveSeed,
  _resetForTest,
  WORKER_VERSION,
  WORKER_SEED,
  WORKER_SALT,
  CCH_PLACEHOLDER,
  VERSION_SEEDS,
  _computeVersionSuffix,
  _parseSemver,
  _compareSemver,
  _cchPreimage,
} from "../src/cch";
import { xxHash64 } from "../src/xxhash";
import { log } from "@loreai/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SID_A = "sess-a";
const SID_B = "sess-b";

beforeEach(() => {
  _resetForTest();
});

// ---------------------------------------------------------------------------
// signBody
// ---------------------------------------------------------------------------

describe("signBody", () => {
  /**
   * Build a body whose system prompt carries a real billing header with the
   * `cch=00000` placeholder, plus an arbitrary `extra` payload to vary the
   * hash input. signBody only signs a genuine billing header, so the
   * placeholder must live inside one.
   */
  const billingBody = (extra: string) =>
    JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.37.fbe; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [{ role: "user", content: extra }],
    });

  test("replaces cch=00000 with a 5-char hex hash", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.37.fbe; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });

    const signed = signBody(body);
    expect(signed).not.toContain("cch=00000");
    expect(signed).toMatch(/cch=[0-9a-f]{5};/);
  });

  test("produces different hashes for different bodies", () => {
    const cch1 = signBody(billingBody("hello")).match(/cch=([0-9a-f]{5})/)?.[1];
    const cch2 = signBody(billingBody("world")).match(/cch=([0-9a-f]{5})/)?.[1];

    expect(cch1).toBeDefined();
    expect(cch2).toBeDefined();
    expect(cch1).not.toEqual(cch2);
  });

  test("produces deterministic output for the same input", () => {
    const body = billingBody("stable");
    expect(signBody(body)).toEqual(signBody(body));
  });

  test("zero-pads short hashes to 5 chars", () => {
    for (let i = 0; i < 20; i++) {
      const signed = signBody(billingBody(`i${i}`));
      const match = signed.match(/cch=([0-9a-f]+);/);
      expect(match).not.toBeNull();
      expect(match?.[1]).toHaveLength(5);
    }
  });

  test("is a no-op when no billing header is present (structural anchor)", () => {
    // Reviewer #3: the bare-placeholder fallback re-introduced the original
    // bug. signBody must NEVER rewrite a content cch=00000 with no header.
    const body =
      '{"system":[{"type":"text","text":"docs: `cch=00000`"}],"messages":[]}';
    expect(signBody(body)).toBe(body);
  });

  test("signs the billing header even when content cch=00000 sorts FIRST", () => {
    // Reviewer #1: content documenting the header (serialized before it) must
    // not steal the signature. The content placeholder stays; the header is
    // signed.
    const body = JSON.stringify({
      system: [
        {
          type: "text",
          text: "LTM doc: cc_entrypoint=cli; cch=00000 (example)",
        },
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.37.fbe; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const signed = signBody(body);
    // Content placeholder preserved verbatim.
    expect(signed).toContain("cc_entrypoint=cli; cch=00000 (example)");
    // Billing header signed with a real hash.
    expect(signed).toMatch(
      /x-anthropic-billing-header: cc_version=2\.1\.37\.fbe; cc_entrypoint=cli; cch=[0-9a-f]{5};/,
    );
  });

  test("does NOT rewrite a cch=00000 token in system/LTM content (cache-bust regression)", () => {
    // Regression for the self-referential cache bust: an LTM entry whose text
    // literally contains `cch=00000` must be left untouched, otherwise system[N]
    // bytes change every turn and bust the entire prompt cache.
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.165.abc; cc_entrypoint=cli; cch=00000;",
        },
        {
          type: "text",
          // LTM content documenting the placeholder — contains cch=00000.
          text: "CCH_PLACEHOLDER = `cch=00000` (cch.ts:103); signBody() replaces it.",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });

    const signed = signBody(body);
    // The LTM content placeholder must be preserved verbatim.
    expect(signed).toContain("CCH_PLACEHOLDER = `cch=00000`");
    // Exactly one cch=00000 (the content one) should remain; the billing
    // header's was rewritten to a real hash.
    const placeholderCount = signed.split("cch=00000").length - 1;
    expect(placeholderCount).toBe(1);
    // The billing header carries a real signed hash.
    const billing = JSON.parse(signed).system[0].text as string;
    expect(billing).toMatch(/cc_entrypoint=cli; cch=[0-9a-f]{5};/);
    expect(billing).not.toContain("cch=00000");
  });

  test("signing is stable across turns when only content cch changes", () => {
    // Two turns where the billing header is identical but the (irrelevant)
    // content cch token differs — the billing cch must be identical, proving
    // content tokens don't leak into the signature target.
    const make = (contentCch: string) =>
      JSON.stringify({
        model: "claude-opus-4-8",
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.165.abc; cc_entrypoint=cli; cch=00000;",
          },
          { type: "text", text: `note: \`cch=${contentCch}\`` },
        ],
        messages: [{ role: "user", content: "same" }],
      });

    const a = signBody(make("11111"));
    const b = signBody(make("11111"));
    expect(a).toBe(b);
    // Both preserve their distinct content tokens untouched.
    expect(signBody(make("aaaaa"))).toContain("`cch=aaaaa`");
  });
});

// ---------------------------------------------------------------------------
// cchPreimage (>= 2.1.172 hash-input transform)
// ---------------------------------------------------------------------------

describe("cchPreimage", () => {
  test("strips the model value", () => {
    expect(_cchPreimage('{"model":"claude-opus-4-8","x":1}')).toBe(
      '{"model":"","x":1}',
    );
  });

  test("strips the max_tokens field with its trailing comma", () => {
    expect(_cchPreimage('{"a":1,"max_tokens":64000,"b":2}')).toBe(
      '{"a":1,"b":2}',
    );
  });

  test("strips max_tokens as the last key (leading-comma fallback)", () => {
    // Defensive: not the real binary's layout, but must stay valid JSON.
    expect(_cchPreimage('{"a":1,"max_tokens":64000}')).toBe('{"a":1}');
  });

  test("removes exactly one comma (never both) when mid-object", () => {
    const out = _cchPreimage('{"model":"x","max_tokens":8192,"stream":true}');
    expect(out).toBe('{"model":"","stream":true}');
    // No doubled or dangling commas.
    expect(out).not.toContain(",,");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test("strips both model value and max_tokens together", () => {
    const body =
      '{"model":"sonnet","max_tokens":8192,"messages":[],"stream":true}';
    expect(_cchPreimage(body)).toBe('{"model":"","messages":[],"stream":true}');
  });

  test("is a no-op when neither field is present", () => {
    const body = '{"system":[{"text":"cch=00000;"}],"messages":[]}';
    expect(_cchPreimage(body)).toBe(body);
  });

  test("only strips the first model occurrence", () => {
    // The model field is the first JSON key; a later literal must be untouched.
    const body = '{"model":"a","note":"the model:\\"x\\" stays"}';
    expect(_cchPreimage(body)).toBe(
      '{"model":"","note":"the model:\\"x\\" stays"}',
    );
  });
});

// ---------------------------------------------------------------------------
// computeVersionSuffix
// ---------------------------------------------------------------------------

describe("computeVersionSuffix", () => {
  test("returns a 3-char hex string", () => {
    const suffix = _computeVersionSuffix("hello world message");
    expect(suffix).toMatch(/^[0-9a-f]{3}$/);
  });

  test("different messages produce different suffixes", () => {
    const s1 = _computeVersionSuffix("Summarize this conversation segment");
    const s2 = _computeVersionSuffix("Expand the following query for search");
    expect(s1).not.toEqual(s2);
  });

  test("pads with '0' for short messages", () => {
    // Message shorter than index 20 — should pad
    const s1 = _computeVersionSuffix("hi");
    expect(s1).toMatch(/^[0-9a-f]{3}$/);
  });

  test("is deterministic", () => {
    const msg = "Some worker prompt text here";
    expect(_computeVersionSuffix(msg)).toEqual(_computeVersionSuffix(msg));
  });

  test("uses chars at indices 4, 7, 20", () => {
    // We know the algorithm: sha256(salt + chars[4,7,20] + version)[:3]
    // Just verify it doesn't throw and produces a valid suffix
    const msg = "0123456789012345678901234";
    const suffix = _computeVersionSuffix(msg);
    expect(suffix).toMatch(/^[0-9a-f]{3}$/);
  });
});

// ---------------------------------------------------------------------------
// captureBillingPrefix (per-session)
// ---------------------------------------------------------------------------

describe("captureBillingPrefix", () => {
  test("detects billing header in a real Claude Code system prompt", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;\nYou are Claude Code...";
    expect(captureBillingPrefix(SID_A, system)).toBe(true);
  });

  test("detects billing header with different version and hash values", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2.1.37.abc; cc_entrypoint=cli; cch=00000;";
    expect(captureBillingPrefix(SID_A, system)).toBe(true);
  });

  test("returns false when no billing header is present", () => {
    expect(
      captureBillingPrefix(
        SID_A,
        "You are Claude Code, Anthropic's official CLI.",
      ),
    ).toBe(false);
  });

  test("returns false for empty system prompt", () => {
    expect(captureBillingPrefix(SID_A, "")).toBe(false);
  });

  test("returns false when billing header is not at the start", () => {
    const system =
      "Some prefix\nx-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;";
    expect(captureBillingPrefix(SID_A, system)).toBe(false);
  });

  test("non-matching turn does not erase a previously captured flag", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(SID_A, "later turn with no header");
    expect(buildBillingBlock(SID_A, "test message")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildBillingBlock (per-session, pinned version)
// ---------------------------------------------------------------------------

describe("buildBillingBlock", () => {
  const MSG = "Summarize this conversation.";

  test("returns null for an unknown session", () => {
    expect(buildBillingBlock(SID_A, MSG)).toBeNull();
  });

  test("returns null when sessionID is undefined", () => {
    expect(buildBillingBlock(undefined, MSG)).toBeNull();
  });

  test("returns block with cch=00000 placeholder after capture", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block = buildBillingBlock(SID_A, MSG);
    expect(block).not.toBeNull();
    expect(block?.type).toBe("text");
    expect(block?.text).toContain("cch=00000;");
    expect(block?.text).toContain("cc_entrypoint=cli");
    expect(block?.text).toMatch(/^x-anthropic-billing-header:/);
  });

  test("pins billing header to WORKER_VERSION, not the client version", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.0.99.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block = buildBillingBlock(SID_A, MSG);
    expect(block?.text).toContain(`cc_version=${WORKER_VERSION}.`);
    expect(block?.text).not.toContain("cc_version=2.0.99");
  });

  test("includes a 3-char hex version suffix derived from user message", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block = buildBillingBlock(SID_A, MSG);
    // cc_version=2.1.37.XXX where XXX is 3 hex chars
    expect(block?.text).toMatch(
      new RegExp(`cc_version=${WORKER_VERSION}\\.[0-9a-f]{3};`),
    );
  });

  test("different user messages produce different version suffixes", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    const block1 = buildBillingBlock(SID_A, "Summarize this conversation.");
    const block2 = buildBillingBlock(
      SID_A,
      "Expand query for semantic search.",
    );
    // Extract the suffix
    const suffix1 = block1?.text.match(
      /cc_version=\d+\.\d+\.\d+\.([0-9a-f]{3})/,
    )?.[1];
    const suffix2 = block2?.text.match(
      /cc_version=\d+\.\d+\.\d+\.([0-9a-f]{3})/,
    )?.[1];
    expect(suffix1).toBeDefined();
    expect(suffix2).toBeDefined();
    expect(suffix1).not.toEqual(suffix2);
  });

  test("does not leak billing state from session A into session B", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    // Session B never captures billing
    captureBillingPrefix(SID_B, "You are a helpful assistant.");

    expect(buildBillingBlock(SID_A, MSG)).not.toBeNull();
    expect(buildBillingBlock(SID_B, MSG)).toBeNull();
  });

  test("both sessions get billing blocks when both have billing headers", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(
      SID_B,
      "x-anthropic-billing-header: cc_version=2.0.0.xyz; cc_entrypoint=cli; cch=b9999;",
    );

    // Both sessions get billing blocks pinned to WORKER_VERSION
    const blockA = buildBillingBlock(SID_A, MSG);
    const blockB = buildBillingBlock(SID_B, MSG);
    expect(blockA).not.toBeNull();
    expect(blockB).not.toBeNull();
    expect(blockA?.text).toContain(`cc_version=${WORKER_VERSION}.`);
    expect(blockB?.text).toContain(`cc_version=${WORKER_VERSION}.`);
  });

  test("an API-key session that never captures a prefix returns null", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(SID_B, "You are a helpful assistant."); // no header

    expect(buildBillingBlock(SID_A, MSG)).not.toBeNull();
    expect(buildBillingBlock(SID_B, MSG)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteBillingPrefix
// ---------------------------------------------------------------------------

describe("deleteBillingPrefix", () => {
  const MSG = "test";

  test("removes the billing flag for the given session", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    expect(buildBillingBlock(SID_A, MSG)).not.toBeNull();
    deleteBillingPrefix(SID_A);
    expect(buildBillingBlock(SID_A, MSG)).toBeNull();
  });

  test("does not affect other sessions", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );
    captureBillingPrefix(
      SID_B,
      "x-anthropic-billing-header: cc_version=2.0.0.xyz; cc_entrypoint=cli; cch=b9999;",
    );
    deleteBillingPrefix(SID_A);
    expect(buildBillingBlock(SID_A, MSG)).toBeNull();
    expect(buildBillingBlock(SID_B, MSG)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateSeed
// ---------------------------------------------------------------------------

describe("validateSeed", () => {
  test("returns null when body has no cch field", () => {
    expect(validateSeed('{"model":"claude","messages":[]}')).toBeNull();
  });

  test("returns true for a body signed with the known seed", () => {
    // Create a body, sign it with our seed, then validate
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.abc; cc_entrypoint=cli; cch=00000;`,
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    const signed = signBody(body);
    expect(validateSeed(signed)).toBe(true);
  });

  test("returns false for a body signed with an unknown seed", () => {
    // Manually create a body with a fake cch
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=9.9.9.abc; cc_entrypoint=cli; cch=fffff;",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    // The cch=fffff is almost certainly not the correct hash
    expect(validateSeed(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: capture → build → sign
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  test("capture → build → sign produces a valid signed body", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );

    const userMsg = "Summarize this conversation.";
    const block = buildBillingBlock(SID_A, userMsg);
    expect(block).not.toBeNull();

    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: [block, { type: "text", text: "You are a distillation worker." }],
      messages: [{ role: "user", content: userMsg }],
    });

    expect(body).toContain("cch=00000");

    const signed = signBody(body);
    expect(signed).not.toContain("cch=00000");
    expect(signed).toMatch(/cch=[0-9a-f]{5};/);

    const parsed = JSON.parse(signed);
    expect(parsed.system[0].text).toMatch(/cch=[0-9a-f]{5};/);
    expect(parsed.system[0].text).toContain(`cc_version=${WORKER_VERSION}.`);
  });

  test("signed body validates against our seed", () => {
    captureBillingPrefix(
      SID_A,
      "x-anthropic-billing-header: cc_version=2.1.138.fbe; cc_entrypoint=cli; cch=a39d0;",
    );

    const userMsg = "Analyze these highlights.";
    const block = buildBillingBlock(SID_A, userMsg);

    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: [block],
      messages: [{ role: "user", content: userMsg }],
    });

    const signed = signBody(body);
    expect(validateSeed(signed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resignBody
// ---------------------------------------------------------------------------

describe("resignBody", () => {
  /** Helper: build a serialized body with a client-signed billing header. */
  function buildClientBody(
    opts: {
      clientVersion?: string;
      clientCch?: string;
      userMessage?: string;
    } = {},
  ): string {
    const version = opts.clientVersion ?? "2.1.35.abc";
    const cch = opts.clientCch ?? "deadb";
    const user = opts.userMessage ?? "Tell me about TypeScript generics";
    return JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=cli; cch=${cch};`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          type: "text",
          text: "You are a helpful assistant.",
        },
      ],
      messages: [{ role: "user", content: user }],
    });
  }

  test("returns body unchanged when no billing header is present", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: "plain system prompt",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(resignBody(body, "hello")).toBe(body);
  });

  test("replaces client cch with a valid worker-signed cch", () => {
    const original = buildClientBody({ clientCch: "deadb" });
    const resigned = resignBody(original, "Tell me about TypeScript generics");

    // Client's cch should be gone
    expect(resigned).not.toContain("cch=deadb");
    // New cch should be a 5-char hex value
    expect(resigned).toMatch(/cch=[0-9a-f]{5};/);
    // Should not contain placeholder
    expect(resigned).not.toContain("cch=00000");
  });

  test("replaces cc_version with worker version + computed suffix", () => {
    const original = buildClientBody({ clientVersion: "2.1.35.abc" });
    const resigned = resignBody(original, "Tell me about TypeScript generics");

    // Client's version should be replaced
    expect(resigned).not.toContain("cc_version=2.1.35.abc");
    // Worker version should be present with a 3-char hex suffix
    expect(resigned).toMatch(
      new RegExp(`cc_version=${WORKER_VERSION}\\.[0-9a-f]{3};`),
    );
  });

  test("suffix depends on the first user message", () => {
    const body1 = buildClientBody({ clientCch: "aaaaa" });
    const body2 = buildClientBody({
      clientCch: "aaaaa",
      userMessage: "Completely different user message here!",
    });

    const resigned1 = resignBody(body1, "Tell me about TypeScript generics");
    const resigned2 = resignBody(
      body2,
      "Completely different user message here!",
    );

    // Different user messages produce different suffixes
    const suffix1 = resigned1.match(
      new RegExp(`cc_version=${WORKER_VERSION}\\.([0-9a-f]{3});`),
    )?.[1];
    const suffix2 = resigned2.match(
      new RegExp(`cc_version=${WORKER_VERSION}\\.([0-9a-f]{3});`),
    )?.[1];

    expect(suffix1).toBeDefined();
    expect(suffix2).toBeDefined();
    expect(suffix1).not.toBe(suffix2);
  });

  test("resigned body passes validateSeed", () => {
    const original = buildClientBody({ clientCch: "12345" });
    const resigned = resignBody(original, "Tell me about TypeScript generics");

    // The re-signed body should validate with our known seed
    expect(validateSeed(resigned)).toBe(true);
  });

  test("produces same result as signing from scratch", () => {
    // Build a body the same way buildBillingBlock + signBody would
    const userMessage = "Tell me about TypeScript generics";
    const suffix = _computeVersionSuffix(userMessage);

    const freshBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.${suffix}; cc_entrypoint=cli; cch=00000;`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          type: "text",
          text: "You are a helpful assistant.",
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });
    const signedFresh = signBody(freshBody);

    // Now build same body as if client sent it with wrong version/cch, then resign
    const clientBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.${suffix}; cc_entrypoint=cli; cch=99999;`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          type: "text",
          text: "You are a helpful assistant.",
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });
    const resigned = resignBody(clientBody, userMessage);

    // Both should produce identical output since version+suffix are the same
    expect(resigned).toBe(signedFresh);
  });

  test("handles empty first user message gracefully", () => {
    const original = buildClientBody({ clientCch: "abcde" });
    const resigned = resignBody(original, "");

    expect(resigned).not.toContain("cch=abcde");
    expect(resigned).toMatch(/cch=[0-9a-f]{5};/);
    expect(validateSeed(resigned)).toBe(true);
  });

  test("handles short first user message (fewer than 21 chars)", () => {
    const original = buildClientBody({ clientCch: "abcde", userMessage: "hi" });
    const resigned = resignBody(original, "hi");

    expect(resigned).not.toContain("cch=abcde");
    expect(resigned).toMatch(/cch=[0-9a-f]{5};/);
    expect(validateSeed(resigned)).toBe(true);
  });

  test("does NOT rewrite a cch=XXXXX; token in content (cache-bust regression)", () => {
    // A conversation turn whose LTM/system or message content contains a
    // `cch=XXXXX;` token must keep that token byte-for-byte across re-signing,
    // otherwise the cached prefix changes every turn.
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.35.abc; cc_entrypoint=cli; cch=deadb;",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          type: "text",
          // Content token with the exact 5-hex-plus-semicolon shape.
          text: "gotcha: CCH_IN_BODY_RE = /cch=([0-9a-fA-F]{5});/ matched cch=2d825; here",
        },
      ],
      messages: [{ role: "user", content: "explain caching" }],
    });

    const resigned = resignBody(body, "explain caching");
    // Content token preserved verbatim.
    expect(resigned).toContain("cch=2d825;");
    // Billing header re-signed (client value gone, valid worker hash present).
    expect(resigned).not.toContain("cch=deadb");
    expect(validateSeed(resigned)).toBe(true);
    // Re-signing twice is idempotent for the content token (stable prefix).
    expect(resignBody(resigned, "explain caching")).toContain("cch=2d825;");
  });

  test("leaves the body unchanged when only content cch= tokens exist (no billing header)", () => {
    // No billing header present — resignBody must be a pure no-op even though
    // content contains cch= tokens.
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      system: [{ type: "text", text: "note: `cch=12345` and cch=67890;" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resignBody(body, "hi")).toBe(body);
  });

  test("ignores a content `cc_entrypoint=…; cch=…;` fragment that sorts BEFORE the header", () => {
    // Reviewer #1: an LTM entry documenting the header format (containing
    // `cc_entrypoint=cli; cch=…;`) serialized before the real header must NOT
    // steal the rewrite. Fragment-anchoring was defeated by exactly this.
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      system: [
        {
          type: "text",
          // Looks like a header fragment but lacks the full sentinel prefix.
          text: "gotcha doc: format is `cc_entrypoint=cli; cch=aaaaa;` — note the suffix",
        },
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.35.abc; cc_entrypoint=cli; cch=deadb;",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: "explain caching" }],
    });

    const resigned = resignBody(body, "explain caching");
    // The documented fragment is preserved verbatim.
    expect(resigned).toContain("`cc_entrypoint=cli; cch=aaaaa;`");
    // Only the real header was re-signed.
    expect(resigned).not.toContain("cch=deadb");
    expect(validateSeed(resigned)).toBe(true);
    // Stable across turns: the content fragment never changes.
    expect(resignBody(resigned, "explain caching")).toContain(
      "`cc_entrypoint=cli; cch=aaaaa;`",
    );
  });

  test("ignores a content `cc_version=…;` token that sorts BEFORE the header (reviewer #2)", () => {
    // Reviewer #2: the cc_version rewrite was fully unanchored. A content
    // `cc_version=2.1.35.abc;` before the header must be left untouched, else
    // it is rewritten every turn → cache bust.
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      system: [
        {
          type: "text",
          text: "changelog: bumped cc_version=2.1.35.abc; in the client header",
        },
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.35.abc; cc_entrypoint=cli; cch=deadb;",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: "explain caching" }],
    });

    const resigned = resignBody(body, "explain caching");
    // The content cc_version token is preserved verbatim (NOT rewritten to
    // the worker version).
    expect(resigned).toContain(
      "changelog: bumped cc_version=2.1.35.abc; in the client header",
    );
    // The header's cc_version WAS rewritten to the worker version.
    expect(resigned).toMatch(
      new RegExp(
        `x-anthropic-billing-header: cc_version=${WORKER_VERSION}\\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};`,
      ),
    );
    expect(validateSeed(resigned)).toBe(true);
    // Idempotent: content token stays stable across re-signs.
    expect(resignBody(resigned, "explain caching")).toContain(
      "changelog: bumped cc_version=2.1.35.abc; in the client header",
    );
  });

  test("preserves a non-default cc_entrypoint value", () => {
    // The single-pass rewrite must keep cc_entrypoint verbatim.
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.35.abc; cc_entrypoint=vscode; cch=deadb;",
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const resigned = resignBody(body, "hi");
    expect(resigned).toContain("cc_entrypoint=vscode;");
    expect(validateSeed(resigned)).toBe(true);
  });

  test("the real header (first system block) wins over a full-sentinel doc block after it", () => {
    // Review #1 residual: even if an LTM entry reproduces the WHOLE sentinel,
    // the real header is always system[0] and nothing serializes before it, so
    // first-match targets the real header. The doc block (which carries a
    // placeholder) is left as-is.
    const body = JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.35.abc; cc_entrypoint=cli; cch=deadb;",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          type: "text",
          // LTM doc reproducing the full sentinel with the placeholder.
          text: "docs: header looks like `x-anthropic-billing-header: cc_version=2.1.0.aaa; cc_entrypoint=cli; cch=00000;`",
        },
      ],
      messages: [{ role: "user", content: "explain caching" }],
    });
    const resigned = resignBody(body, "explain caching");
    // The doc block's placeholder is untouched (still 00000).
    expect(resigned).toContain(
      "`x-anthropic-billing-header: cc_version=2.1.0.aaa; cc_entrypoint=cli; cch=00000;`",
    );
    // The real header was re-signed and validates.
    expect(resigned).not.toContain("cch=deadb");
    expect(validateSeed(resigned)).toBe(true);
  });

  test("re-signs a client header WITHOUT a 3-hex version suffix (no silent skip → no 401)", () => {
    // Review #2: a suffix-less header must still re-sign rather than pass the
    // stale client cch through (which upstream rejects).
    const body = JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.165; cc_entrypoint=cli; cch=deadb;",
        },
      ],
      messages: [{ role: "user", content: "hi there friend" }],
    });
    const resigned = resignBody(body, "hi there friend");
    expect(resigned).not.toContain("cch=deadb");
    expect(resigned).toMatch(
      new RegExp(
        `cc_version=${WORKER_VERSION}\\.[0-9a-f]{3}; cc_entrypoint=cli;`,
      ),
    );
    expect(validateSeed(resigned)).toBe(true);
  });

  test("re-signs a client header with an UPPERCASE version suffix and cch", () => {
    // Review #3: casing tolerance — uppercase suffix/cch must not silently skip.
    const body = JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.163.7C7; cc_entrypoint=cli; cch=DEADB;",
        },
      ],
      messages: [{ role: "user", content: "hi there friend" }],
    });
    const resigned = resignBody(body, "hi there friend");
    expect(resigned).not.toContain("cch=DEADB");
    expect(resigned).toMatch(
      new RegExp(`cc_version=${WORKER_VERSION}\\.[0-9a-f]{3};`),
    );
    expect(validateSeed(resigned)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// First-block invariant verification (Sentry early-warning)
// ---------------------------------------------------------------------------

describe("billing-header first-block invariant", () => {
  /** Capture warnings emitted via the core log sink. */
  let warnings: string[];

  /** Silent sink restored after each test so we don't leak capture into
   *  other test files sharing the (global) log sink. */
  const silentSink = {
    info: () => {},
    warn: () => {},
    error: () => {},
    captureException: () => {},
  };

  beforeEach(() => {
    warnings = [];
    log.registerSink({
      info: () => {},
      warn: (msg) => warnings.push(msg),
      error: () => {},
      captureException: () => {},
    });
  });

  afterEach(() => {
    log.registerSink(silentSink);
  });

  /** Build a body with the real billing header as the FIRST system block. */
  const headerFirst = (extraBlocks: string[] = []) =>
    JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.165.abc; cc_entrypoint=cli; cch=00000;",
        },
        ...extraBlocks.map((text) => ({ type: "text", text })),
      ],
      messages: [{ role: "user", content: "hi" }],
    });

  test("does NOT warn when the billing header is the first occurrence (signBody)", () => {
    signBody(headerFirst(["docs: `cch=00000` example"]));
    expect(warnings).toHaveLength(0);
  });

  test("WARNS when content reproduces the FULL sentinel, even sorted after the real header", () => {
    // Conservative invariant: any second `x-anthropic-billing-header:` marker is
    // a hazard. Signing still succeeds (real header is first), but we surface it
    // because we can't robustly guarantee first-match hit the real one.
    signBody(
      headerFirst([
        "docs: `x-anthropic-billing-header: cc_version=2.1.0.aaa; cc_entrypoint=cli; cch=00000;`",
      ]),
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("billing-header markers");
  });

  test("WARNS when content reproduces a cch-LESS full sentinel after the real header (issue #807)", () => {
    // The cch-optional regexes (issue #807) widen the matchable surface: a
    // cch-less full sentinel in content is now a second marker. Signing still
    // targets the real header (first block), but the duplicate must surface the
    // early-warning rather than silently risk a wrong-token sign / cache bust.
    signBody(
      headerFirst([
        "docs: `x-anthropic-billing-header: cc_version=2.1.0.aaa; cc_entrypoint=cli;`",
      ]),
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("billing-header markers");
  });

  test("does NOT warn when content has a cch= token but NOT the full sentinel", () => {
    // A bare `cch=00000` / `cc_entrypoint=…` fragment in content is NOT a
    // duplicate marker, so it must not trip the guard (no false positives on
    // the common case — e.g. the LTM entry from the original incident).
    signBody(
      headerFirst([
        "gotcha: CCH_PLACEHOLDER = `cch=00000`; cc_entrypoint=cli appears here",
      ]),
    );
    expect(warnings).toHaveLength(0);
  });

  test("WARNS when a sentinel-shaped block serializes BEFORE the real header (signBody)", () => {
    // Simulates the dangerous reorder: a content block reproducing the full
    // sentinel is placed first, the real header second. first-match would
    // target the content block → cache-bust risk → must alert.
    const body = JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.0.aaa; cc_entrypoint=cli; cch=00000;",
        },
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.165.abc; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    signBody(body);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("first-block invariant violated");
    expect(warnings[0]).toContain("signBody");
  });

  test("WARNS when a sentinel-shaped block serializes BEFORE the real header (resignBody)", () => {
    const body = JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.0.aaa; cc_entrypoint=cli; cch=aaaaa;",
        },
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.165.abc; cc_entrypoint=cli; cch=bbbbb;",
        },
      ],
      messages: [{ role: "user", content: "hi there friend" }],
    });
    resignBody(body, "hi there friend");
    expect(
      warnings.some((w) => w.includes("first-block invariant violated")),
    ).toBe(true);
    expect(warnings.some((w) => w.includes("resignBody"))).toBe(true);
  });

  test("does NOT warn for a no-billing-header body", () => {
    signBody('{"system":[{"type":"text","text":"no header here"}]}');
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hasBillingHeader — the pipeline re-sign gate
// ---------------------------------------------------------------------------

describe("hasBillingHeader (re-sign gate)", () => {
  // The conversation-turn re-sign path (pipeline.ts forwardToUpstream) gates
  // resignBody on hasBillingHeader(req.system). This is the predicate that
  // distinguishes a REAL Claude Code OAuth session (header at system[0]) from
  // an api-key session whose CONTENT merely quotes the sentinel. The `^` anchor
  // is load-bearing: without the gate, content-quoted sentinels are content-
  // matched by resignBody, rewritten every turn, and trip the invariant warning.
  const REAL_HEADER =
    "x-anthropic-billing-header: cc_version=2.1.175.abc; cc_entrypoint=cli; cch=1a2b3;";

  test("true when the real billing header is at the START of the system prompt", () => {
    expect(hasBillingHeader(REAL_HEADER)).toBe(true);
    // The real header is system[0]; subsequent host-prompt text follows it.
    expect(hasBillingHeader(`${REAL_HEADER}\nYou are Claude Code.`)).toBe(true);
  });

  test("false when the sentinel is quoted in content (not at offset 0)", () => {
    // The api-key user's scenario: editing cch.ts / cch.test.ts injects the
    // sentinel verbatim into message/system content, but never at system[0].
    expect(
      hasBillingHeader(`You are Claude Code.\n\nExample: ${REAL_HEADER}`),
    ).toBe(false);
    expect(hasBillingHeader(`Help me edit this code: ${REAL_HEADER}`)).toBe(
      false,
    );
  });

  test("false for a system prompt with no billing header at all", () => {
    expect(hasBillingHeader("You are a helpful assistant.")).toBe(false);
    expect(hasBillingHeader("")).toBe(false);
  });

  // The pipeline gate is `hasBillingHeader(req.system) && resignBody(body, …)`.
  // These two tests exercise that exact chain at a level where the cch rewrite
  // is observable (the e2e replay harness intercepts the PRE-resign body object,
  // so it cannot witness the rewrite — only the absence of the warning). They
  // assert the gate's decision drives the correct resign outcome.
  //
  // `applyGate` mirrors pipeline.ts forwardToUpstream exactly: re-sign only when
  // the real header is at system[0].
  const applyGate = (
    system: string,
    serializedBody: string,
    firstUser: string,
  ) =>
    hasBillingHeader(system)
      ? resignBody(serializedBody, firstUser)
      : serializedBody;

  test("gate PASSES for a real OAuth header → body is re-signed to a valid worker cch", () => {
    // req.system is the string with the header at offset 0 (Claude Code OAuth).
    const system =
      "x-anthropic-billing-header: cc_version=2.1.0.aaa; cc_entrypoint=cli; cch=00000;\nYou are Claude Code.";
    // The serialized body carries the same header (as system[0].text) with the
    // client's placeholder cch.
    const serializedBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const out = applyGate(system, serializedBody, "hi");

    expect(out).not.toBe(serializedBody); // re-signing happened
    expect(out).not.toContain("cch=00000"); // placeholder rewritten
    expect(out).toMatch(
      new RegExp(`cc_version=${WORKER_VERSION}\\.[0-9a-f]{3};`),
    );
    expect(validateSeed(out)).toBe(true); // valid worker signature
  });

  test("gate SKIPS for an api-key session whose content quotes the sentinel → body untouched", () => {
    // req.system is the host prompt (NO header at offset 0); the sentinel only
    // appears inside message content.
    const system = "You are a helpful assistant.";
    const quoted =
      "x-anthropic-billing-header: cc_version=2.1.0.aaa; cc_entrypoint=cli; cch=1a2b3;";
    const serializedBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: [{ type: "text", text: system }],
      messages: [
        { role: "user", content: [{ type: "text", text: `Edit: ${quoted}` }] },
      ],
    });

    const out = applyGate(system, serializedBody, `Edit: ${quoted}`);

    expect(out).toBe(serializedBody); // untouched — gate skipped resignBody
    expect(out).toContain("cch=1a2b3;"); // quoted content cch preserved
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  test("WORKER_VERSION is a semver string", () => {
    expect(WORKER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("WORKER_SEED is a non-zero bigint", () => {
    expect(typeof WORKER_SEED).toBe("bigint");
    expect(WORKER_SEED).not.toBe(0n);
  });

  test("WORKER_SALT is a 12-char hex string", () => {
    expect(WORKER_SALT).toMatch(/^[0-9a-f]{12}$/);
  });

  test("CCH_PLACEHOLDER is the expected sentinel", () => {
    expect(CCH_PLACEHOLDER).toBe("cch=00000");
  });

  test("VERSION_SEEDS contains known historical seeds", () => {
    // Permanent regression anchors — these versions will always exist
    expect(VERSION_SEEDS["2.1.37"]).toBe(0x6e52736ac806831en);
    expect(VERSION_SEEDS["2.1.138"]).toBe(0x4d659218e32a3268n);
  });

  test("VERSION_SEEDS has at least 2 entries, all non-zero bigints", () => {
    const entries = Object.entries(VERSION_SEEDS);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const [_version, seed] of entries) {
      expect(typeof seed).toBe("bigint");
      expect(seed).not.toBe(0n);
    }
  });

  test("WORKER_VERSION is a key in VERSION_SEEDS", () => {
    expect(Object.keys(VERSION_SEEDS)).toContain(WORKER_VERSION);
    expect(VERSION_SEEDS[WORKER_VERSION]).not.toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// resolveSeed — fallback logic for unknown versions
// ---------------------------------------------------------------------------

describe("resolveSeed", () => {
  // Derive known versions sorted ascending so tests adapt to any VERSION_SEEDS
  const knownVersions = Object.keys(VERSION_SEEDS)
    .map((v) => ({ version: v, parsed: _parseSemver(v) }))
    .filter(
      (e): e is { version: string; parsed: [number, number, number] } =>
        e.parsed !== null,
    )
    .sort((a, b) => _compareSemver(a.parsed, b.parsed));

  const oldest = knownVersions[0];
  const latest = knownVersions[knownVersions.length - 1];

  test("returns exact match for every known version", () => {
    for (const { version } of knownVersions) {
      const result = resolveSeed(version);
      expect(result.exact).toBe(true);
      expect(result.version).toBe(version);
      expect(result.seed).toBe(VERSION_SEEDS[version]);
    }
  });

  test("falls back to closest version for a synthetic unknown version", () => {
    // Construct a version just above the latest — guaranteed unknown
    const [maj, min, patch] = latest.parsed;
    const nearFuture = `${maj}.${min}.${patch + 2}`;
    const result = resolveSeed(nearFuture);
    expect(result.exact).toBe(false);
    expect(result.version).toBe(latest.version);
    expect(result.seed).toBe(VERSION_SEEDS[latest.version]);
  });

  test("falls back to latest for a much newer unknown version", () => {
    const [maj] = latest.parsed;
    const result = resolveSeed(`${maj + 1}.0.0`);
    expect(result.exact).toBe(false);
    expect(result.version).toBe(latest.version);
  });

  test("falls back to closest known version, not necessarily latest", () => {
    if (knownVersions.length < 2) return; // need at least 2 seeds
    // Construct a version 1 patch above the oldest — closer to oldest than latest
    const [maj, min, patch] = oldest.parsed;
    const nearOldest = `${maj}.${min}.${patch + 1}`;
    // Only test if nearOldest isn't itself a known version
    if (!VERSION_SEEDS[nearOldest]) {
      const result = resolveSeed(nearOldest);
      expect(result.exact).toBe(false);
      expect(result.version).toBe(oldest.version);
    }
  });

  test("falls back to oldest for a much older unknown version", () => {
    const result = resolveSeed("1.0.0");
    expect(result.exact).toBe(false);
    expect(result.version).toBe(oldest.version);
  });

  test("falls back to latest for an unparseable version string", () => {
    const result = resolveSeed("not-a-version");
    expect(result.exact).toBe(false);
    expect(result.version).toBe(latest.version);
  });

  test("falls back to latest for an empty version string", () => {
    const result = resolveSeed("");
    expect(result.exact).toBe(false);
    expect(result.version).toBe(latest.version);
  });
});

// ---------------------------------------------------------------------------
// parseSemver / compareSemver helpers
// ---------------------------------------------------------------------------

describe("semver helpers", () => {
  test("parseSemver parses valid semver", () => {
    expect(_parseSemver("2.1.138")).toEqual([2, 1, 138]);
    expect(_parseSemver("0.0.1")).toEqual([0, 0, 1]);
  });

  test("parseSemver returns null for invalid input", () => {
    expect(_parseSemver("not-valid")).toBeNull();
    expect(_parseSemver("2.1")).toBeNull();
    expect(_parseSemver("")).toBeNull();
    expect(_parseSemver("2.1.138.4")).toBeNull();
  });

  test("compareSemver orders correctly", () => {
    expect(_compareSemver([2, 1, 138], [2, 1, 37])).toBeGreaterThan(0);
    expect(_compareSemver([2, 1, 37], [2, 1, 138])).toBeLessThan(0);
    expect(_compareSemver([2, 1, 138], [2, 1, 138])).toBe(0);
    expect(_compareSemver([3, 0, 0], [2, 1, 138])).toBeGreaterThan(0);
    expect(_compareSemver([2, 0, 0], [2, 1, 0])).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Known-good values from Claude Code binary analysis
// ---------------------------------------------------------------------------

describe("binary-verified values", () => {
  test("suffix for 'hello' is deterministic and valid hex", () => {
    // The suffix depends on WORKER_VERSION, so we verify format and determinism
    // rather than a specific value that changes with each version bump.
    const suffix = _computeVersionSuffix("hello");
    expect(suffix).toMatch(/^[0-9a-f]{3}$/);
    expect(_computeVersionSuffix("hello")).toBe(suffix);
  });

  test("reproduces a real cch captured from the Claude Code binary", () => {
    // Ground-truth known-answer test. The fixture is a real request body
    // (with cch=00000) captured from the Claude Code 2.1.163 binary at the
    // sendto(2) syscall, plus the cch that binary actually emitted. This is the
    // ONLY test that pins our hash to a value produced by the real binary — a
    // self-consistency sign/verify roundtrip would pass with ANY PRIME64_4, so
    // it would not catch a regression to the canonical constant. If this fails
    // after touching xxhash.ts, the PRIME64_4 tweak was likely reverted.
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./cch-oracle.fixture.json", import.meta.url)),
        "utf-8",
      ),
    ) as { seedHex: string; cch: string; bodyBase64: string };

    const seed = BigInt(fixture.seedHex);
    // Hash the EXACT bytes (the body contains multibyte UTF-8), never a string
    // round-trip.
    const body = Buffer.from(fixture.bodyBase64, "base64");
    expect(body.includes(Buffer.from("cch=00000"))).toBe(true);

    const computed = (xxHash64(new Uint8Array(body), seed) & 0xfffffn)
      .toString(16)
      .padStart(5, "0");
    expect(computed).toBe(fixture.cch);

    // And the seed for that version resolves to the captured seed.
    expect(VERSION_SEEDS["2.1.163"]).toBe(seed);
  });

  test("reproduces a real cch from Claude Code 2.1.175 (preimage transform)", () => {
    // Ground-truth known-answer test for the >= 2.1.172 preimage change. The
    // fixture is a RAW wire body (model value + max_tokens present) captured
    // from the real 2.1.175 binary, with cch=00000, plus the cch the binary
    // emitted. Hashing the raw body directly does NOT reproduce it — only
    // hashing cchPreimage(body) (model value + max_tokens stripped) does. This
    // pins the transform against the real binary; if it fails after touching
    // cchPreimage/xxhash, the strip rules or PRIME64_4 likely regressed.
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("./cch-oracle-2.1.175.fixture.json", import.meta.url),
        ),
        "utf-8",
      ),
    ) as { seedHex: string; cch: string; bodyBase64: string };

    const seed = BigInt(fixture.seedHex);
    // Hash the EXACT bytes (the body has multibyte UTF-8); never a string
    // round-trip — `xxHash64(string)` UTF-8-encodes, which corrupts a latin1
    // reconstruction. The edited fields (model/max_tokens) are pure ASCII, so a
    // latin1 round-trip is byte-safe for applying the transform itself.
    const rawBytes = Buffer.from(fixture.bodyBase64, "base64");
    const rawLatin1 = rawBytes.toString("latin1");
    expect(rawLatin1).toContain("cch=00000");
    // The raw body still has model value + max_tokens (the wire form)...
    expect(rawLatin1).toMatch(/"model":"[^"]+"/);
    expect(rawLatin1).toMatch(/"max_tokens":\d+/);

    // Hashing the RAW body does NOT match (proves the transform is required).
    const rawHash = (xxHash64(new Uint8Array(rawBytes), seed) & 0xfffffn)
      .toString(16)
      .padStart(5, "0");
    expect(rawHash).not.toBe(fixture.cch);

    // Hashing the PREIMAGE (model value + max_tokens stripped) reproduces it.
    const preimageBytes = Buffer.from(_cchPreimage(rawLatin1), "latin1");
    const preimageLatin1 = preimageBytes.toString("latin1");
    expect(preimageLatin1).toMatch(/"model":""/);
    expect(preimageLatin1).not.toContain("max_tokens");
    const computed = (xxHash64(new Uint8Array(preimageBytes), seed) & 0xfffffn)
      .toString(16)
      .padStart(5, "0");
    expect(computed).toBe(fixture.cch);

    // And the seed for that version resolves to the captured seed.
    expect(VERSION_SEEDS["2.1.175"]).toBe(seed);
  });

  test("2.1.138 seed signs correctly (round-trip)", () => {
    const seed = VERSION_SEEDS["2.1.138"];
    expect(seed).toBeDefined();
    expect(seed).not.toBe(0n);

    // Sign a test body with the 2.1.138 seed and verify round-trip
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.138.470; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    const signed = signBody(body);
    expect(signed).not.toContain("cch=00000");
    expect(validateSeed(signed)).toBe(true);
  });

  test("validateSeed accepts bodies signed with either known seed", () => {
    // Sign with current WORKER_SEED
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.abc; cc_entrypoint=cli; cch=00000;`,
        },
      ],
      messages: [{ role: "user", content: "test" }],
    });
    const signed = signBody(body);
    expect(validateSeed(signed)).toBe(true);

    // Sign same body shape with the oldest known seed (2.1.37)
    const oldSeed = VERSION_SEEDS["2.1.37"];
    const body2 = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.37.def; cc_entrypoint=cli; cch=00000;",
        },
      ],
      messages: [{ role: "user", content: "test" }],
    });
    const hash = xxHash64(body2, oldSeed);
    const cch = (hash & 0xfffffn).toString(16).padStart(5, "0");
    const signedOld = body2.replace("cch=00000", `cch=${cch}`);
    expect(validateSeed(signedOld)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// captureSessionHeaders + buildOAuthWorkerHeaders
// ---------------------------------------------------------------------------

const BILLING_SYSTEM =
  "x-anthropic-billing-header: cc_version=2.1.152.e9a; cc_entrypoint=cli; cch=abcde;";

describe("captureSessionHeaders", () => {
  test("is a no-op for non-billing sessions", () => {
    captureSessionHeaders("non-billing-sess", {
      "anthropic-beta": "some-beta",
      "user-agent": "some-agent",
    });
    // buildOAuthWorkerHeaders should return null since session has no billing
    expect(buildOAuthWorkerHeaders("non-billing-sess")).toBeNull();
  });

  test("captures headers for billing sessions", () => {
    // First register as a billing session
    captureBillingPrefix(SID_A, BILLING_SYSTEM);

    // Then capture headers
    captureSessionHeaders(SID_A, {
      "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
      "user-agent": "claude-cli/2.1.152 (external, sdk-cli)",
    });

    const headers = buildOAuthWorkerHeaders(SID_A);
    expect(headers).not.toBeNull();
    expect(headers?.["anthropic-beta"]).toBe(
      "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    );
    expect(headers?.["user-agent"]).toBe(
      "claude-cli/2.1.152 (external, sdk-cli)",
    );
  });

  test("captures partial headers (only anthropic-beta present)", () => {
    captureBillingPrefix(SID_A, BILLING_SYSTEM);
    captureSessionHeaders(SID_A, {
      "anthropic-beta": "oauth-2025-04-20",
    });

    const headers = buildOAuthWorkerHeaders(SID_A);
    expect(headers).not.toBeNull();
    expect(headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
    // user-agent should fall back to default
    expect(headers?.["user-agent"]).toContain("claude-cli/");
  });

  test("works on the first turn (captureBillingPrefix sets flag before captureSessionHeaders reads it)", () => {
    // Simulate first-turn ordering: captureBillingPrefix then captureSessionHeaders
    captureBillingPrefix(SID_A, BILLING_SYSTEM);
    captureSessionHeaders(SID_A, {
      "anthropic-beta": "first-turn-beta",
      "user-agent": "first-turn-ua",
    });

    const headers = buildOAuthWorkerHeaders(SID_A);
    expect(headers).not.toBeNull();
    expect(headers?.["anthropic-beta"]).toBe("first-turn-beta");
    expect(headers?.["user-agent"]).toBe("first-turn-ua");
  });
});

describe("buildOAuthWorkerHeaders", () => {
  test("returns null when sessionID is undefined", () => {
    expect(buildOAuthWorkerHeaders(undefined)).toBeNull();
  });

  test("returns null for API-key sessions (no billing)", () => {
    expect(buildOAuthWorkerHeaders("unknown-sess")).toBeNull();
  });

  test("uses fallback betas when no snapshot exists", () => {
    // Register as billing session but don't capture headers
    captureBillingPrefix(SID_A, BILLING_SYSTEM);

    const headers = buildOAuthWorkerHeaders(SID_A);
    expect(headers).not.toBeNull();
    expect(headers?.["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(headers?.["anthropic-beta"]).toContain(
      "extended-cache-ttl-2025-04-11",
    );
    expect(headers?.["anthropic-beta"]).toContain(
      "prompt-caching-scope-2026-01-05",
    );
    expect(headers?.["user-agent"]).toContain("claude-cli/");
  });

  test("includes required OAuth headers", () => {
    captureBillingPrefix(SID_A, BILLING_SYSTEM);

    const headers = buildOAuthWorkerHeaders(SID_A);
    expect(headers).not.toBeNull();
    expect(headers?.["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers?.["x-client-request-id"]).toBeDefined();
    // UUID format
    expect(headers?.["x-client-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("generates unique x-client-request-id per call", () => {
    captureBillingPrefix(SID_A, BILLING_SYSTEM);

    const h1 = buildOAuthWorkerHeaders(SID_A);
    const h2 = buildOAuthWorkerHeaders(SID_A);
    expect(h1).toBeDefined();
    expect(h2).toBeDefined();
    expect(h1?.["x-client-request-id"]).not.toBe(h2?.["x-client-request-id"]);
  });

  test("sessions are isolated — different sessions get different headers", () => {
    captureBillingPrefix(SID_A, BILLING_SYSTEM);
    captureBillingPrefix(SID_B, BILLING_SYSTEM);

    captureSessionHeaders(SID_A, { "anthropic-beta": "beta-a" });
    captureSessionHeaders(SID_B, { "anthropic-beta": "beta-b" });

    expect(buildOAuthWorkerHeaders(SID_A)?.["anthropic-beta"]).toBe("beta-a");
    expect(buildOAuthWorkerHeaders(SID_B)?.["anthropic-beta"]).toBe("beta-b");
  });
});

describe("deleteBillingPrefix clears header snapshots", () => {
  test("removes both billing flag and header snapshot", () => {
    captureBillingPrefix(SID_A, BILLING_SYSTEM);
    captureSessionHeaders(SID_A, { "anthropic-beta": "test-beta" });

    // Before deletion: returns headers
    expect(buildOAuthWorkerHeaders(SID_A)).not.toBeNull();

    // Delete
    deleteBillingPrefix(SID_A);

    // After deletion: returns null
    expect(buildOAuthWorkerHeaders(SID_A)).toBeNull();
  });
});

describe("captureSessionHeaders — Codex (ChatGPT) headers", () => {
  test("captures Codex headers for ANY session (no billing flag needed)", () => {
    captureSessionHeaders("codex-sess", {
      "chatgpt-account-id": "acct-xyz",
      originator: "pi",
      "openai-beta": "responses=experimental",
    });

    const headers = buildCodexWorkerHeaders("codex-sess");
    expect(headers).not.toBeNull();
    expect(headers?.["chatgpt-account-id"]).toBe("acct-xyz");
    expect(headers?.originator).toBe("pi");
    expect(headers?.["OpenAI-Beta"]).toBe("responses=experimental");
    expect(headers?.session_id).toBe("codex-sess");
    expect(headers?.["x-client-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("preserves previously-captured headers across turns (merge, not wipe)", () => {
    // Turn 1 carries the full Codex fingerprint.
    captureSessionHeaders("codex-sess", {
      "chatgpt-account-id": "acct-xyz",
      originator: "pi",
      "openai-beta": "responses=experimental",
    });
    // Turn 2 omits some headers — must NOT clear the earlier capture.
    captureSessionHeaders("codex-sess", { "chatgpt-account-id": "acct-xyz" });

    const headers = buildCodexWorkerHeaders("codex-sess");
    expect(headers?.originator).toBe("pi");
    expect(headers?.["OpenAI-Beta"]).toBe("responses=experimental");
  });

  test("does not regress the Anthropic billing path for billing sessions", () => {
    captureBillingPrefix(SID_A, BILLING_SYSTEM);
    captureSessionHeaders(SID_A, {
      "anthropic-beta": "beta-x",
      "user-agent": "ua-x",
      // A billing session that also (hypothetically) carries a codex header.
      "chatgpt-account-id": "acct-mixed",
    });

    // Anthropic replay still works...
    expect(buildOAuthWorkerHeaders(SID_A)?.["anthropic-beta"]).toBe("beta-x");
    // ...and the codex header is independently available.
    expect(buildCodexWorkerHeaders(SID_A)?.["chatgpt-account-id"]).toBe(
      "acct-mixed",
    );
  });
});

describe("buildCodexWorkerHeaders", () => {
  test("returns null when sessionID is undefined", () => {
    expect(buildCodexWorkerHeaders(undefined)).toBeNull();
  });

  test("returns null when no Codex account-id was observed", () => {
    // A session with no Codex headers (or only originator) yields nothing —
    // a loud failure is correct over a malformed call.
    captureSessionHeaders("codex-sess", { originator: "pi" });
    expect(buildCodexWorkerHeaders("codex-sess")).toBeNull();
  });

  test("generates a unique x-client-request-id per call", () => {
    captureSessionHeaders("codex-sess", { "chatgpt-account-id": "acct-xyz" });
    const h1 = buildCodexWorkerHeaders("codex-sess");
    const h2 = buildCodexWorkerHeaders("codex-sess");
    expect(h1?.["x-client-request-id"]).not.toBe(h2?.["x-client-request-id"]);
  });
});

// ---------------------------------------------------------------------------
// cch-less billing header (issue #807)
// ---------------------------------------------------------------------------

describe("cch-less billing header (issue #807)", () => {
  // Claude Code >= 2.1.181 only emits the `cch` field when it believes it is
  // talking to the first-party API. A client launched WITHOUT
  // _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 (i.e. not via `lore run`/`lore
  // setup`) sends a billing header whose `cch=…;` segment is entirely absent.
  // The gateway must still detect it, mark the OAuth session, and inject +
  // sign a placeholder when re-signing.
  const CCHLESS_HEADER =
    "x-anthropic-billing-header: cc_version=2.1.181.abc; cc_entrypoint=cli;";
  const CCH_HEADER =
    "x-anthropic-billing-header: cc_version=2.1.181.abc; cc_entrypoint=cli; cch=1a2b3;";

  // (a) Detection -----------------------------------------------------------

  test("hasBillingHeader is TRUE for a cch-less header at system start", () => {
    expect(hasBillingHeader(CCHLESS_HEADER)).toBe(true);
  });

  test("hasBillingHeader is TRUE for a cch-less header followed by host prompt", () => {
    expect(hasBillingHeader(`${CCHLESS_HEADER}\nYou are Claude Code.`)).toBe(
      true,
    );
  });

  test("hasBillingHeader still TRUE for a cch-bearing header (regression anchor)", () => {
    expect(hasBillingHeader(CCH_HEADER)).toBe(true);
  });

  test("hasBillingHeader is FALSE when a cch-less sentinel is quoted in content", () => {
    // Not at offset 0 → the ^ anchor rejects it (api-key session editing cch.ts).
    expect(
      hasBillingHeader(`You are Claude Code.\n\nExample: ${CCHLESS_HEADER}`),
    ).toBe(false);
  });

  // (b) OAuth session marking ----------------------------------------------

  test("captureBillingPrefix marks the OAuth session for a cch-less header", () => {
    expect(captureBillingPrefix(SID_A, CCHLESS_HEADER)).toBe(true);
    expect(isClaudeCodeOAuthSession(SID_A)).toBe(true);
    expect(buildBillingBlock(SID_A, "Summarize this.")).not.toBeNull();
    expect(buildOAuthWorkerHeaders(SID_A)).not.toBeNull();
  });

  // (c) Re-signing ----------------------------------------------------------

  test("resignBody injects a placeholder and signs a cch-less header", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 8192,
      system: [
        {
          type: "text",
          text: CCHLESS_HEADER,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        { type: "text", text: "You are a helpful assistant." },
      ],
      messages: [{ role: "user", content: "explain caching please" }],
    });

    const resigned = resignBody(body, "explain caching please");
    // A real signed cch was produced (not the placeholder, not absent).
    expect(resigned).not.toContain("cch=00000");
    expect(resigned).toMatch(/cch=[0-9a-f]{5};/);
    // cc_version rewritten to the worker version + 3-hex suffix.
    expect(resigned).toMatch(
      new RegExp(`cc_version=${WORKER_VERSION}\\.[0-9a-f]{3};`),
    );
    // cc_entrypoint preserved.
    expect(resigned).toContain("cc_entrypoint=cli;");
    // Validates against our known seed.
    expect(validateSeed(resigned)).toBe(true);
  });

  test("resignBody preserves a non-default cc_entrypoint on a cch-less header", () => {
    const body = JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.181.abc; cc_entrypoint=vscode;",
        },
      ],
      messages: [{ role: "user", content: "hi there friend" }],
    });
    const resigned = resignBody(body, "hi there friend");
    expect(resigned).toContain("cc_entrypoint=vscode;");
    expect(validateSeed(resigned)).toBe(true);
  });

  test("resignBody cch-bearing path still validates (regression anchor)", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: CCH_HEADER }],
      messages: [{ role: "user", content: "hi there friend" }],
    });
    const resigned = resignBody(body, "hi there friend");
    expect(resigned).not.toContain("cch=1a2b3");
    expect(validateSeed(resigned)).toBe(true);
  });

  test("resignBody is a no-op when a cch-less sentinel only appears in content (no real header)", () => {
    // No full `x-anthropic-billing-header:` sentinel anywhere → pure no-op.
    const body = JSON.stringify({
      system: [{ type: "text", text: "note: header is `cc_entrypoint=cli;`" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resignBody(body, "hi")).toBe(body);
  });

  // (d) Pipeline-gate simulation -------------------------------------------

  test("pipeline gate re-signs a cch-less header at system[0] to a valid worker cch", () => {
    const system = `${CCHLESS_HEADER}\nYou are Claude Code.`;
    const serializedBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    // Mirror pipeline.ts forwardToUpstream: re-sign only when the real header
    // is at system[0].
    const out = hasBillingHeader(system)
      ? resignBody(serializedBody, "hi")
      : serializedBody;

    expect(out).not.toBe(serializedBody); // gate fired → re-signed
    expect(out).toMatch(/cch=[0-9a-f]{5};/);
    expect(validateSeed(out)).toBe(true);
  });
});
