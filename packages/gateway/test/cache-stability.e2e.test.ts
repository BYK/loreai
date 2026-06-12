/**
 * End-to-end cache-stability tests.
 *
 * These drive multi-turn conversations through a REAL gateway (replay harness,
 * no live API) and assert the invariant that every cache-bust bug we've chased
 * violated: across consecutive turns, the UPSTREAM request body's stable prefix
 * (system[0] host prompt, system[1] preferences, system[2] context-bound LTM,
 * and already-sent messages) must stay byte-identical. The only thing that may
 * change between turns is the conversation TAIL (newly appended messages).
 *
 * If a future change makes system[1]/system[2]/an early message churn turn-to-
 * turn (LTM re-ranking, mid-session curation rewrite, dedup toggle, a per-turn
 * token injected into a cached block, etc.), the divergence offset jumps out of
 * the tail and these tests fail — turning whack-a-mole into a guardrail.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  makeConversationFixtures,
} from "./helpers/fixtures";
import {
  findDivergenceOffset,
  mapOffsetToJsonPath,
  normalizeBodyForComparison,
} from "../src/cache-analytics";

function makeBody(
  userMessage: string,
  history: unknown[] = [],
): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages: [...history, { role: "user", content: userMessage }],
    tools: STANDARD_TOOLS,
  };
}

/**
 * Given two consecutive upstream bodies, return the JSON path where they first
 * diverge (after normalizing volatile client tokens the same way the live
 * cache analytics does). "<end>" / "<identical>" mean no mid-body divergence.
 */
function divergencePath(prev: string, curr: string): string {
  const p = normalizeBodyForComparison(prev);
  const c = normalizeBodyForComparison(curr);
  const offset = findDivergenceOffset(p, c);
  if (offset >= Math.min(p.length, c.length)) {
    return p.length === c.length ? "<identical>" : "<end>";
  }
  return mapOffsetToJsonPath(c, offset);
}

/** True when a divergence path points at the conversation tail (a message),
 *  not at a system block — i.e. an acceptable, cache-friendly change. */
function isTailDivergence(path: string): boolean {
  return (
    path === "<end>" || path === "<identical>" || /^messages\[\d+\]/.test(path)
  );
}

