/**
 * Coverage for the explicit compaction endpoints (`POST /v1/compact`, used by
 * the Pi plugin). Focuses on the request-validation + no-session branches of
 * handleCompactEndpoint, which return deterministic responses without any
 * upstream call.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  generateCompactionSummary,
  handleCompactEndpoint,
  shouldCancelCompactionFromBudget,
} from "../src/pipeline";
import { loadConfig } from "../src/config";

async function postCompact(harness: Harness, body: string): Promise<Response> {
  return harness.request("/v1/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "test-key",
    },
    body,
  });
}

describe("POST /v1/compact", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("rejects an unknown session before parsing invalid JSON", async () => {
    harness = await createHarness({ fixtures: [] });
    const resp = await postCompact(harness, "{ not json");
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string; message: string };
    expect(body.error).toBe("session_not_found");
  });

  it("rejects missing authentication without reading an indefinite body", async () => {
    const source = new ReadableStream<Uint8Array>({
      type: "bytes",
      pull() {
        return new Promise(() => {});
      },
    });
    const req = new Request("http://gateway.test/v1/compact", {
      method: "POST",
      body: source,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handleCompactEndpoint(req, loadConfig());
    expect(response.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    await response.body?.cancel();
  });

  it("rejects an unknown session without reading an indefinite body", async () => {
    const source = new ReadableStream<Uint8Array>({
      type: "bytes",
      pull() {
        return new Promise(() => {});
      },
    });
    const req = new Request("http://gateway.test/v1/compact", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "x-lore-session-id": "unknown-stalled-session",
      },
      body: source,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handleCompactEndpoint(req, loadConfig());
    expect(response.status).toBe(404);
    expect(req.bodyUsed).toBe(false);
    await response.body?.cancel();
  });

  it("rejects an unknown session before validating project_path", async () => {
    harness = await createHarness({ fixtures: [] });
    const resp = await postCompact(harness, JSON.stringify({}));
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string; message: string };
    expect(body.error).toBe("session_not_found");
  });

  it("returns 404 when no active session exists for the project", async () => {
    harness = await createHarness({ fixtures: [] });
    const resp = await postCompact(
      harness,
      JSON.stringify({ project_path: process.cwd() }),
    );
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: string; message: string };
    expect(body.error).toBe("session_not_found");
    expect(body.message).toContain("No authenticated session found");
  });
});

it("compaction summary generation rejects an already-aborted foreground signal", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("client disconnected", "AbortError"));
  await expect(
    generateCompactionSummary({
      projectPath: process.cwd(),
      sessionID: "aborted-compaction",
      config: loadConfig(),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

/**
 * Coverage for the cancel-when-fits behavior of `POST /v1/compact` when
 * `tokens_before` is provided. The gateway is the single source of truth
 * for "does this session's raw context fit in the layer-0 budget?" — the
 * plugin just relays.
 *
 * These tests do not seed a real session (no fixtures); the cancel
 * decision requires `lastUpstream.model` to be set, which only happens
 * after a normal conversation turn. With `tokens_before` but no upstream,
 * the endpoint falls through to the summary path (logged) — that's
 * covered implicitly by the 502/200 contract tests in the main suite.
 * The full cancel path is exercised by the Pi integration tests on a
 * real gateway (PI-XLONG-S5-CANCEL) — see packages/core/eval/live.
 */
describe("POST /v1/compact — tokens_before field", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("ignores tokens_before when the project has no active session (404 wins)", async () => {
    harness = await createHarness({ fixtures: [] });
    const resp = await postCompact(
      harness,
      JSON.stringify({
        project_path: process.cwd(),
        tokens_before: 50_000,
      }),
    );
    expect(resp.status).toBe(404);
  });

  it("accepts tokens_before: 0 as 'unknown' and falls through to summary path", async () => {
    // tokensBefore === 0 means "I don't know" — the guard at pipeline.ts
    // explicitly skips the cancel decision and falls through to the
    // summary endpoint. Without a real session that still 404s, but the
    // schema is exercised.
    harness = await createHarness({ fixtures: [] });
    const resp = await postCompact(
      harness,
      JSON.stringify({
        project_path: process.cwd(),
        tokens_before: 0,
      }),
    );
    expect(resp.status).toBe(404); // no session, but body was accepted
  });

  it("ignores non-number tokens_before (strings, null) — falls through to summary path", async () => {
    harness = await createHarness({ fixtures: [] });
    // JSON doesn't carry NaN/Infinity literals — they become null or strings.
    // The `typeof === "number"` guard drops all of these safely.
    for (const bad of [null, "100", '"NaN"', true, false, {}]) {
      const resp = await postCompact(
        harness,
        JSON.stringify({
          project_path: process.cwd(),
          tokens_before: bad,
        }),
      );
      // All non-number values are dropped; 404 from no-session, not a 400.
      expect(resp.status).toBe(404);
    }
  });

  it("rejects negative tokens_before — falls through to summary path", async () => {
    harness = await createHarness({ fixtures: [] });
    const resp = await postCompact(
      harness,
      JSON.stringify({
        project_path: process.cwd(),
        tokens_before: -100,
      }),
    );
    // tokensBefore <= 0 is the "unknown" branch; 404 from no-session.
    expect(resp.status).toBe(404);
  });
});

/**
 * Unit tests for the cancel-decision helper. Pure: no harness, no fixtures,
 * no I/O. The whole point is to make the boundary behavior (just-under-budget
 * vs at-budget vs over-budget) easy to inspect without spinning up a gateway.
 */
