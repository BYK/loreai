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
});
