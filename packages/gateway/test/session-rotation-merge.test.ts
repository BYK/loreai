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
import { DatabaseSync } from "node:sqlite";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  makeConversationFixtures,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";
import { enableHostedMode, _resetHostedModeForTest } from "@loreai/core";

// A faithful Claude Code coding turn carries the anchored OAuth billing header
// at system[0] (Claude Code emits it whenever `_CLAUDE_CODE_ASSUME_FIRST_PARTY_
// BASE_URL=1`, which `lore run`/`lore setup` always set). Without it — and
// without a "Working directory:" line — a request bearing an
// `x-claude-code-session-id` is indistinguishable from a Claude Code
// side-channel call (auto-mode classifier / title gen), which the pipeline
// now forwards upstream untouched (see side-channel.test.ts). These
// session-identification regression tests exercise REAL coding turns, so they
// must present the coding-turn system prompt.
const CC_BILLING_HEADER =
  "x-anthropic-billing-header: cc_version=2.1.186; cc_entrypoint=cli; cch=a75d0;\n";
const CC_CODING_SYSTEM = CC_BILLING_HEADER + DEFAULT_SYSTEM;

function body(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: CC_CODING_SYSTEM,
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
  credential_fingerprint: string;
}

describe("Tier 1b session-merge regression (x-claude-code-session-id)", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
    _resetHostedModeForTest();
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

    // Scope to this test's session header. Background tasks (curator / idle /
    // gradient) call saveSessionTracking(), whose INSERT OR IGNORE writes a
    // header-NULL row. Under parallel-suite load an in-flight background write
    // from a prior harness can land in this harness's DB (shared db() singleton
    // across harnesses) → a phantom row that inflates an unscoped count. Filter
    // by header_name so we count only real rotation-relevant sessions; a genuine
    // rotation refusal still writes a header_name row, so this never masks the
    // bug under test. #859
    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, header_session_id, header_name, project_path, project_path_provisional FROM session_state WHERE header_name = 'x-claude-code-session-id' ORDER BY rowid",
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
    // Scoped by header_name to ignore phantom header-NULL rows (see #859 note above).
    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state WHERE header_name = 'x-claude-code-session-id'",
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

    // Scoped by header_name to ignore phantom header-NULL rows (see #859 note above).
    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, header_session_id, project_path FROM session_state WHERE header_name = 'x-claude-code-session-id'",
    );
    // Three distinct sessions, each on its own project (pre-fix: 1 session).
    expect(sessions.length).toBe(3);
    expect(new Set(sessions.map((s) => s.session_id)).size).toBe(3);
    expect(new Set(sessions.map((s) => s.project_path))).toEqual(
      new Set(["/proj/one", "/proj/two", "/proj/three"]),
    );
  });
});

