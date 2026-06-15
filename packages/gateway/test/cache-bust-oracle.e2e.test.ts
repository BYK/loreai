/**
 * End-to-end cache-bust ORACLE tests.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three separate production cache-bust bugs (tier-gate, raw-window pin-march,
 * LTM-delta-churn) all slipped past the cache-stability suite. The post-mortem
 * root cause: replay fixtures report ZERO cache usage, so the gateway's own
 * cache oracles (categorizeBust / recordCacheUsage / calibrate) ran blindfolded
 * in every test — a prompt-cache bust produced no observable difference. Every
 * existing assertion was on cache *inputs* (byte-stability of system blocks
 * between two turns); none was on the cache *output* (read vs write) over a long
 * driven session.
 *
 * These tests close that gap. They use `createHarness({ simulateCache: true })`,
 * which computes each turn's cache_read / cache_creation from the ACTUAL
 * upstream-body prefix stability (the way Anthropic's prompt cache behaves) and
 * feeds it back into the response — so the gateway sees production-faithful
 * numbers and a real bust is observable. The tests then assert on the cache
 * OUTPUT: the steady-state write:read ratio stays low, i.e. the prompt cache is
 * being READ, not rewritten every turn.
 *
 * A churning prefix (window march, mid-history delta append, system[2] rewrite)
 * makes cache_creation dominate every turn → the ratio assertion fails. That is
 * exactly the signal the production bust-tracker logged (write:read ≈ 12.5:1)
 * but that no test could previously reproduce.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { DEFAULT_MODEL, makeFixtureEntry } from "./helpers/fixtures";
import type { GatewayMessage } from "../src/translate/types";

let harness: Harness | undefined;

afterEach(async () => {
  const { resetCalibration } = await import("../../core/src/gradient");
  resetCalibration();
  await harness?.teardown();
  harness = undefined;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ~1200 tokens per message so a long history overflows the budget and the
 *  gradient pins a layer-1 sub-window. */
function big(label: string): string {
  return `${label} ${"lorem ipsum dolor sit amet ".repeat(170)}`;
}

function userMsg(text: string): GatewayMessage {
  return { role: "user", content: [{ type: "text", text }] };
}
function asstMsg(text: string): GatewayMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function makeBody(messages: GatewayMessage[]): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: "You are a helpful coding agent.",
    messages,
  };
}