describe("cache stability (e2e)", () => {
  let harness: Harness;
  afterEach(() => harness?.teardown());

  it("system prefix stays byte-stable across the steady state (turn 2+)", async () => {
    // Turn 1→2 legitimately introduces system[2] (context-bound LTM is deferred
    // to turn 2 by design). From turn 2 onward the full system prefix must be
    // byte-stable — that's the steady state every cache-bust bug violated.
    const turns = [
      {
        userMessage: "Let's start working on the parser.",
        assistantText: "Sure.",
      },
      { userMessage: "Add support for nested groups.", assistantText: "Done." },
      {
        userMessage: "Now handle escape sequences.",
        assistantText: "Handled.",
      },
      {
        userMessage: "Write tests for the new cases.",
        assistantText: "Tests added.",
      },
      {
        userMessage: "Refactor the tokenizer a bit.",
        assistantText: "Refactored.",
      },
      { userMessage: "Tidy up the comments.", assistantText: "Tidied." },
    ];
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    // Drive the conversation, accumulating history client-side like a real
    // client would.
    const history: unknown[] = [];
    for (const turn of turns) {
      const resp = await harness.chat(makeBody(turn.userMessage, history));
      expect(resp.status).toBe(200);
      history.push({ role: "user", content: turn.userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turn.assistantText }],
      });
    }

    const bodies = harness.upstreamBodies();
    expect(bodies.length).toBe(turns.length);

    // Steady state: from turn 2 (index 1) onward, each transition must diverge
    // only in the tail (new messages), never inside a system block.
    for (let i = 2; i < bodies.length; i++) {
      const path = divergencePath(bodies[i - 1], bodies[i]);
      expect(
        isTailDivergence(path),
        `turn ${i}→${i + 1} diverged at "${path}" (expected a messages[N] tail change, ` +
          `not a system-block rewrite — that would bust the prompt cache)`,
      ).toBe(true);
    }
  });

  it("the system block is byte-identical once system[2] is established (turn 2+)", async () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({
      userMessage: `Step ${i}: do the thing with some detail to grow the body.`,
      assistantText: `Acknowledged step ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const history: unknown[] = [];
    for (const turn of turns) {
      await harness.chat(makeBody(turn.userMessage, history));
      history.push({ role: "user", content: turn.userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turn.assistantText }],
      });
    }

    const bodies = harness.upstreamBodies().map(normalizeBodyForComparison);
    // Extract the serialized `system` field from each body. From turn 2 (index
    // 1) — where system[2] is first injected — onward it must never change.
    const systems = bodies.map((b) => {
      const parsed = JSON.parse(b) as { system?: unknown };
      return JSON.stringify(parsed.system ?? null);
    });
    const steady = systems[1]; // turn 2: system[2] established
    for (let i = 2; i < systems.length; i++) {
      expect(
        systems[i],
        `system block changed between turn ${i} and ${i + 1} — this busts the ` +
          `cached system prefix on every subsequent turn`,
      ).toBe(steady);
    }
  });

  it("system block stays byte-stable as the compression layer changes turn-to-turn (#741)", async () => {
    // Regression for #741: a per-turn "context health" note used to be appended
    // to system[2] with layer-dependent wording (compressed / aggressively
    // compressed / emergency compressed). Because system[2] has no cache_control
    // of its own, ANY change to the layer (e.g. 1→2→3) rewrote system[2] that
    // turn and busted the cached prefix. The note has been removed, so the
    // system block must now stay byte-identical even as the layer changes.
    //
    // We drive the layer deterministically with setForceMinLayer (one-shot per
    // transform), re-arming it before each turn. The harness shares the
    // @loreai/core singleton with the gateway, so the forced layer is honored.
    // Note: the gradient's sticky-layer hysteresis blocks DOWN transitions, so
    // the observed layer escalates 1→2→3 then holds — escalation alone is a
    // sufficient trigger for the original bust (the note's wording changed at
    // each step). The negative assertion below would have caught it.
    const { setForceMinLayer } = await import("@loreai/core");

    const turns = Array.from({ length: 6 }, (_, i) => ({
      userMessage: `Step ${i}: keep working with enough detail to grow the body.`,
      assistantText: `Acknowledged step ${i}.`,
    }));
    // Force the minimum layer up across turns (0,1,2,3,…). Turn 0 stays at
    // layer 0 so system[2] is established normally on turn 1, then the layer
    // escalates while the system block must remain byte-identical.
    const forcedLayers = [0, 1, 2, 3, 3, 3] as const;

    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const history: unknown[] = [];
    for (let i = 0; i < turns.length; i++) {
      // Re-arm the one-shot force before each turn's transform fires.
      if (forcedLayers[i] >= 1) setForceMinLayer(forcedLayers[i]);
      await harness.chat(makeBody(turns[i].userMessage, history));
      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });
    }

    const bodies = harness.upstreamBodies().map(normalizeBodyForComparison);
    const systems = bodies.map((b) => {
      const parsed = JSON.parse(b) as { system?: unknown };
      return JSON.stringify(parsed.system ?? null);
    });

    // From turn 2 (index 1) onward — where system[2] is established and the
    // forced layer starts oscillating — the system block must never change.
    const steady = systems[1];
    for (let i = 2; i < systems.length; i++) {
      expect(
        systems[i],
        `system block changed between turn ${i} and ${i + 1} while forcing ` +
          `layer ${forcedLayers[i]} (prev ${forcedLayers[i - 1]}) — a layer ` +
          `oscillation must not bust the cached system prefix (#741)`,
      ).toBe(steady);
    }
  });
});