describe("x-session-affinity restart adoption", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
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

    // Scoped by header_name to ignore phantom header-NULL rows (see #859 note above).
    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state WHERE header_name = 'x-session-affinity'",
    );
    // Two distinct sessions — the rotation was refused due to project mismatch.
    expect(sessions.length).toBe(2);
    expect(new Set(sessions.map((s) => s.project_path))).toEqual(
      new Set(["/proj/oc-alpha", "/proj/oc-beta"]),
    );
  });

  it("resumes a genuine restart only with project-scoped multi-message overlap", async () => {
    // A new nanoid is not continuity evidence by itself. A genuine OpenCode
    // restart resumes only after fingerprint adoption confirms at least two
    // leading user messages in the same project.
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "restart one", assistantText: "S1." },
        { userMessage: "restart two", assistantText: "S2." },
        { userMessage: "restart three", assistantText: "S3." },
      ]),
    });

    let r1 = await harness.chat(body("restart one"), "key-A", {
      "x-session-affinity": "nanoid-before-restart",
      "x-lore-project": "/proj/oc-same",
    });
    expect(r1.status).toBe(200);
    await r1.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    r1 = await harness.chat(
      {
        ...body("restart two"),
        messages: [
          { role: "user", content: "restart one" },
          { role: "assistant", content: "S1." },
          { role: "user", content: "restart two" },
        ],
      },
      "key-A",
      {
        "x-session-affinity": "nanoid-before-restart",
        "x-lore-project": "/proj/oc-same",
      },
    );
    expect(r1.status).toBe(200);
    await r1.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const r2 = await harness.chat(
      {
        ...body("restart three"),
        messages: [
          { role: "user", content: "restart one" },
          { role: "assistant", content: "S1." },
          { role: "user", content: "restart two" },
          { role: "assistant", content: "S2." },
          { role: "user", content: "restart three" },
        ],
      },
      "key-A",
      {
        "x-session-affinity": "nanoid-after-restart",
        "x-lore-project": "/proj/oc-same",
      },
    );
    expect(r2.status).toBe(200);
    await r2.text();

    // Scoped by header_name to ignore phantom header-NULL rows (see #859 note above).
    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state WHERE header_name = 'x-session-affinity'",
    );
    // ONE session — the rotation resumed the original (same project).
    expect(sessions.length).toBe(1);
    expect(sessions[0].project_path).toBe("/proj/oc-same");
  });

  it("does not let an arbitrary pathless fresh affinity take over", async () => {
    // The same credential and header name are not continuity proof. With no
    // project-scoped content overlap, a pathless fresh affinity stays isolated.
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

    // Second request: new nanoid, NO x-lore-project header at all.
    const r2 = await harness.chat(body("no-header two"), "key-A", {
      "x-session-affinity": "nanoid-after",
      "x-lore-project": "", // empty = suppressed by harness
    });
    expect(r2.status).toBe(200);
    await r2.text();

    // Scoped by header_name to ignore phantom header-NULL rows (see #859 note
    // above). This is what previously flaked: an unscoped count picked up a
    // phantom row from a leaked background write and read 2 instead of 1.
    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state WHERE header_name = 'x-session-affinity'",
    );
    expect(sessions.length).toBe(2);
    expect(new Set(sessions.map((session) => session.session_id)).size).toBe(2);
  });

  it("does not bypass project-scoped overlap through a conflicting remote", async () => {
    enableHostedMode();
    const projectPath = "/client/projects/rotation-backfill";
    const conflictingPath = "/client/projects/rotation-backfill-clone";
    const remote = `github.com/test/rotation-${crypto.randomUUID()}`;
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "rotation merge first", assistantText: "First." },
        { userMessage: "rotation merge second", assistantText: "Second." },
        { userMessage: "rotation merge third", assistantText: "Third." },
      ]),
    });

    let response = await harness.chat(body("rotation merge first"), "key-A", {
      "x-session-affinity": "rotation-merge-before",
      "x-lore-project": projectPath,
    });
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    response = await harness.chat(
      {
        ...body("rotation merge second"),
        messages: [
          { role: "user", content: "rotation merge first" },
          { role: "assistant", content: "First." },
          { role: "user", content: "rotation merge second" },
        ],
      },
      "key-A",
      {
        "x-session-affinity": "rotation-merge-before",
        "x-lore-project": projectPath,
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Adversarial order: the path-only project already exists, then a clone
    // carrying its remote arrives before the provisional rotation commits.
    // Backfilling projectPath now has to merge this conflicting remote row.
    const conflictingId = crypto.randomUUID();
    const database = new DatabaseSync(harness.dbPath);
    try {
      database
        .prepare(
          "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          conflictingId,
          conflictingPath,
          "rotation-backfill-clone",
          remote,
          Date.now(),
        );
    } finally {
      database.close();
    }

    response = await harness.chat(
      {
        ...body("rotation merge third"),
        messages: [
          { role: "user", content: "rotation merge first" },
          { role: "assistant", content: "First." },
          { role: "user", content: "rotation merge second" },
          { role: "assistant", content: "Second." },
          { role: "user", content: "rotation merge third" },
        ],
      },
      "key-A",
      {
        "x-session-affinity": "rotation-merge-after",
        "x-lore-project": projectPath,
        "x-lore-git-remote": remote,
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const sessions = harness.queryDB<SessionRow & { message_count: number }>(
      `SELECT session_id, header_session_id, header_name, project_path,
              project_path_provisional, credential_fingerprint, message_count
         FROM session_state
        WHERE header_name = 'x-session-affinity'`,
    );
    expect(sessions).toHaveLength(2);
    const rotated = sessions.find(
      (session) => session.header_session_id === "rotation-merge-after",
    );
    expect(rotated).toMatchObject({
      header_session_id: "rotation-merge-after",
      project_path: projectPath,
      project_path_provisional: 0,
      message_count: 5,
    });
    expect(
      harness.queryDB<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND content LIKE ?",
        [rotated?.session_id, "%rotation merge third%"],
      )[0]?.count,
    ).toBeGreaterThan(0);
    expect(
      harness.queryDB<{ count: number }>(
        "SELECT COUNT(*) AS count FROM projects WHERE id = ?",
        [conflictingId],
      )[0]?.count,
    ).toBe(0);
  });
});

describe("Tier 1b: x-lore-session-id isolation (Lore plugin stable ID)", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
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

    // Scoped by header_name to ignore phantom header-NULL rows (see #859 note above).
    const sessions = harness.queryDB<SessionRow>(
      "SELECT session_id, project_path FROM session_state WHERE header_name = 'x-lore-session-id'",
    );
    // Two distinct sessions — x-lore-session-id never rotates.
    expect(sessions.length).toBe(2);
    expect(new Set(sessions.map((s) => s.project_path))).toEqual(
      new Set(["/proj/ls-alpha", "/proj/ls-beta"]),
    );
  });

  it("does not share one session header across credentials", async () => {
    harness = await createHarness({
      fixtures: [
        ...makeConversationFixtures([
          { userMessage: "credential alpha", assistantText: "A." },
        ]),
        ...makeConversationFixtures([
          { userMessage: "credential beta", assistantText: "B." },
        ]),
      ],
    });
    const sessionHeader = "shared-by-two-clients";

    const first = await harness.chat(body("credential alpha"), "key-A", {
      "x-lore-session-id": sessionHeader,
      "x-lore-project": "/proj/shared",
    });
    expect(first.status).toBe(200);
    await first.text();

    const second = await harness.chat(body("credential beta"), "key-B", {
      "x-lore-session-id": sessionHeader,
      "x-lore-project": "/proj/shared",
    });
    expect(second.status).toBe(200);
    await second.text();

    const rows = harness.queryDB<SessionRow>(
      `SELECT session_id, credential_fingerprint
         FROM session_state
        WHERE header_name = 'x-lore-session-id'
          AND header_session_id = 'shared-by-two-clients'`,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(2);
    expect(new Set(rows.map((row) => row.credential_fingerprint)).size).toBe(2);
    expect(
      rows.every((row) => /^[0-9a-f]{16}$/.test(row.credential_fingerprint)),
    ).toBe(true);
  });
});
