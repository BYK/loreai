/**
 * End-to-end (harness) regression tests for the Tier 1b session-merge bug.
 *
 * THE BUG (proven via live reproduction against a real remote gateway):
 * Claude Code mints a FRESH `x-claude-code-session-id` UUID per *conversation*
 * (not per process). The gateway's Tier 1b "header value rotation detection"
 * treated a new value as a client restart and RESUMED the single existing
 * session — merging two unrelated conversations into one session and rebinding
 * its project to whichever request arrived last. On a remote/multi-client
 * gateway this silently merged the work of different projects (and different
 * machines/users) into one session and one project, leaking memory across
 * conversations.
 *
 * These tests drive the FULL pipeline (handleRequest → identifySession →
 * resolveSessionProjectPath) through the real HTTP server and assert that
 * distinct `x-claude-code-session-id` values ALWAYS produce distinct sessions
 * and that their projects never get cross-bound.
 *
 * Complements the unit-level `isRotationEligible` / `findRotationPredecessor`
 * tests in session.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  makeConversationFixtures,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";

function body(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: STANDARD_TOOLS,
  };
}

interface SessionRow {
  session_id: string;
  header_session_id: string | null;
  header_name: string | null;
  project_path: string | null;
  project_path_provisional: number;
}

describe("Tier 1b session-merge regression (x-claude-code-session-id)", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.teardown();
  });

  it("does NOT merge two distinct Claude Code conversations into one session", async () => {
    harness = await createHarness({
      fixtures: [
        ...makeConversationFixtures([
          { userMessage: "conversation one alpha", assistantText: "A1." },
        ]),
        ...makeConversationFixtures([
          { userMessage: "conversation two beta", assistantText: "B1." },
        ]),
      ],
    });

    // First conversation: fresh claude-code session id + project /proj/alpha.
    const r1 = await harness.chat(body("conversation one alpha"), "key-A", {
      "x-claude-code-session-id": "11111111-1111-1111-1111-111111111111",
      "x-lore-project": "/proj/alpha",
    });
    expect(r1.status).toBe(200);
    await r1.text();

    // Second conversation: DIFFERENT claude-code session id + project /proj/beta.
    // Pre-fix, Tier 1b would "resume" the first session and rebind it to
    // /proj/beta. Post-fix, this MUST create a second, independent session.
    const r2 = await harness.chat(body("conversation two beta"), "key-B", {
      "x-claude-code-session-id": "22222222-2222-2222-2222-222222222222",
      "x-lore-project": "/proj/beta",
    });
    expect(r2.status).toBe(200);
    await r2.text();

    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, header_session_id, header_name, project_path, project_path_provisional FROM session_state ORDER BY rowid",
    );

    // TWO distinct internal sessions — the core regression assertion. Pre-fix
    // this was 1 (the second conversation merged into the first via rotation).
    expect(sessions.length).toBe(2);
    expect(new Set(sessions.map((s) => s.session_id)).size).toBe(2);

    // Each session bound to its OWN project — no cross-binding. (Pre-fix the
    // single merged session would show only the LAST project, /proj/beta.)
    const paths = new Set(sessions.map((s) => s.project_path));
    expect(paths).toEqual(new Set(["/proj/alpha", "/proj/beta"]));
    // Both confidently bound (header source), neither provisional.
    for (const s of sessions) {
      expect(s.project_path_provisional).toBe(0);
    }

    // Both header-bound projects exist as distinct rows.
    const projects = harness.queryDB<{ path: string }>(
      "SELECT path FROM projects WHERE path IN ('/proj/alpha', '/proj/beta')",
    );
    expect(new Set(projects.map((p) => p.path))).toEqual(
      new Set(["/proj/alpha", "/proj/beta"]),
    );
  });

  it("resumes the SAME session when the same Claude Code session id repeats", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "turn one", assistantText: "T1." },
        { userMessage: "turn two", assistantText: "T2." },
      ]),
    });

    const sameId = "33333333-3333-3333-3333-333333333333";

    const r1 = await harness.chat(body("turn one"), "key-A", {
      "x-claude-code-session-id": sameId,
      "x-lore-project": "/proj/gamma",
    });
    expect(r1.status).toBe(200);
    await r1.text();

    const r2 = await harness.chat(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        stream: false,
        system: DEFAULT_SYSTEM,
        messages: [
          { role: "user", content: "turn one" },
          { role: "assistant", content: "T1." },
          { role: "user", content: "turn two" },
        ],
        tools: STANDARD_TOOLS,
      },
      "key-A",
      {
        "x-claude-code-session-id": sameId,
        "x-lore-project": "/proj/gamma",
      },
    );
    expect(r2.status).toBe(200);
    await r2.text();

    // Same header value across turns → ONE session (legitimate resumption).
    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state",
    );
    expect(sessions.length).toBe(1);
    expect(sessions[0].project_path).toBe("/proj/gamma");
  });

  it("does not cross-bind projects across many concurrent Claude Code sessions", async () => {
    // Simulate several unrelated conversations interleaved (e.g. two machines
    // sharing a remote gateway). Each must stay isolated.
    const ids = [
      ["aaaaaaaa-0000-0000-0000-000000000001", "/proj/one"],
      ["bbbbbbbb-0000-0000-0000-000000000002", "/proj/two"],
      ["cccccccc-0000-0000-0000-000000000003", "/proj/three"],
    ] as const;

    harness = await createHarness({
      fixtures: [
        ...makeConversationFixtures([
          { userMessage: "msg one", assistantText: "R1." },
        ]),
        ...makeConversationFixtures([
          { userMessage: "msg two", assistantText: "R2." },
        ]),
        ...makeConversationFixtures([
          { userMessage: "msg three", assistantText: "R3." },
        ]),
      ],
    });

    const msgs = ["msg one", "msg two", "msg three"];
    for (let i = 0; i < ids.length; i++) {
      const [id, proj] = ids[i];
      const r = await harness.chat(body(msgs[i]), `key-${i}`, {
        "x-claude-code-session-id": id,
        "x-lore-project": proj,
      });
      expect(r.status).toBe(200);
      await r.text();
    }

    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, header_session_id, project_path FROM session_state",
    );
    // Three distinct sessions, each on its own project (pre-fix: 1 session).
    expect(sessions.length).toBe(3);
    expect(new Set(sessions.map((s) => s.session_id)).size).toBe(3);
    expect(new Set(sessions.map((s) => s.project_path))).toEqual(
      new Set(["/proj/one", "/proj/two", "/proj/three"]),
    );
  });
});

describe("Tier 1b rotation: x-session-affinity (OpenCode nanoid) still rotates safely", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.teardown();
  });

  it("refuses rotation when the incoming confident project differs (Fix 2)", async () => {
    // OpenCode's x-session-affinity IS rotation-eligible. But a "restart" that
    // arrives with a DIFFERENT confident X-Lore-Project must NOT re-home the
    // old session — it must create a new one (cross-project contamination
    // guard). This is the OpenCode analogue of the Claude Code bug.
    harness = await createHarness({
      fixtures: [
        ...makeConversationFixtures([
          { userMessage: "opencode one", assistantText: "O1." },
        ]),
        ...makeConversationFixtures([
          { userMessage: "opencode two", assistantText: "O2." },
        ]),
      ],
    });

    const r1 = await harness.chat(body("opencode one"), "key-A", {
      "x-session-affinity": "nanoid-old-aaaa",
      "x-lore-project": "/proj/oc-alpha",
    });
    expect(r1.status).toBe(200);
    await r1.text();

    // New nanoid (looks like a restart) BUT a different confident project.
    const r2 = await harness.chat(body("opencode two"), "key-A", {
      "x-session-affinity": "nanoid-new-bbbb",
      "x-lore-project": "/proj/oc-beta",
    });
    expect(r2.status).toBe(200);
    await r2.text();

    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state",
    );
    // Two distinct sessions — the rotation was refused due to project mismatch.
    expect(sessions.length).toBe(2);
    expect(new Set(sessions.map((s) => s.project_path))).toEqual(
      new Set(["/proj/oc-alpha", "/proj/oc-beta"]),
    );
  });

  it("allows rotation when the project is unchanged (genuine restart)", async () => {
    // Same project, new nanoid → legitimate OpenCode restart → resume the
    // SAME session (the original purpose of Tier 1b).
    harness = await createHarness({
      fixtures: [
        ...makeConversationFixtures([
          { userMessage: "restart one", assistantText: "S1." },
        ]),
        ...makeConversationFixtures([
          { userMessage: "restart two", assistantText: "S2." },
        ]),
      ],
    });

    const r1 = await harness.chat(body("restart one"), "key-A", {
      "x-session-affinity": "nanoid-before-restart",
      "x-lore-project": "/proj/oc-same",
    });
    expect(r1.status).toBe(200);
    await r1.text();

    const r2 = await harness.chat(body("restart two"), "key-A", {
      "x-session-affinity": "nanoid-after-restart",
      "x-lore-project": "/proj/oc-same",
    });
    expect(r2.status).toBe(200);
    await r2.text();

    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state",
    );
    // ONE session — the rotation resumed the original (same project).
    expect(sessions.length).toBe(1);
    expect(sessions[0].project_path).toBe("/proj/oc-same");
  });

  it("allows rotation when no X-Lore-Project header is sent (Fix 2 is a no-op)", async () => {
    // When the incoming request has no confident project header, Fix 2 cannot
    // compare projects → rotation proceeds as before (benign restart).
    harness = await createHarness({
      fixtures: [
        ...makeConversationFixtures([
          { userMessage: "no-header one", assistantText: "N1." },
        ]),
        ...makeConversationFixtures([
          { userMessage: "no-header two", assistantText: "N2." },
        ]),
      ],
    });

    const r1 = await harness.chat(body("no-header one"), "key-A", {
      "x-session-affinity": "nanoid-before",
      "x-lore-project": "/proj/same",
    });
    expect(r1.status).toBe(200);
    await r1.text();

    // Settle: under extreme parallel-suite load (vitest worker reuse across
    // files), a stale async task may momentarily re-populate headerSessionIndex
    // after harness setup, creating duplicate x-session-affinity entries that
    // make findRotationPredecessor bail (ambiguous → no rotation → 2 sessions).
    // A small await drains any lingering microtasks from setup/teardown so only
    // the current test's entries are present. #859
    await new Promise((r) => setTimeout(r, 0));

    // Second request: new nanoid, NO x-lore-project header at all.
    const r2 = await harness.chat(body("no-header two"), "key-A", {
      "x-session-affinity": "nanoid-after",
      "x-lore-project": "", // empty = suppressed by harness
    });
    expect(r2.status).toBe(200);
    await r2.text();

    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state",
    );
    // ONE session — rotation proceeded (Fix 2 was a no-op, no incoming project).
    expect(sessions.length).toBe(1);
  });
});

describe("Tier 1b: x-lore-session-id isolation (Lore plugin stable ID)", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.teardown();
  });

  it("does NOT merge two distinct x-lore-session-id values into one session", async () => {
    // x-lore-session-id is the highest-priority known header and is NOT
    // rotation-eligible (deterministic, stable per session). Same code path
    // as x-claude-code-session-id — a new value always means a new session.
    harness = await createHarness({
      fixtures: [
        ...makeConversationFixtures([
          { userMessage: "lore-session alpha", assistantText: "LA." },
        ]),
        ...makeConversationFixtures([
          { userMessage: "lore-session beta", assistantText: "LB." },
        ]),
      ],
    });

    const r1 = await harness.chat(body("lore-session alpha"), "key-A", {
      "x-lore-session-id": "stable-session-AAA",
      "x-lore-project": "/proj/ls-alpha",
    });
    expect(r1.status).toBe(200);
    await r1.text();

    const r2 = await harness.chat(body("lore-session beta"), "key-A", {
      "x-lore-session-id": "stable-session-BBB",
      "x-lore-project": "/proj/ls-beta",
    });
    expect(r2.status).toBe(200);
    await r2.text();

    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state",
    );
    // Two distinct sessions — x-lore-session-id never rotates.
    expect(sessions.length).toBe(2);
    expect(new Set(sessions.map((s) => s.project_path))).toEqual(
      new Set(["/proj/ls-alpha", "/proj/ls-beta"]),
    );
  });
});
