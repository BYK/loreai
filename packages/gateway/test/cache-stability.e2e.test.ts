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
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { log } from "@loreai/core";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  makeFixtureEntry,
  makeConversationFixtures,
} from "./helpers/fixtures";
import { inflateSession } from "../../core/eval/inflate";
import type {
  ContentPart,
  ConversationTurn,
  SessionTranscript,
} from "../../core/eval/types";
import {
  findDivergenceOffset,
  mapOffsetToJsonPath,
  normalizeBodyForComparison,
} from "../src/cache-analytics";
import type { FixtureEntry } from "../src/recorder";
import type {
  GatewayContentBlock,
  GatewayMessage,
} from "../src/translate/types";

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

/** True when a divergence path points at raw conversation messages, not at a
 *  cached prefix message. `messages[0/1]` are lore's synthetic distilled
 *  prefix when gradient compression is active, so accepting all messages[N]
 *  paths (as #748 originally did) misses meta-distillation prefix rewrites.
 *  Raw-message window shifts at messages[2+] are still allowed by this broad
 *  guardrail; cache-analytics has narrower hit-rate checks for those. */
function isTailDivergence(path: string): boolean {
  if (path === "<end>" || path === "<identical>") return true;
  const match = path.match(/^messages\[(\d+)\]/);
  if (!match) return false;
  const idx = Number(match[1]);
  return idx > 1;
}

/**
 * Extract the cached system-prefix blocks from a serialized upstream body.
 *
 * The 3-block system prompt (system[0] host prompt, system[1] stable LTM,
 * system[2] context-bound LTM) sits before the conversation breakpoint and is
 * what Anthropic keys its prompt cache on. We compare these blocks directly
 * (rather than freezing the whole `system` array) so the assertion stays valid
 * even if a future change appends a NON-cached trailing block after the
 * breakpoint.
 */
function systemBlocks(body: string): string[] {
  const parsed = JSON.parse(normalizeBodyForComparison(body)) as {
    system?: unknown;
  };
  const sys = parsed.system;
  if (typeof sys === "string") return [sys];
  if (Array.isArray(sys)) return sys.map((b) => JSON.stringify(b));
  return [];
}

function serializedMessages(body: string): string {
  const parsed = JSON.parse(normalizeBodyForComparison(body)) as {
    messages?: unknown;
  };
  return JSON.stringify(parsed.messages ?? null);
}

/**
 * Find the START of the raw window in a serialized upstream body: the first
 * message whose text contains `marker` (our test messages embed a unique marker
 * per message; the synthetic distilled prefix does not). Returns the marker
 * substring of that first raw message — a stable identifier for the raw-window
 * start boundary. Used to detect a marching boundary across turns.
 */
function firstRawWindowMarker(body: string, marker: RegExp): string | null {
  const parsed = JSON.parse(normalizeBodyForComparison(body)) as {
    messages?: Array<{ content?: unknown }>;
  };
  for (const msg of parsed.messages ?? []) {
    const text = JSON.stringify(msg.content ?? "");
    const m = text.match(marker);
    if (m) return m[0];
  }
  return null;
}

function textTurn(
  role: "user" | "assistant",
  text: string,
  tokens = Math.ceil(text.length / 4),
): ConversationTurn {
  return { role, content: [{ type: "text", text }], tokens };
}

function toGatewayBlock(part: ContentPart): GatewayContentBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: part.tool_use_id,
        content: [{ type: "text", text: part.content }],
        isError: part.is_error,
      };
  }
}

function toGatewayMessage(turn: ConversationTurn): GatewayMessage {
  return {
    role: turn.role,
    content: turn.content.map(toGatewayBlock),
  };
}

function makeInflatedSession(projectPath: string): SessionTranscript {
  let seed = 744;
  const rng = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const importantBlob =
    "Remember that cache-stability validation must keep system blocks byte-stable. ".repeat(
      45,
    );
  const base: SessionTranscript = {
    id: "cache-stability-compressed-session",
    label: "Cache stability compressed session",
    projectPath,
    turns: [
      textTurn("user", `Start the cache stability work. ${importantBlob}`),
      textTurn(
        "assistant",
        "I'll set up the test harness and memory fixtures.",
      ),
      textTurn(
        "user",
        `Add realistic inflated context around tool-heavy work. ${importantBlob}`,
      ),
      textTurn("assistant", "Inflated context is ready."),
      textTurn(
        "user",
        `Now simulate mid-session knowledge updates. ${importantBlob}`,
      ),
      textTurn("assistant", "Knowledge update simulation is ready."),
      textTurn(
        "user",
        `Force gradient layer transitions and inspect upstream bodies. ${importantBlob}`,
      ),
      textTurn("assistant", "Layer transition checks are wired."),
    ],
    metadata: {
      totalTokens: 8_000,
      description: "Synthetic cache-stability session before inflation",
    },
  };

  return inflateSession(
    base,
    48_000,
    new Set(["cache", "stability"]),
    1_700_000_000_000,
    rng,
  );
}

function makeInflatedFixtures(callCount: number): FixtureEntry[] {
  return Array.from({ length: callCount }, (_, i) =>
    makeFixtureEntry({
      seq: i,
      requestMessages: [],
      responseText: `scripted compressed response ${i}`,
      model: DEFAULT_MODEL,
      inputTokens: 25_000 + i * 12_000,
      outputTokens: 50,
    }),
  );
}

function makeGatewayBody(messages: GatewayMessage[]): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages,
    tools: STANDARD_TOOLS,
  };
}

function userTurnIndices(turns: ConversationTurn[], limit: number): number[] {
  const indices: number[] = [];
  for (let i = 0; i < turns.length && indices.length < limit; i++) {
    if (turns[i].role === "user") indices.push(i);
  }
  return indices;
}

/** Read the gradient layer the session was last transformed at. The test
 *  harness shares the @loreai/core gradient singleton with the in-process
 *  gateway, so this reflects the layer the most recent turn actually used. */
async function observedLayer(sessionID: string): Promise<number> {
  const { getLastLayer } = await import("../../core/src/gradient");
  return getLastLayer(sessionID);
}

async function seedMemory(projectPath: string, sessionID: string) {
  const { db, ensureProject, ltm } = await import("@loreai/core");
  const projectID = ensureProject(projectPath);
  const preferenceID = ltm.create({
    projectPath,
    scope: "project",
    category: "preference",
    title: "Cache test preference",
    content:
      "Prefer preserving prompt-cache prefixes over eager mid-session preference refreshes.",
    session: sessionID,
  });
  const contextID = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    title: "Compressed cache stability gotcha",
    content:
      "When gradient compression is active, system[2] must remain byte-stable unless the pinned entry set genuinely changes.",
    session: sessionID,
  });

  for (let i = 0; i < 6; i++) {
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `dist-cache-stability-${i}`,
        projectID,
        sessionID,
        `Narrative ${i}`,
        "[]",
        `Observation ${i}: ${"compressed history summary ".repeat(80)}`,
        "[]",
        0,
        600,
        0,
        Date.now() + i,
      );
  }

  return { preferenceID, contextID };
}