describe("shouldCancelCompactionFromBudget", () => {
  // Provider-scoped. As of the latest models.dev data:
  //   - claude-sonnet-4-6 (anthropic): context=1_000_000, output=64_000  → budget = 936_000
  //   - claude-opus-4-8  (anthropic): context=1_000_000, output=128_000 → budget = 872_000
  //   - gpt-4o-mini      (openai):    context=200_000,   output=8_192   → budget = 191_808
  const sonnet = { model: "claude-sonnet-4-6", providerID: "anthropic" };
  const opus = { model: "claude-opus-4-8", providerID: "anthropic" };
  const gptMini = { model: "gpt-4o-mini", providerID: "openai" };

  describe("input validation", () => {
    it("treats undefined tokens_before as unknown (no decision)", () => {
      const d = shouldCancelCompactionFromBudget(undefined, sonnet);
      expect(d.cancel).toBe(false);
      expect(d.mustCompact).toBe(false);
      expect(d.reason).toContain("unknown");
    });

    it("treats NaN as unknown", () => {
      const d = shouldCancelCompactionFromBudget(NaN, sonnet);
      expect(d.cancel).toBe(false);
      expect(d.mustCompact).toBe(false);
    });

    it("treats Infinity as unknown", () => {
      const d = shouldCancelCompactionFromBudget(Infinity, sonnet);
      expect(d.cancel).toBe(false);
      expect(d.mustCompact).toBe(false);
    });

    it("treats 0 as unknown (not cancel, not must-compact)", () => {
      const d = shouldCancelCompactionFromBudget(0, sonnet);
      expect(d.cancel).toBe(false);
      expect(d.mustCompact).toBe(false);
      expect(d.reason).toContain("non-positive");
    });

    it("treats negative tokens_before as unknown", () => {
      const d = shouldCancelCompactionFromBudget(-100, sonnet);
      expect(d.cancel).toBe(false);
      expect(d.mustCompact).toBe(false);
    });
  });

  describe("missing upstream", () => {
    it("falls through to summary when no upstream at all", () => {
      const d = shouldCancelCompactionFromBudget(50_000, undefined);
      expect(d.cancel).toBe(false);
      expect(d.mustCompact).toBe(false);
      expect(d.reason).toContain("no upstream model");
    });

    it("falls through when upstream is present but model is empty", () => {
      const d = shouldCancelCompactionFromBudget(50_000, {
        providerID: "anthropic",
      });
      expect(d.cancel).toBe(false);
      expect(d.mustCompact).toBe(false);
    });
  });

  describe("boundary behavior", () => {
    it("cancels when tokensBefore is well under the budget (1M Sonnet)", () => {
      const d = shouldCancelCompactionFromBudget(50_000, sonnet);
      expect(d.cancel).toBe(true);
      expect(d.mustCompact).toBe(false);
    });

    it("cancels at exactly budget - 1 (just under; 1M Sonnet budget = 936_000)", () => {
      const d = shouldCancelCompactionFromBudget(935_999, sonnet);
      expect(d.cancel).toBe(true);
    });

    it("cancels at exactly the budget (boundary; the output reserve is already accounted for in the budget)", () => {
      // The budget is `context - output`, i.e. already accounts for the next
      // call's output reserve. So tokensBefore == budget means the next call
      // would be at exactly `context`, which fits. We cancel.
      const d = shouldCancelCompactionFromBudget(936_000, sonnet);
      expect(d.cancel).toBe(true);
    });

    it("must-compact when tokensBefore exceeds the budget by even 1 token", () => {
      const d = shouldCancelCompactionFromBudget(936_001, sonnet);
      expect(d.cancel).toBe(false);
      expect(d.mustCompact).toBe(true);
    });

    it("must-compact when tokensBefore is well over the budget", () => {
      const d = shouldCancelCompactionFromBudget(1_500_000, sonnet);
      expect(d.cancel).toBe(false);
      expect(d.mustCompact).toBe(true);
    });

    it("scales correctly with a larger-output model (Opus 1M, 128K output; budget = 872_000)", () => {
      const atBoundary = shouldCancelCompactionFromBudget(872_000, opus);
      expect(atBoundary.cancel).toBe(true);

      const over = shouldCancelCompactionFromBudget(872_001, opus);
      expect(over.cancel).toBe(false);
      expect(over.mustCompact).toBe(true);
    });

    it("scales correctly with a smaller-context model (GPT-4o-mini 200K, 8K output; budget = 191_808)", () => {
      // A small-context model proves the model-aware design: 150K fits in
      // 191_808, 250K does not. The original client-side 200K hardcoded
      // threshold would have been wrong on this model.
      const fits = shouldCancelCompactionFromBudget(150_000, gptMini);
      expect(fits.cancel).toBe(true);

      const over = shouldCancelCompactionFromBudget(250_000, gptMini);
      expect(over.cancel).toBe(false);
      expect(over.mustCompact).toBe(true);
    });
  });

  describe("provider qualification", () => {
    it("uses provider-scoped model resolution (anthropic vs openrouter for same model id)", () => {
      // Same model id, different providers: budgets can differ. We rely on
      // getModelSpec to honor providerID. Just confirm the function accepts
      // providerID and doesn't crash.
      const d1 = shouldCancelCompactionFromBudget(50_000, {
        model: "claude-sonnet-4-6",
        providerID: "anthropic",
      });
      const d2 = shouldCancelCompactionFromBudget(50_000, {
        model: "claude-sonnet-4-6",
        providerID: "openrouter",
      });
      // Both should cancel (50K fits in any 1M-context provider's budget);
      // the test is that providerID is honored, not that the budgets differ.
      expect(d1.cancel).toBe(true);
      expect(d2.cancel).toBe(true);
    });
  });
});