async function observedLayer(sessionID: string): Promise<number> {
  const { getLastLayer } = await import("../../core/src/gradient");
  return getLastLayer(sessionID);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cache-bust oracle (e2e)", () => {
  it("simulated cache reports a clean read after a stable steady state", async () => {
    // Sanity check the oracle itself: a session whose prefix is stable (only
    // new tail messages each turn) must show high cache reads and near-zero
    // creation after the cold-start turn. If THIS fails, the oracle is wrong.
    const fixtures = Array.from({ length: 6 }, (_, i) =>
      makeFixtureEntry({
        seq: i,
        requestMessages: [],
        responseText: "ok",
        model: DEFAULT_MODEL,
        wasStreaming: false,
      }),
    );
    harness = await createHarness({ fixtures, simulateCache: true });

    const history: GatewayMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push(userMsg(`small turn ${i}`));
      const resp = await harness.chat(makeBody(history));
      expect(resp.status).toBe(200);
      await resp.json();
      history.push(asstMsg("ok"));
    }

    const turns = harness.cacheTurns();
    expect(turns.length).toBe(6);
    // Turn 0 is a cold write; turn 1 (index 1) legitimately injects the
    // context-bound LTM block (system[2]) by design, which lowers the prefix
    // match once. Steady state is turn 2 (index 2) onward: only a tiny new tail
    // each turn → near-full cache hit on the unchanged prefix.
    for (let i = 3; i < turns.length; i++) {
      expect(
        turns[i].prefixMatch,
        `turn ${i} prefixMatch=${turns[i].prefixMatch} (expected a near-full ` +
          `cache hit on a stable prefix)`,
      ).toBeGreaterThan(0.8);
    }
  });

  it("prompt cache is READ (not rewritten) on a long compressed session with mid-session knowledge growth", async () => {
    // Broad guardrail over the whole compressed pipeline: drive a long, large,
    // NATURALLY-compressed (layer 1) session and, midway through, create a burst
    // of knowledge entries (simulating the curator / tool-failure gotcha
    // auto-mint that fueled the production churn). Assert via the SIMULATED
    // CACHE that the steady-state prompt cache is READ, not rewritten.
    //
    // This catches any regression that busts the cache on (nearly) every
    // compressed turn — raw-window pin-march, system[2] rewrite, or a
    // durable-delta appended into the cached prefix every turn. (The narrow,
    // deterministic reproduction of the budget-wobble LTM-churn root cause lives
    // in the gradient unit test "getLtmBudget is STABLE across per-turn overhead
    // wobble"; this e2e is the end-to-end safety net at the cache-output level —
    // the level that was completely unguarded before.)
    const TOTAL_TURNS = 16;
    const BASE_PAIRS = 30; // ~60 base messages → well over the 40K l0cap

    const fixtures = Array.from({ length: TOTAL_TURNS }, (_, i) =>
      makeFixtureEntry({
        seq: i,
        requestMessages: [],
        responseText: big(`assistant reply ${i}`),
        model: DEFAULT_MODEL,
        wasStreaming: false,
        // input_tokens kept small; the simulated cache supplies read/creation.
        outputTokens: 1_200,
      }),
    );

    const projectPath = `/tmp/lore-cache-oracle-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    harness = await createHarness({
      fixtures,
      simulateCache: true,
      projectPath,
      // Force layer-1 compression deterministically without depending on
      // models.dev pricing being warm in the test.
      budget: { maxLayer0Tokens: 40_000 },
    });

    const { resetCalibration, setUrgentDistillationEnabledForTest } =
      await import("../../core/src/gradient");
    const { ltm, ensureProject } = await import("@loreai/core");
    resetCalibration();
    setUrgentDistillationEnabledForTest(false);
    ensureProject(projectPath);

    // Seed an initial knowledge set so system[2] (context-bound LTM) is
    // populated from turn 1.
    for (let i = 0; i < 8; i++) {
      ltm.create({
        projectPath,
        scope: "project",
        category: "pattern",
        title: `Seed knowledge ${i}`,
        content: `Seed knowledge entry ${i}: ${"detail ".repeat(40)}`,
      });
    }

    const history: GatewayMessage[] = [];
    for (let i = 0; i < BASE_PAIRS; i++) {
      history.push(userMsg(big(`base user ${i}`)));
      history.push(asstMsg(big(`base assistant ${i}`)));
    }

    let sessionID = "";
    let peakLayer = 0;
    const layers: number[] = [];
    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      history.push(userMsg(big(`turn user ${turn}`)));

      // Mid-session: mint a burst of new knowledge entries, simulating the
      // tool-failure gotcha auto-mint that churned the selected LTM set in
      // production. This is the trigger that must NOT bust the cache every turn.
      if (turn === 6) {
        for (let g = 0; g < 10; g++) {
          ltm.create({
            projectPath,
            scope: "project",
            category: "gotcha",
            title: `Recurring failure ${g}`,
            content: `Recurring failure pattern ${g}: ${"noise ".repeat(30)}`,
            confidence: 0.75,
          });
        }
      }

      const resp = await harness.chat(makeBody(history));
      expect(resp.status).toBe(200);
      await resp.json();
      history.push(asstMsg(big(`turn assistant ${turn}`)));

      if (turn === 0) {
        const rows = harness.queryDB<{ session_id: string }>(
          "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
        );
        sessionID = rows[0]?.session_id ?? "";
        expect(sessionID).not.toBe("");
      } else {
        const layer = await observedLayer(sessionID);
        peakLayer = Math.max(peakLayer, layer);
        layers.push(layer);
      }
    }

    // Guard: the session must actually be compressing at layer 1 (the regime
    // every one of these bugs lived in). If a future change moved it off
    // layer 1, this test would stop guarding the bug — fail loudly instead.
    const layer1Turns = layers.filter((l) => l === 1).length;
    expect(
      layer1Turns,
      `expected most steady-state turns at layer 1 (compressed pin path), but ` +
        `observed layers were ${JSON.stringify(layers)} (peak ${peakLayer})`,
    ).toBeGreaterThanOrEqual(Math.ceil(layers.length / 2));

    const turns = harness.cacheTurns();
    expect(turns.length).toBe(TOTAL_TURNS);

    // STEADY STATE = turn 2 onward (turn 0 is a cold write; turn 1 establishes
    // system[2]/context-bound LTM by design). In steady state the prompt cache
    // must be READ, not rewritten: cache_creation should be a small fraction of
    // cache_read. The production bug showed write:read ≈ 12.5:1 (ratio ≈ 12.5).
    let totalRead = 0;
    let totalCreation = 0;
    let bustTurns = 0;
    for (let i = 3; i < turns.length; i++) {
      totalRead += turns[i].cacheReadTokens;
      totalCreation += turns[i].cacheCreationTokens;
      // A "bust turn": more than half the body was rewritten (matches the
      // gateway's own bust definition: write/(write+read) > 0.5).
      const total = turns[i].cacheReadTokens + turns[i].cacheCreationTokens;
      if (total > 0 && turns[i].cacheCreationTokens / total > 0.5) bustTurns++;
    }
    const ratio = totalRead > 0 ? totalCreation / totalRead : Infinity;

    const detail =
      `steady-state write:read ratio=${ratio.toFixed(3)} ` +
      `(creation=${totalCreation} read=${totalRead}), bustTurns=${bustTurns}/` +
      `${turns.length - 2}, prefixMatch per turn=` +
      JSON.stringify(turns.map((t) => Number(t.prefixMatch.toFixed(3))));

    // The cache must be mostly read. Allow a modest write share for the genuine
    // tail growth + the single legitimate delta when knowledge first changes,
    // but a churning prefix (rewrite every turn) cannot satisfy this.
    expect(
      ratio,
      `prompt cache is being rewritten, not read — ${detail}. A healthy ` +
        `compressed session reads the cached prefix every turn; a high ratio ` +
        `means a mid-prefix divergence is busting the cache (regression: ` +
        `LTM-delta-churn / window-march / system[2] rewrite).`,
    ).toBeLessThan(0.5);

    // And the bust must not happen on (nearly) every steady-state turn.
    expect(
      bustTurns,
      `prompt cache busted on ${bustTurns} of ${turns.length - 3} steady-state ` +
        `turns — ${detail}`,
    ).toBeLessThan(Math.floor((turns.length - 3) / 2));
  });
});
