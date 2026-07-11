/**
 * End-to-end regression tests for restart-proof session adoption (issue #796).
 *
 * Scenario: a long conversation is distilled, then lore+opencode RESTART, and
 * the client resumes the conversation under a FRESH `x-lore-session-id`. Before
 * the fix, the in-memory session index is empty after a restart and the
 * persisted fingerprint is not value-searchable, so the resumed conversation
 * was treated as brand-new — orphaning the prior session's distillations,
 * gradient calibration, and LTM pin.
 *
 * Tier 3b recovers the prior session from its persisted fingerprint, CONFIRMS
 * it by content-hash overlap of the leading user messages (scoped to the
 * project), and ADOPTS its id — so the resumed conversation inherits the prior
 * state instead of cold-starting.
 *
 * These tests drive the full pipeline (handleRequest -> identifySession) through
 * the real HTTP server, simulate a restart via `harness.restartPipeline()`
 * (clears in-memory maps, keeps the DB), and assert on session_state rows.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  makeFixtureEntry,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";

const U0 = "alpha first task: please implement the parser module";
const U1 = "second follow-up: now add tests for the parser";
const U2 = "third instruction after the restart: refactor the helper";

function body(messages: Array<{ role: string; content: string }>) {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages,
    tools: STANDARD_TOOLS,
  };
}

// Replay is order-based and ignores request content, so plain text fixtures
// suffice; assistant text does not affect user-message content-hash IDs.
function fixtures() {
  return [
    makeFixtureEntry({ seq: 0, requestMessages: [], responseText: "A0 done." }),
    makeFixtureEntry({ seq: 1, requestMessages: [], responseText: "A1 done." }),
    makeFixtureEntry({ seq: 2, requestMessages: [], responseText: "A2 done." }),
  ];
}

type Row = { session_id: string; header_session_id: string | null };

function loreSessionRows(h: Harness): Row[] {
  return h.queryDB<Row>(
    "SELECT session_id, header_session_id FROM session_state WHERE header_name = 'x-lore-session-id'",
  );
}

describe("issue #796: restart-proof session adoption (Tier 3b)", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  it("adopts the prior session when a resumed conversation arrives under a new x-lore-session-id after restart", async () => {
    harness = await createHarness({ fixtures: fixtures() });

    // Turn 1 (new session under V1) — persists fingerprint + stores u0.
    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
    expect(r.status).toBe(200);
    await r.text();

    // Turn 2 (same session V1 continues) — stores u1, updates message_count.
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "V1" },
    );
    expect(r.status).toBe(200);
    await r.text();

    // Exactly one conversation session so far, bound to V1.
    let rows = loreSessionRows(harness);
    expect(rows.length).toBe(1);
    expect(rows[0].header_session_id).toBe("V1");
    const s1 = rows[0].session_id;

    // --- Simulate restart: in-memory maps cleared, DB preserved. ---
    await harness.restartPipeline();

    // Resume the SAME conversation under a NEW x-lore-session-id (V2).
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      { "x-lore-session-id": "V2" },
    );
    expect(r.status).toBe(200);
    await r.text();

    // Adopted: still ONE conversation session (no new row), same internal id,
    // now rebound to the new header value for the Tier-1 fast path.
    rows = loreSessionRows(harness);
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe(s1);
    expect(rows[0].header_session_id).toBe("V2");
  });

  it("does NOT adopt when the resumed conversation has a different fingerprint (different first message)", async () => {
    harness = await createHarness({ fixtures: fixtures() });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
    expect(r.status).toBe(200);
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "V1" },
    );
    expect(r.status).toBe(200);
    await r.text();

    await harness.restartPipeline();

    // A genuinely different conversation (different first user message) under a
    // new header → fingerprint miss → must create a NEW session, not adopt.
    r = await harness.chat(
      body([{ role: "user", content: "completely unrelated opening task" }]),
      "key-A",
      { "x-lore-session-id": "V2" },
    );
    expect(r.status).toBe(200);
    await r.text();

    const rows = loreSessionRows(harness);
    expect(rows.length).toBe(2);
  });

  it("does NOT adopt across projects (overlap is project-scoped)", async () => {
    harness = await createHarness({ fixtures: fixtures() });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
    expect(r.status).toBe(200);
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "V1" },
    );
    expect(r.status).toBe(200);
    await r.text();

    await harness.restartPipeline();

    // Same fingerprint (same first message + key) but a DIFFERENT project: the
    // content-overlap query is project-scoped, so it finds zero overlap and must
    // not adopt.
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      {
        "x-lore-session-id": "V2",
        "x-lore-project": "/tmp/lore-other-project",
      },
    );
    expect(r.status).toBe(200);
    await r.text();

    const rows = loreSessionRows(harness);
    expect(rows.length).toBe(2);
  });
});