describe("cache stability (e2e)", () => {
  let harness: Harness;
  afterEach(async () => {
    const { resetCalibration } = await import("../../core/src/gradient");
    resetCalibration();
    await harness?.teardown();
  });
  it("guard rejects synthetic distilled-prefix message rewrites", () => {
    // Regression for the gap in #748: accepting every messages[N] divergence
    // lets meta-distillation rewrites at messages[0/1] pass as "tail" growth.
    expect(isTailDivergence("messages[0].content")).toBe(false);
    expect(isTailDivergence("messages[1].content[0].text")).toBe(false);
    expect(isTailDivergence("messages[2].content[0].text")).toBe(true);
    expect(isTailDivergence("<end>")).toBe(true);
  });

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

  it("material LTM changes are replayed as durable prompt deltas without rewriting system[2]", async () => {
    const turns = Array.from({ length: 4 }, (_, i) => ({
      userMessage: `Delta turn ${i}: continue the work.`,
      assistantText: `Delta response ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const projectPath = `/tmp/lore-cache-stability-delta-${Date.now()}`;
    const clientSessionID = `cache-stability-delta-client-${Date.now()}`;
    const headers = {
      "x-lore-project": projectPath,
      "x-lore-session-id": clientSessionID,
    };

    const { ltm, setForceMinLayer } = await import("@loreai/core");
    const history: unknown[] = [];
    let sessionID = "";
    let contextID = "";
    let largeContextID = "";

    for (let i = 0; i < turns.length; i++) {
      if (i === 2) setForceMinLayer(4, sessionID);
      const resp = await harness.chat(
        makeBody(turns[i].userMessage, history),
        "test-key",
        headers,
      );
      expect(resp.status).toBe(200);
      await resp.json();

      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });

      if (i === 0) {
        const rows = harness.queryDB<{ session_id: string }>(
          "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
        );
        sessionID = rows[0]?.session_id ?? "";
        expect(sessionID).not.toBe("");
        contextID = ltm.create({
          projectPath,
          scope: "project",
          category: "gotcha",
          title: "Durable delta gotcha",
          content:
            "Initial context-bound knowledge that should be pinned in system[2].",
          session: sessionID,
        });
        largeContextID = ltm.create({
          projectPath,
          scope: "project",
          category: "architecture",
          title: "Large durable delta architecture",
          content:
            "Initial large context-bound knowledge that should be pinned before it changes. " +
            "Initial filler. ".repeat(160),
          session: sessionID,
        });
      }

      if (i === 1) {
        ltm.update(contextID, {
          content:
            "Updated context-bound knowledge that must arrive as a durable prompt delta, not a system[2] rewrite.",
        });
        ltm.update(largeContextID, {
          content:
            "Changed huge durable delta marker that must not be silently omitted from the persisted prompt delta. " +
            "Updated filler. ".repeat(160),
        });
      }

      if (i === 2) {
        // Simulate a gateway restart after the durable delta was persisted but
        // before the next request. The next turn must reconstruct the same
        // upstream prompt from session_prompt_deltas, not in-memory state.
        await harness.restartPipeline();
      }
    }

    const bodies = harness.upstreamBodies();
    expect(bodies.length).toBe(turns.length);

    // Turn 2 establishes system[2]. Turn 3 forces an emergency LTM refresh after
    // the knowledge entry changed. The update must be carried by a durable
    // prompt delta in messages, while cached system blocks remain byte-identical.
    const steadySystem = systemBlocks(bodies[1]);
    expect(systemBlocks(bodies[2])).toEqual(steadySystem);
    expect(systemBlocks(bodies[3])).toEqual(steadySystem);

    const turn3Messages = serializedMessages(bodies[2]);
    const turn4Messages = serializedMessages(bodies[3]);
    expect(turn3Messages).toContain("Lore knowledge update");
    expect(turn3Messages).toContain(
      "Updated context-bound knowledge that must arrive as a durable prompt delta",
    );
    expect(turn3Messages).toContain("Additional Changed Knowledge");
    expect(turn3Messages).toContain("Changed huge durable delta marker");
    expect(turn4Messages).toContain("Lore knowledge update");
    expect(turn4Messages).toContain(
      "Updated context-bound knowledge that must arrive as a durable prompt delta",
    );
    expect(turn4Messages).toContain("Changed huge durable delta marker");

    const rows = harness.queryDB<{
      seq: number;
      selector: string;
      content: string;
    }>(
      "SELECT seq, selector, content FROM session_prompt_deltas WHERE session_id = ? ORDER BY seq",
      [sessionID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(0);
    const selector = JSON.parse(rows[0].selector) as {
      target: string;
      insertAt: number;
    };
    expect(selector.target).toBe("messages");
    expect(Number.isInteger(selector.insertAt)).toBe(true);
    expect(rows[0].content).toContain("Updated context-bound knowledge");
    expect(rows[0].content).toContain("Changed huge durable delta marker");
  });

  it("budget-overflow knowledge surfaces as a recall-by-id ToC in system[1] (A) and the delta (B) [#917]", async () => {
    // End-to-end proof of the #917 wiring: knowledge that is relevance-scored
    // but doesn't fit the system[2] injection budget must reach the wire as a
    // recall-by-id table of contents — A in the frozen system[1] baseline
    // (present from turn 1), B in the durable knowledge delta (on material
    // change). The LTM budget floors at LTM_BUDGET_STEP (8000 tokens), so we
    // seed ~30 entries (~9K tokens total) to force a real overflow tail.
    //
    // Each entry's content stays UNDER the 1200-char knowledge cap: the pipeline
    // runs `ltm.pruneOversized(1200)` on every turn, which zeroes the confidence
    // of any oversized entry — pruned entries fall below the `confidence > 0.2`
    // floor and vanish from forSession/forProject, so oversized seeds never
    // reach the ToC at all.
    const turns = Array.from({ length: 4 }, (_, i) => ({
      // Mention the shared topic ("dashboard") so forSession's relevance scoring
      // keeps the whole seeded set in play — otherwise it filters to a handful
      // that all fit the budget and there is no overflow tail to surface.
      userMessage: `Turn ${i}: tell me more about the dashboard subsystem and its dashboard internals.`,
      assistantText: `Working on the dashboard ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const projectPath = `/tmp/lore-overflow-toc-${Date.now()}`;
    const clientSessionID = `overflow-toc-client-${Date.now()}`;
    const headers = {
      "x-lore-project": projectPath,
      "x-lore-session-id": clientSessionID,
    };

    const { ltm } = await import("@loreai/core");

    // Per-project config: a near-zero idle-resume threshold so that the small
    // real delay between turns counts as an "idle resume". Idle resume busts the
    // in-memory LTM session cache (gradient.onIdleResume → ltmSessionCache delete)
    // and forces a forSession recompute on the next turn — the path that turns a
    // pinned-system[2] knowledge change into a durable message delta (where B's
    // overflow ToC rides) instead of a direct system[2] rewrite.
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(
      `${projectPath}/.lore.json`,
      JSON.stringify({ idleResumeMinutes: 0.0005 }),
    );

    // Seed 30 project entries BEFORE the first request so they exist when
    // system[1] is first built (and frozen) on turn 0. ~310 tokens each ×30 ≈
    // 9.3K tokens > the 8000-token budget floor → guaranteed overflow tail when
    // forSession scores by confidence (no/sparse session context).
    const SEED_COUNT = 30;
    const seededIds: string[] = [];
    for (let i = 0; i < SEED_COUNT; i++) {
      seededIds.push(
        ltm.create({
          projectPath,
          scope: "project",
          crossProject: false,
          category: i % 2 ? "gotcha" : "pattern",
          title: `Dashboard subsystem note ${String(i).padStart(2, "0")}`,
          // ~900 chars (under the 1200-char prune cap), saturated with the
          // shared "dashboard" topic so every entry scores relevant to the
          // conversation and the full set competes for the budget.
          content:
            `Dashboard subsystem detail ${i}. ` +
            "The dashboard internals and dashboard pipeline matter here. ".repeat(
              15,
            ),
        }),
      );
    }

    const history: unknown[] = [];
    let sessionID = "";
    for (let i = 0; i < turns.length; i++) {
      // A small real delay so each turn (after the first) clears the near-zero
      // idle threshold → idle-resume recompute on the next turn.
      if (i > 0) await new Promise((r) => setTimeout(r, 80));

      const resp = await harness.chat(
        makeBody(turns[i].userMessage, history),
        "test-key",
        headers,
      );
      expect(resp.status).toBe(200);
      await resp.json();
      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });

      if (i === 0) {
        const rows = harness.queryDB<{ session_id: string }>(
          "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
        );
        sessionID = rows[0]?.session_id ?? "";
        expect(sessionID).not.toBe("");
      }

      if (i === 1) {
        // Material change to a pinned entry. The next turn's idle-resume recompute
        // detects the change and carries it (plus the #917 overflow tail) as a
        // durable message delta instead of rewriting the cached system[2] block.
        ltm.update(seededIds[0], {
          content:
            "Changed body that must arrive as a durable delta. " +
            "More filler to keep it material. ".repeat(20),
        });
      }
    }

    const bodies = harness.upstreamBodies();
    expect(bodies.length).toBe(turns.length);

    // --- A: frozen system[1] catalog, present from turn 0, byte-stable ---
    // The catalog lives in its own system block (system[1]); isolate it rather
    // than joining all blocks, since system[2] (full context-bound LTM) appears
    // from turn 2 and would otherwise pollute the comparison.
    const catalogBlock = (body: string): string | undefined =>
      systemBlocks(body).find((b) =>
        b.includes("Project knowledge (recall by id for detail)"),
      );
    const cat0 = catalogBlock(bodies[0]);
    expect(cat0).toBeDefined();
    // Renders a FULL recall-ready id (k:<uuid>), never an 8-char slice.
    expect(cat0 as string).toMatch(/\[k:[0-9a-f]{8}-[0-9a-f-]{27,}\]/);
    // 30 seeded, cap 15 → the remainder is summarized as "15 more".
    expect(cat0 as string).toMatch(/\b15 more\b/);
    // Frozen: the catalog block is byte-identical on a later turn.
    expect(catalogBlock(bodies[bodies.length - 1])).toEqual(cat0);

    // --- B: overflow ToC rides the durable knowledge delta after the material
    // change. Assert against the persisted session_prompt_deltas row (the source
    // of truth) rather than the replayed window, which Layer-4 compaction may
    // strip down. ---
    const deltaRows = harness.queryDB<{ content: string }>(
      "SELECT content FROM session_prompt_deltas WHERE session_id = ? ORDER BY seq",
      [sessionID],
    );
    const deltaText = deltaRows.map((r) => r.content).join("\n---\n");
    expect(deltaText).toContain(
      "## Other relevant knowledge (recall by id for detail)",
    );
    // The id in the B section is a full recall-ready k:<uuid> (the 8-char slice
    // handle used by the changed-entry section above it would not match this
    // pattern anchored at the B heading).
    expect(deltaText).toMatch(
      /Other relevant knowledge \(recall by id for detail\)[\s\S]*?\[k:[0-9a-f]{8}-[0-9a-f-]{27,}\]/,
    );
  });

  it("ranking churn with NO DB change emits NO delta and keeps the prefix byte-stable (the cause=incremental bust)", async () => {
    // T1 regression for the production bust (session 1LYkXZ7jkiHHnqPl): the delta
    // fired on per-turn relevance-ranking churn (the forSession selection picks a
    // different subset each turn) even though NO knowledge changed in the DB,
    // rewriting a deep-prefix message every turn → ~250k tokens rewritten per
    // turn. We force the recompute path (overflow set + near-zero idle-resume so
    // forSession re-scores every turn) and VARY the query topic each turn so the
    // selected subset churns — but never mutate the DB. The DB-sourced trigger
    // must emit ZERO delta rows, and the cached system prefix must stay
    // byte-identical. Under the old selection-based trigger, the churn wrote
    // (and rewrote) a "Superseded" delta → this test fails (mutation-verified).
    const topics = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const turns = Array.from({ length: 6 }, (_, i) => ({
      // Each turn foregrounds a DIFFERENT topic so forSession re-ranks which
      // entries are top-K → the selected subset churns turn-to-turn.
      userMessage: `Turn ${i}: focus on the ${topics[i % topics.length]} subsystem; tell me about ${topics[i % topics.length]} internals.`,
      assistantText: `Noted on ${topics[i % topics.length]} ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const projectPath = `/tmp/lore-rank-churn-${Date.now()}`;
    const clientSessionID = `rank-churn-client-${Date.now()}`;
    const headers = {
      "x-lore-project": projectPath,
      "x-lore-session-id": clientSessionID,
    };
    // Near-zero idle-resume threshold → each turn (after a tiny delay) clears it
    // → forSession recompute on the next turn (the path that can emit a delta).
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(
      `${projectPath}/.lore.json`,
      JSON.stringify({ idleResumeMinutes: 0.0005 }),
    );

    const { ltm } = await import("@loreai/core");
    // Seed many entries spread across the topics, enough to overflow the
    // system[2] budget so the SELECTED subset is a moving target as the query
    // topic changes — reproducing the ranking churn without any DB mutation.
    const SEED_PER_TOPIC = 6;
    for (const topic of topics) {
      for (let i = 0; i < SEED_PER_TOPIC; i++) {
        ltm.create({
          projectPath,
          scope: "project",
          crossProject: false,
          category: i % 2 ? "gotcha" : "pattern",
          title: `${topic} subsystem note ${String(i).padStart(2, "0")}`,
          content:
            `${topic} subsystem detail ${i}. ` +
            `The ${topic} internals and ${topic} pipeline matter here. `.repeat(
              15,
            ),
        });
      }
    }

    const history: unknown[] = [];
    let sessionID = "";
    for (let i = 0; i < turns.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 80));
      const resp = await harness.chat(
        makeBody(turns[i].userMessage, history),
        "test-key",
        headers,
      );
      expect(resp.status).toBe(200);
      await resp.json();
      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });
      if (i === 0) {
        const rows = harness.queryDB<{ session_id: string }>(
          "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
        );
        sessionID = rows[0]?.session_id ?? "";
        expect(sessionID).not.toBe("");
      }
      // NB: intentionally NO ltm.update / ltm.remove anywhere — the DB is frozen.
    }

    // The core guarantee: no genuine knowledge mutation → ZERO durable-delta
    // rows, regardless of how the relevance selection churned across turns.
    const deltaRows = harness.queryDB<{ seq: number; content: string }>(
      "SELECT seq, content FROM session_prompt_deltas WHERE session_id = ? ORDER BY seq",
      [sessionID],
    );
    expect(
      deltaRows.length,
      `expected ZERO delta rows on pure ranking churn (no DB change), got ` +
        `${deltaRows.length} — the selection-based trigger rewrote a delta on ` +
        `mere re-ranking, which is the cause=incremental bust`,
    ).toBe(0);

    // And the cached system prefix must be byte-identical once established
    // (turn 2+), proving the churn never rewrote system[2] either.
    const bodies = harness.upstreamBodies();
    const steady = systemBlocks(bodies[1]);
    for (let i = 2; i < bodies.length; i++) {
      expect(systemBlocks(bodies[i])).toEqual(steady);
    }
  });

  it("successive knowledge changes APPEND immutable blocks at the tail (no in-place rewrite)", async () => {
    // Append-only redesign: each genuine knowledge change appends a NEW
    // immutable block at the CURRENT tail (seq = MAX+1) rather than rewriting
    // one coalesced row in place at a frozen deep position. The cache-stability
    // guarantee is no longer "exactly one row" but "every block, once written,
    // is byte-immutable and tail-anchored" — so a write extends the cache
    // frontier instead of invalidating the prefix from a deep index (the
    // session-1LYkXZ7jkiHHnqPl `cause=incremental` bust). We assert: (a) one
    // block per DISTINCT change, (b) monotonically increasing insertAt
    // (tail-appended, never shifting the prefix), (c) earlier blocks are
    // byte-identical after later appends.
    const turns = Array.from({ length: 6 }, (_, i) => ({
      userMessage: `Coalesce turn ${i}: keep working.`,
      assistantText: `Coalesce response ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const projectPath = `/tmp/lore-cache-coalesce-${Date.now()}`;
    const clientSessionID = `cache-coalesce-client-${Date.now()}`;
    const headers = {
      "x-lore-project": projectPath,
      "x-lore-session-id": clientSessionID,
    };

    const { ltm, setForceMinLayer } = await import("@loreai/core");
    const history: unknown[] = [];
    let sessionID = "";
    let ctxID = "";
    // Snapshot block 0's bytes the first time it appears, to prove immutability.
    let block0First: { seq: number; selector: string; content: string } | null =
      null;

    for (let i = 0; i < turns.length; i++) {
      // Force emergency LTM refresh from turn 2 on, so each turn re-evaluates
      // the selected set and emits a delta when it changed.
      if (i >= 2 && sessionID) setForceMinLayer(4, sessionID);
      const resp = await harness.chat(
        makeBody(turns[i].userMessage, history),
        "test-key",
        headers,
      );
      expect(resp.status).toBe(200);
      await resp.json();
      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });

      if (i === 0) {
        const rows = harness.queryDB<{ session_id: string }>(
          "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
        );
        sessionID = rows[0]?.session_id ?? "";
        expect(sessionID).not.toBe("");
        ctxID = ltm.create({
          projectPath,
          scope: "project",
          category: "gotcha",
          title: "Coalesce gotcha",
          content: "Initial coalesce knowledge pinned in system[2].",
          session: sessionID,
        });
      }
      // Mutate the pinned entry on MULTIPLE successive turns → three DISTINCT
      // genuine changes (content hash differs each time).
      if (i === 1) ltm.update(ctxID, { content: "First change to coalesce." });
      if (i === 2) ltm.update(ctxID, { content: "Second change to coalesce." });
      if (i === 3) ltm.update(ctxID, { content: "Third change to coalesce." });

      // Capture block 0 the first turn any delta row exists.
      if (!block0First && sessionID) {
        const r = harness.queryDB<{
          seq: number;
          selector: string;
          content: string;
        }>(
          "SELECT seq, selector, content FROM session_prompt_deltas WHERE session_id = ? AND seq = 0",
          [sessionID],
        );
        if (r[0]) block0First = r[0];
      }
    }

    const rows = harness.queryDB<{
      seq: number;
      selector: string;
      content: string;
    }>(
      "SELECT seq, selector, content FROM session_prompt_deltas WHERE session_id = ? ORDER BY seq",
      [sessionID],
    );

    // One immutable block per distinct change (three edits → three blocks),
    // appended (not coalesced) with monotonically increasing seqs.
    expect(
      rows.length,
      `expected one appended block per distinct change, got seqs=${rows
        .map((r) => r.seq)
        .join(",")}`,
    ).toBe(3);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);

    // Tail-appended: insertAt is non-decreasing across blocks (each new block
    // sits at or after the previous — it never shifts the cached prefix).
    const insertAts = rows.map(
      (r) => (JSON.parse(r.selector) as { insertAt: number }).insertAt,
    );
    for (let i = 1; i < insertAts.length; i++) {
      expect(insertAts[i]).toBeGreaterThanOrEqual(insertAts[i - 1]);
    }

    // Immutability: block 0's bytes are identical to the first time it appeared,
    // even after blocks 1 and 2 were appended on later turns.
    expect(block0First).not.toBeNull();
    expect(rows[0].selector).toBe(block0First?.selector);
    expect(rows[0].content).toBe(block0First?.content);
  });

  it("supersessions on different turns are ALL preserved across the appended block sequence (incl. restart)", async () => {
    // Append-only correctness: two entries superseded on two different turns
    // must BOTH remain surfaced. In the append-only model each removal appends
    // its own immutable block, so the supersessions live across the SEQUENCE of
    // blocks (not one rewritten row). The advancing surfaced-set reconstruction
    // — frozen pin baseline + each block's stashed mutation signature — is what
    // keeps the earlier supersession from being dropped AND keeps the later one
    // from re-surfacing the earlier (already-surfaced) entry. The reconstruction
    // is durable: it is rebuilt purely from the persisted blocks, so it survives
    // a restart with no extra state. We exercise force layer 4 + a restart
    // between the two removals to prove it.
    const turns = Array.from({ length: 7 }, (_, i) => ({
      userMessage: `Cumulative turn ${i}: continue.`,
      assistantText: `Cumulative response ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const projectPath = `/tmp/lore-cache-cumulative-${Date.now()}`;
    const clientSessionID = `cache-cumulative-client-${Date.now()}`;
    const headers = {
      "x-lore-project": projectPath,
      "x-lore-session-id": clientSessionID,
    };

    const { ltm, setForceMinLayer } = await import("@loreai/core");
    const history: unknown[] = [];
    let sessionID = "";
    let idA = "";
    let idB = "";

    for (let i = 0; i < turns.length; i++) {
      // Force emergency LTM refresh from turn 2 on (where the durable-delta path
      // lives), matching the single-removal test.
      if (i >= 2 && sessionID) setForceMinLayer(4, sessionID);
      const resp = await harness.chat(
        makeBody(turns[i].userMessage, history),
        "test-key",
        headers,
      );
      expect(resp.status).toBe(200);
      await resp.json();
      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });

      if (i === 0) {
        const rows = harness.queryDB<{ session_id: string }>(
          "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
        );
        sessionID = rows[0]?.session_id ?? "";
        expect(sessionID).not.toBe("");
        // Create BOTH entries on turn 0 (before the pin freezes at turn 1), so
        // the frozen system[2] baseline contains both. We count superseded
        // BULLETS (not id prefixes) so same-ms UUIDv7 8-char-prefix collision is
        // irrelevant.
        idA = ltm.create({
          projectPath,
          scope: "project",
          category: "gotcha",
          title: "Cumulative entry A",
          content: "Entry A pinned in system[2] before removal. ".repeat(8),
          session: sessionID,
        });
        idB = ltm.create({
          projectPath,
          scope: "project",
          category: "gotcha",
          title: "Cumulative entry B",
          content: "Entry B pinned in system[2] before removal. ".repeat(8),
          session: sessionID,
        });
      }

      // Supersede A on turn 2, then restart (pin reloads frozen baseline from
      // DB), then supersede B on turn 4. Pre-fix (rolling baseline + coalesce),
      // the turn-4 delta drops A's supersession.
      if (i === 2) ltm.remove(idA);
      if (i === 3) await harness.restartPipeline();
      if (i === 4) ltm.remove(idB);
    }

    const rows = harness.queryDB<{ seq: number; content: string }>(
      "SELECT seq, content FROM session_prompt_deltas WHERE session_id = ? ORDER BY seq",
      [sessionID],
    );
    // Two distinct removals on two turns → two appended blocks (A's, then B's).
    expect(
      rows.length,
      `expected two appended supersession blocks, got seqs=${rows
        .map((r) => r.seq)
        .join(",")}`,
    ).toBe(2);

    // Across the WHOLE block sequence, BOTH A and B must be surfaced as
    // superseded — exactly once each (no drop, no duplicate re-surface despite
    // the restart between the two removals).
    const allText = rows
      .map((r) =>
        (JSON.parse(r.content) as { content: Array<{ text?: string }> }).content
          .map((b) => b.text ?? "")
          .join(""),
      )
      .join("\n");
    for (const r of rows) {
      const blockText = (
        JSON.parse(r.content) as { content: Array<{ text?: string }> }
      ).content
        .map((b) => b.text ?? "")
        .join("");
      expect(blockText).toContain("Superseded Long-term Knowledge");
    }
    const bulletCount = (allText.match(/\n\* \[/g) ?? []).length;
    expect(
      bulletCount,
      `expected 2 superseded bullets across the block sequence (A on turn 2, ` +
        `B on turn 4), got ${bulletCount}. A count of 1 means a supersession ` +
        `was dropped; >2 means an already-surfaced removal re-fired (the ` +
        `advancing surfaced-set didn't survive the restart). Blocks: ${allText}`,
    ).toBe(2);
  });

  it("removed LTM entries are replayed as durable superseded deltas without rewriting system[2]", async () => {
    const turns = Array.from({ length: 4 }, (_, i) => ({
      userMessage: `Removal delta turn ${i}: continue the work.`,
      assistantText: `Removal delta response ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const projectPath = `/tmp/lore-cache-stability-removal-${Date.now()}`;
    const headers = {
      "x-lore-project": projectPath,
      "x-lore-session-id": `cache-stability-removal-client-${Date.now()}`,
    };

    const { ltm, setForceMinLayer } = await import("@loreai/core");
    const history: unknown[] = [];
    let sessionID = "";
    let contextID = "";

    for (let i = 0; i < turns.length; i++) {
      if (i === 2) setForceMinLayer(4, sessionID);
      const resp = await harness.chat(
        makeBody(turns[i].userMessage, history),
        "test-key",
        headers,
      );
      expect(resp.status).toBe(200);
      await resp.json();

      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });

      if (i === 0) {
        const rows = harness.queryDB<{ session_id: string }>(
          "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
        );
        sessionID = rows[0]?.session_id ?? "";
        expect(sessionID).not.toBe("");
        contextID = ltm.create({
          projectPath,
          scope: "project",
          category: "gotcha",
          title: "Removed durable delta gotcha",
          content:
            "Context-bound knowledge that will be removed without rewriting system[2].",
          session: sessionID,
        });
      }

      if (i === 1) ltm.remove(contextID);

      if (i === 2) await harness.restartPipeline();
    }

    const bodies = harness.upstreamBodies();
    expect(bodies.length).toBe(turns.length);
    const steadySystem = systemBlocks(bodies[1]);
    expect(systemBlocks(bodies[2])).toEqual(steadySystem);
    expect(systemBlocks(bodies[3])).toEqual(steadySystem);

    const turn3Messages = serializedMessages(bodies[2]);
    const turn4Messages = serializedMessages(bodies[3]);
    expect(turn3Messages).toContain("Superseded Long-term Knowledge");
    expect(turn3Messages).toContain(contextID.slice(0, 8));
    expect(turn4Messages).toContain("Superseded Long-term Knowledge");
    expect(turn4Messages).toContain(contextID.slice(0, 8));

    const rows = harness.queryDB<{ content: string }>(
      "SELECT content FROM session_prompt_deltas WHERE session_id = ? ORDER BY seq",
      [sessionID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("Superseded Long-term Knowledge");
    expect(rows[0].content).toContain(contextID.slice(0, 8));
  });

  it("frozen system[1] survives a mid-session preference DELETE across a restart (ses_14b9bf3d… incident)", async () => {
    // Regression for the ses_14b9bf3d… cache-bust incident. system[1] (stable
    // LTM: preferences) used to live ONLY in an in-memory cache and be recomputed
    // from the live knowledge table whenever that cache went cold (idle resume
    // >=1h, session eviction, process restart). An idle consolidation deleted 25
    // entries mid-session; the next (post-idle) turn recomputed system[1] WITHOUT
    // them, changing the "stable" prefix and busting ~356K tokens of prompt cache.
    //
    // The fix (v45) persists the frozen system[1] text to session_state and
    // replays it byte-identically — never recomputing from the live DB
    // mid-session. This test reproduces the exact sequence: freeze system[1] with
    // a preference present, DELETE it, restart the gateway (drops the in-memory
    // cache), and assert the next turn's system[1] is byte-identical (restored
    // from the persisted pin, not recomputed from the now-deleted-entry DB).
    const turns = Array.from({ length: 3 }, (_, i) => ({
      userMessage: `Stable-pref turn ${i}: continue the work.`,
      assistantText: `Stable-pref response ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const projectPath = `/tmp/lore-stable-pref-freeze-${Date.now()}`;
    const headers = {
      "x-lore-project": projectPath,
      "x-lore-session-id": `stable-pref-client-${Date.now()}`,
    };

    const { ltm } = await import("@loreai/core");

    // Pre-seed TWO project-scoped preferences BEFORE the first turn so both are
    // present in system[1] when it freezes on turn 1.
    const prefA = ltm.create({
      projectPath,
      scope: "project",
      category: "preference",
      title: "Aaa first stable preference",
      content:
        "Always keep the system[1] prefix byte-stable for the session's life.",
    });
    ltm.create({
      projectPath,
      scope: "project",
      category: "preference",
      title: "Bbb second stable preference",
      content: "Prefer durable pins over mid-session recomputation.",
    });

    const history: unknown[] = [];
    let sessionID = "";
    for (let i = 0; i < turns.length; i++) {
      const resp = await harness.chat(
        makeBody(turns[i].userMessage, history),
        "test-key",
        headers,
      );
      expect(resp.status).toBe(200);
      await resp.json();
      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });

      if (i === 0) {
        const rows = harness.queryDB<{ session_id: string }>(
          "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
        );
        sessionID = rows[0]?.session_id ?? "";
        expect(sessionID).not.toBe("");
      }

      if (i === 1) {
        // Mid-session: a consolidation/curator delete removes a pinned
        // preference, then the gateway restarts (drops the in-memory stable LTM
        // cache). This is the exact ses_14b9bf3d… sequence.
        ltm.remove(prefA);
        await harness.restartPipeline();
      }
    }

    const bodies = harness.upstreamBodies();
    expect(bodies.length).toBe(turns.length);

    const sys1 = (b: string) => systemBlocks(b)[1];
    // Sanity: the deleted preference WAS rendered into the frozen system[1].
    expect(sys1(bodies[0])).toContain("Aaa first stable preference");
    // The invariant: turn 3 (post-delete, post-restart) replays the SAME frozen
    // system[1] bytes as turn 1 — restored from the persisted pin, not recomputed
    // from the now-deleted-entry knowledge table.
    expect(
      sys1(bodies[2]),
      "system[1] changed after a mid-session preference delete + restart — it " +
        "was recomputed from the live knowledge table instead of replaying the " +
        "persisted frozen pin (this is the ses_14b9bf3d… prefix bust)",
    ).toBe(sys1(bodies[0]));
  });

  it("an EMPTY system[1] is frozen too: a preference minted mid-session does not appear (no array-grow bust)", async () => {
    // Point-4 gap from the adversarial review: a session that starts with no
    // preferences/entities has an empty system[1] (the cache breakpoint falls on
    // the host block). Before the empty-baseline freeze, the compute path skipped
    // caching when `formatted` was empty, so it recomputed every turn — and the
    // moment the curator/pattern-extract minted a preference mid-session, system[1]
    // appeared, growing the system array and busting the prefix once. Freezing the
    // empty baseline keeps system[1] absent for the session's life (new prefs
    // surface next session).
    const turns = Array.from({ length: 3 }, (_, i) => ({
      userMessage: `Empty-stable turn ${i}: continue the work.`,
      assistantText: `Empty-stable response ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const projectPath = `/tmp/lore-empty-stable-${Date.now()}`;
    const headers = {
      "x-lore-project": projectPath,
      "x-lore-session-id": `empty-stable-client-${Date.now()}`,
    };

    const { ltm } = await import("@loreai/core");
    const history: unknown[] = [];
    for (let i = 0; i < turns.length; i++) {
      const resp = await harness.chat(
        makeBody(turns[i].userMessage, history),
        "test-key",
        headers,
      );
      expect(resp.status).toBe(200);
      await resp.json();
      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });

      // After the empty baseline is frozen on turn 1, mint a project preference
      // mid-session. With the freeze it must NOT appear as a new system[1] block.
      if (i === 0) {
        ltm.create({
          projectPath,
          scope: "project",
          category: "preference",
          title: "Mid-session minted preference",
          content:
            "This preference was minted after the empty system[1] baseline froze.",
        });
      }
    }

    const bodies = harness.upstreamBodies().map(normalizeBodyForComparison);
    const systems = bodies.map((b) => {
      const parsed = JSON.parse(b) as { system?: unknown };
      return JSON.stringify(parsed.system ?? null);
    });
    // The full system array must be byte-identical across all turns: the minted
    // preference does not grow the array (frozen empty system[1]).
    for (let i = 1; i < systems.length; i++) {
      expect(
        systems[i],
        `system array changed on turn ${i + 1} after a mid-session preference ` +
          `mint — the empty system[1] baseline was not frozen (array-grow bust)`,
      ).toBe(systems[0]);
    }
    // And the minted preference's title must NOT have leaked into the prompt.
    expect(bodies[2]).not.toContain("Mid-session minted preference");
  });

  it("normal LTM refresh preserves system[2] and emits durable removal deltas", async () => {
    const turns = Array.from({ length: 4 }, (_, i) => ({
      userMessage: `Normal removal delta turn ${i}: continue the work.`,
      assistantText: `Normal removal delta response ${i}.`,
    }));
    harness = await createHarness({
      fixtures: makeConversationFixtures(turns),
    });

    const projectPath = `/tmp/lore-cache-stability-normal-removal-${Date.now()}`;
    const headers = {
      "x-lore-project": projectPath,
      "x-lore-session-id": `cache-stability-normal-removal-client-${Date.now()}`,
    };

    const { ltm, setLastTurnAtForTest } = await import("@loreai/core");
    const history: unknown[] = [];
    let sessionID = "";
    let contextID = "";

    for (let i = 0; i < turns.length; i++) {
      const resp = await harness.chat(
        makeBody(turns[i].userMessage, history),
        "test-key",
        headers,
      );
      expect(resp.status).toBe(200);
      await resp.json();

      history.push({ role: "user", content: turns[i].userMessage });
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turns[i].assistantText }],
      });

      if (i === 0) {
        const rows = harness.queryDB<{ session_id: string }>(
          "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
        );
        sessionID = rows[0]?.session_id ?? "";
        expect(sessionID).not.toBe("");
        contextID = ltm.create({
          projectPath,
          scope: "project",
          category: "gotcha",
          title: "Normal removed durable delta gotcha",
          content:
            "Context-bound knowledge removed during normal refresh must not rewrite system[2].",
          session: sessionID,
        });
      }

      if (i === 1) {
        ltm.remove(contextID);
        setLastTurnAtForTest(sessionID, Date.now() - 10 * 60_000);
      }
    }

    const bodies = harness.upstreamBodies();
    expect(bodies.length).toBe(turns.length);
    const steadySystem = systemBlocks(bodies[1]);
    expect(systemBlocks(bodies[2])).toEqual(steadySystem);
    expect(systemBlocks(bodies[3])).toEqual(steadySystem);

    const turn3Messages = serializedMessages(bodies[2]);
    expect(turn3Messages).toContain("Superseded Long-term Knowledge");
    expect(turn3Messages).toContain(contextID.slice(0, 8));
  });

  it("cached system blocks stay byte-stable across gradient compression layers", async () => {
    // Regression guardrail for the #741 class of bugs: when the gradient
    // compresses context (layers 1-4), the cached system prefix (system[0] host
    // prompt, system[1] stable LTM, system[2] context-bound LTM) must NOT churn
    // turn-to-turn or as the compression layer changes. (#741 was a per-turn
    // "context health" note appended to system[2] whose wording varied by layer
    // — removed in #746 — that busted the conversation cache on every layer
    // oscillation.) This drives a real gateway over an inflated history that
    // forces compression and fabricates the LTM/distillation prefix directly
    // (no live model, no eval judge).
    const prevIdleTimeout = process.env.LORE_IDLE_TIMEOUT;
    process.env.LORE_IDLE_TIMEOUT = "3600"; // keep idle workers from firing
    try {
      const projectPath = `/tmp/lore-cache-stability-compressed-${Date.now()}`;
      const clientSessionID = `cache-stability-client-${Date.now()}`;
      const session = makeInflatedSession(projectPath);
      const indices = userTurnIndices(session.turns, 8);
      expect(indices.length).toBeGreaterThanOrEqual(8);

      harness = await createHarness({
        fixtures: makeInflatedFixtures(indices.length),
      });

      const {
        calibrate,
        resetCalibration,
        setForceMinLayer,
        setUrgentDistillationEnabledForTest,
      } = await import("../../core/src/gradient");
      resetCalibration();
      // Silence the urgent-distillation worker: it can't run with a fake API key
      // and would otherwise retry-loop (protocol-mismatch) during replay.
      setUrgentDistillationEnabledForTest(false);
      calibrate(0);

      const headers = {
        "x-lore-project": projectPath,
        "x-lore-session-id": clientSessionID,
      };
      const history: GatewayMessage[] = [];
      let callIndex = 0;
      let sessionID = "";
      let seeded: Awaited<ReturnType<typeof seedMemory>> | undefined;
      let peakLayer = 0;
      // Force a MINIMUM layer each turn (setForceMinLayer is one-shot). The
      // gradient's sticky-layer hysteresis blocks downward moves, so the
      // effective observed sequence escalates and holds rather than oscillating
      // back down — escalation across 1→4 is sufficient to exercise the bug.
      const forcedMinLayers = [1, 2, 1, 3, 4, 2, 1] as const;

      for (const turn of session.turns) {
        history.push(toGatewayMessage(turn));
        if (turn.role !== "user") continue;

        if (callIndex > 0) {
          setForceMinLayer(forcedMinLayers[callIndex - 1], sessionID);
        }

        const resp = await harness.chat(
          makeGatewayBody(history),
          "test-key",
          headers,
        );
        expect(resp.status).toBe(200);
        await resp.json();

        if (callIndex === 0) {
          const rows = harness.queryDB<{ session_id: string }>(
            "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
          );
          sessionID = rows[0]?.session_id ?? "";
          expect(sessionID).not.toBe("");
          seeded = await seedMemory(projectPath, sessionID);
        } else {
          peakLayer = Math.max(peakLayer, await observedLayer(sessionID));
        }

        // Raw LTM writes mid-session: these mutate the knowledge DB but, by
        // design, do NOT invalidate the warm per-session LTM cache/pin (only
        // idle refresh or in-flight curation do — both off here). So the
        // already-pinned system[1]/system[2] must stay byte-stable; new/updated
        // knowledge is deferred to the next cold boundary. This asserts a raw
        // write can't leak into the cached prefix.
        if (callIndex === 5 && seeded) {
          const { ltm } = await import("@loreai/core");
          ltm.update(seeded.preferenceID, {
            content:
              "Updated preference that must not rewrite the warm stable LTM block mid-session.",
          });
          ltm.update(seeded.contextID, {
            content:
              "Updated context-bound knowledge that must stay deferred while the warm pin is active.",
          });
          ltm.create({
            projectPath,
            scope: "project",
            category: "architecture",
            title: "New mid-session cache note",
            content:
              "Newly fabricated knowledge must not be injected into an already-pinned warm system block.",
            session: sessionID,
          });
        }

        callIndex++;
        if (callIndex >= indices.length) break;
      }

      // Guard against silent degradation: if a future calibration change let
      // the inflated history fit at layer 0, this test would stop exercising
      // compression entirely. Require it to have reached an aggressive layer.
      expect(
        peakLayer,
        `expected the inflated history to drive the gradient into a high ` +
          `compression layer, but the peak observed layer was ${peakLayer}`,
      ).toBeGreaterThanOrEqual(3);

      const bodies = harness.upstreamBodies();
      expect(bodies.length).toBe(indices.length);

      // Steady state begins on turn 2 (index 1), where system[2] is first
      // established. From there, every cached system block must be byte-
      // identical on every subsequent (compressed) turn — across layer
      // escalation and the mid-session LTM writes.
      const steadyBlocks = systemBlocks(bodies[1]);
      for (let i = 2; i < bodies.length; i++) {
        expect(
          systemBlocks(bodies[i]),
          `cached system blocks changed on turn ${i + 1} (forced min-layer ` +
            `${forcedMinLayers[i - 1] ?? "n/a"}) — a compression-layer change or ` +
            `mid-session LTM write must not bust the cached system prefix (#741)`,
        ).toEqual(steadyBlocks);
      }
    } finally {
      if (prevIdleTimeout === undefined) delete process.env.LORE_IDLE_TIMEOUT;
      else process.env.LORE_IDLE_TIMEOUT = prevIdleTimeout;
    }
  });

  it("raw-window start boundary does not march every turn across compressed turns", async () => {
    // Regression for the layer-1 raw-window pin march (session 0AVWKugtmhBKqLOX9):
    // once a large session compresses at layer 1 and the raw window sits at the
    // rawBudget ceiling, the pin must NOT re-pin at the ceiling and advance the
    // window START boundary ~2 messages every turn (which busts the prompt cache
    // mid-history every turn). The chunked-eviction fix evicts below the ceiling
    // so the boundary holds for many turns between steps.
    //
    // This is the gateway-level analogue of the core unit regression: we drive a
    // real multi-turn conversation through the gateway, then inspect each
    // UPSTREAM body and track the FIRST raw-window message (identified by its
    // unique marker). A marching boundary advances that first marker on (nearly)
    // every turn; the fix holds it for stretches. We avoid the full-body
    // divergence oracle here because at layer 1 it cannot distinguish legitimate
    // tail growth (high message index) from a real mid-history march.
    const prevIdleTimeout = process.env.LORE_IDLE_TIMEOUT;
    process.env.LORE_IDLE_TIMEOUT = "3600"; // keep idle workers from firing
    try {
      const projectPath = `/tmp/lore-window-march-${Date.now()}`;
      const clientSessionID = `window-march-client-${Date.now()}`;

      // Force a low layer-0 cap via project .lore.json so a ~125K session
      // compresses to layer 1 (the raw-window pin path) deterministically —
      // without depending on models.dev pricing being warm in the test. The
      // pipeline calls config.load(projectPath) per request, so this is honored.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(
        `${projectPath}/.lore.json`,
        JSON.stringify({ budget: { maxLayer0Tokens: 40000 } }),
      );

      // Large messages so the raw window overflows rawBudget and the gradient
      // pins a layer-1 SUB-window at the ceiling. Each message ≈ 8K tokens
      // (~24K chars), so a single user+assistant pair (~16K tokens) is a large
      // fraction of rawBudget — enough that one turn's growth trips the pin's
      // 15% hysteresis on its own. Pre-fix that forces a re-pin at the ceiling
      // and a boundary advance EVERY turn; the fix evicts a chunk so the
      // boundary holds for many turns between steps.
      const big = (label: string) =>
        `${label} ${"lorem ipsum dolor ".repeat(1_350)}`;
      const TOTAL_TURNS = 14;
      const BASE_PAIRS = 14; // ~28 base messages × ~8K ≈ 224K → well over budget

      const fixtures = Array.from({ length: TOTAL_TURNS }, (_, i) =>
        makeFixtureEntry({
          seq: i,
          requestMessages: [],
          responseText: big(`assistant reply ${i}`),
          model: DEFAULT_MODEL,
          // Realistic growing large input so calibrate() tracks the true body
          // size and the gradient pins a real layer-1 sub-window.
          inputTokens: 120_000 + i * 8_000,
          outputTokens: 1_200,
        }),
      );

      harness = await createHarness({ fixtures });

      const {
        calibrate,
        resetCalibration,
        setUrgentDistillationEnabledForTest,
      } = await import("../../core/src/gradient");
      resetCalibration();
      setUrgentDistillationEnabledForTest(false);
      calibrate(0);

      const headers = {
        "x-lore-project": projectPath,
        "x-lore-session-id": clientSessionID,
      };

      const history: GatewayMessage[] = [];
      for (let i = 0; i < BASE_PAIRS; i++) {
        history.push(
          toGatewayMessage(textTurn("user", big(`baseuser${i}end`))),
        );
        history.push(
          toGatewayMessage(textTurn("assistant", big(`baseasst${i}end`))),
        );
      }

      let sessionID = "";
      let peakLayer = 0;
      const observedLayers: number[] = [];
      for (let turn = 0; turn < TOTAL_TURNS; turn++) {
        history.push(
          toGatewayMessage(textTurn("user", big(`turnuser${turn}end`))),
        );
        const resp = await harness.chat(
          makeGatewayBody(history),
          "test-key",
          headers,
        );
        expect(resp.status).toBe(200);
        await resp.json();
        history.push(
          toGatewayMessage(textTurn("assistant", big(`turnasst${turn}end`))),
        );

        if (turn === 0) {
          const rows = harness.queryDB<{ session_id: string }>(
            "SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1",
          );
          sessionID = rows[0]?.session_id ?? "";
          expect(sessionID).not.toBe("");
        } else {
          const layer = await observedLayer(sessionID);
          peakLayer = Math.max(peakLayer, layer);
          observedLayers.push(layer);
        }
      }

      // The raw-window pin (tryFitStable) runs ONLY at layer 1 (stage 0); higher
      // layers use plain tryFit and reset the pin. So this test is only a valid
      // guard if the session is actually transformed AT layer 1. Assert the
      // steady-state turns sat at layer 1 — not layer 0 (no compression, no pin)
      // and not escalated to 2+ (different code path). If a future budget change
      // moved this session off layer 1, the test must fail loudly rather than
      // silently stop guarding the pin march.
      const layer1Turns = observedLayers.filter((l) => l === 1).length;
      expect(
        layer1Turns,
        `expected most steady-state turns at layer 1 (raw-window pin path), but ` +
          `observed layers were ${JSON.stringify(observedLayers)} (peak ${peakLayer})`,
      ).toBeGreaterThanOrEqual(Math.ceil(observedLayers.length / 2));

      const bodies = harness.upstreamBodies();
      expect(bodies.length).toBe(TOTAL_TURNS);

      // Track the FIRST raw-window message marker per turn. Markers look like
      // "baseuser12end" / "turnuser3end" / "baseasst5end".
      const markerRe = /(?:base|turn)(?:user|asst)\d+end/;
      const boundaries = bodies.map((b) => firstRawWindowMarker(b, markerRe));
      // All turns must have located a raw-window start (sanity).
      expect(boundaries.every((b) => b !== null)).toBe(true);

      // Count boundary advances and holds across steady-state turns (from turn 2
      // / index 1, after the layer-1 distilled prefix is established).
      let advances = 0;
      let holds = 0;
      let comparisons = 0;
      for (let i = 2; i < boundaries.length; i++) {
        comparisons++;
        if (boundaries[i] !== boundaries[i - 1]) advances++;
        else holds++;
      }
      // The bug is a boundary that marches on EVERY steady-state turn: it advances
      // every turn and never holds (the raw window is re-pinned at the ceiling, so
      // each turn's growth re-evicts). The chunked-eviction fix leaves headroom so
      // the boundary holds on at least some turns. Assert at least one held turn —
      // a per-turn march has zero holds, so this fails pre-fix (verified) and the
      // bound is robust to the harness's coarse per-turn step size.
      const detail =
        `advanced on ${advances}/${comparisons} steady-state turns (holds=${holds}, ` +
        `boundaries=${JSON.stringify(boundaries)})`;
      expect(
        holds,
        `raw-window start boundary marched on every steady-state turn — ${detail}. ` +
          `The layer-1 pin must hold the boundary on at least some turns, evicting ` +
          `only in occasional chunks (regression: per-turn window march).`,
      ).toBeGreaterThan(0);
    } finally {
      if (prevIdleTimeout === undefined) delete process.env.LORE_IDLE_TIMEOUT;
      else process.env.LORE_IDLE_TIMEOUT = prevIdleTimeout;
    }
  });

  // A full, signed billing-header sentinel — the exact shape BILLING_RESIGN_RE
  // matches. Quoting this verbatim in conversation content (e.g. while editing
  // cch.ts / cch.test.ts) is what an api-key user working on lore itself does.
  const QUOTED_SENTINEL =
    "x-anthropic-billing-header: cc_version=2.1.175.abc; cc_entrypoint=cli; cch=1a2b3;";

  it("api-key session: quoted billing-header sentinel in content is NOT re-signed and stays byte-stable (#cch-resign-gate)", async () => {
    // Regression: resignBody used to run on EVERY anthropic-protocol turn,
    // gated only on protocol — not on the presence of a REAL billing header.
    // For an api-key session whose CONTENT quotes the full sentinel, resignBody
    // would content-match it, rewrite its cc_version/cch every turn (busting
    // the prompt cache), and trip the verifyBillingHeaderUnique warning. The
    // fix gates the call on hasBillingHeader(req.system) — the `^`-anchored real
    // header — so a content copy never triggers re-signing.
    //
    // The harness sends via x-api-key (api-key auth) and never puts a real
    // billing header at system[0], so the gate must be false here.
    const warnings: string[] = [];
    const captureSink = {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
      captureException: () => {},
    };
    const silentSink = {
      info: () => {},
      warn: () => {},
      error: () => {},
      captureException: () => {},
    };
    log.registerSink(captureSink);
    try {
      const turns = [
        {
          userMessage: `Help me edit this code: ${QUOTED_SENTINEL}`,
          assistantText: "Sure, looking at it.",
        },
        {
          userMessage: `And this test fixture too: ${QUOTED_SENTINEL}`,
          assistantText: "Done.",
        },
        {
          userMessage: `One more reference: ${QUOTED_SENTINEL}`,
          assistantText: "Handled.",
        },
      ];
      harness = await createHarness({
        fixtures: makeConversationFixtures(turns),
      });

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

      // Guard: the precondition actually holds — the quoted sentinel reached
      // the upstream body verbatim (otherwise the test proves nothing).
      expect(
        bodies[0].includes("x-anthropic-billing-header:"),
        "expected the quoted sentinel to be present in the upstream body",
      ).toBe(true);

      // The meaningful, non-vacuous signal: the verifyBillingHeaderUnique
      // warning (the exact symptom seen in journalctl) must NOT fire. This runs
      // inside resignBody on the serialized body, so it is observable here even
      // though the replay interceptor captures the PRE-resign body object (and
      // therefore can't directly witness the cch rewrite — see the cch.test.ts
      // unit tests for the byte-level resign behaviour). Verified to FAIL on
      // revert: without the gate the warning fires once per turn (4 markers).
      expect(
        warnings.filter((w) => w.includes("first-block invariant violated")),
        "the billing-header invariant warning fired for an api-key session " +
          "whose content merely quotes the sentinel",
      ).toHaveLength(0);

      // Sanity guard: the quoted sentinel reached the captured (pre-resign)
      // body verbatim, confirming the precondition the warning check relies on.
      for (let i = 0; i < bodies.length; i++) {
        expect(
          bodies[i].includes("cch=1a2b3;"),
          `turn ${i + 1}: quoted sentinel missing from captured body`,
        ).toBe(true);
      }
    } finally {
      log.registerSink(silentSink);
    }
  });
});
