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
import { describe, it, expect, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Harness } from "./helpers/harness";
import { createHarness, TEST_GATEWAY_AUTH_TOKEN } from "./helpers/harness";
import { makeReplayInterceptor } from "./helpers/replay";
import { fingerprintMessages } from "../src/session";
import { deterministicID } from "../src/temporal-adapter";
import {
  makeFixtureEntry,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";
import {
  getActiveSessions,
  pendingPipelineSessionClaimCountForTest,
  setProvisionalFinalizerPauseForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { authFingerprint, getLastSeenAuth, resolveAuth } from "../src/auth";
import { enableHostedMode, _resetHostedModeForTest } from "@loreai/core";

const U0 = "alpha first task: please implement the parser module";
const U1 = "second follow-up: now add tests for the parser";
const U2 = "third instruction after the restart: refactor the helper";
const U3 = "fourth instruction after another restart: verify migration";

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

type Row = {
  session_id: string;
  header_session_id: string | null;
  message_count: number;
  project_path: string | null;
};

function loreSessionRows(h: Harness): Row[] {
  return h.queryDB<Row>(
    "SELECT session_id, header_session_id, message_count, project_path FROM session_state WHERE header_name = 'x-lore-session-id'",
  );
}

async function makeSessionLegacy(
  h: Harness,
  sessionId: string,
  firstUserContent = U0,
): Promise<void> {
  const fingerprint = await fingerprintMessages([
    { role: "user", content: firstUserContent },
  ]);
  const db = new DatabaseSync(h.dbPath);
  try {
    db.prepare(
      `UPDATE session_state
          SET fingerprint = ?, credential_fingerprint = ''
        WHERE session_id = ?`,
    ).run(fingerprint, sessionId);
  } finally {
    db.close();
  }
}

describe("issue #796: restart-proof session adoption (Tier 3b)", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
    _resetHostedModeForTest();
  });

  it("adopts the prior session when a resumed conversation arrives under a new x-lore-session-id after restart", async () => {
    harness = await createHarness({ fixtures: fixtures() });

    // Turn 1 (new session under V1) — persists fingerprint + stores u0.
    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

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
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

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
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Adopted: still ONE conversation session (no new row), same internal id,
    // now rebound to the new header value for the Tier-1 fast path.
    rows = loreSessionRows(harness);
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe(s1);
    expect(rows[0].header_session_id).toBe("V2");
  });

  it("does not adopt a fingerprint candidate whose persisted credential owner differs", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let response = await harness.chat(
      body([{ role: "user", content: U0 }]),
      "key-A",
      { "x-lore-session-id": "owner-V1" },
    );
    await response.text();
    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "owner-V1" },
    );
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const original = loreSessionRows(harness)[0];
    const database = new DatabaseSync(harness.dbPath);
    try {
      database
        .prepare(
          "UPDATE session_state SET credential_fingerprint = ? WHERE session_id = ?",
        )
        .run("different-owner", original.session_id);
    } finally {
      database.close();
    }
    await harness.restartPipeline();

    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      { "x-lore-session-id": "owner-V2" },
    );
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = loreSessionRows(harness);
    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => row.header_session_id === "owner-V1")?.session_id,
    ).toBe(original.session_id);
    expect(
      rows.find((row) => row.header_session_id === "owner-V2")?.session_id,
    ).not.toBe(original.session_id);
  });

  it("fails closed for duplicate persisted header identities", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    const credentialFingerprint = authFingerprint({
      scheme: "api-key",
      value: "duplicate-key",
    });
    const database = new DatabaseSync(harness.dbPath);
    try {
      const insert = database.prepare(
        `INSERT INTO session_state
           (session_id, force_min_layer, updated_at, header_name,
            header_session_id, credential_fingerprint, project_path,
            project_path_provisional)
         VALUES (?, 0, ?, 'x-lore-session-id', 'duplicate-header', ?, ?, 0)`,
      );
      insert.run(
        `duplicate-a-${crypto.randomUUID()}`,
        Date.now(),
        credentialFingerprint,
        "/tmp/duplicate-project-a",
      );
      insert.run(
        `duplicate-b-${crypto.randomUUID()}`,
        Date.now(),
        credentialFingerprint,
        "/tmp/duplicate-project-b",
      );
    } finally {
      database.close();
    }
    await harness.restartPipeline();

    const response = await harness.chat(
      body([{ role: "user", content: U0 }]),
      "duplicate-key",
      { "x-lore-session-id": "duplicate-header" },
    );
    expect(response.status).not.toBe(200);
    await response.text();
    expect(harness.upstreamBodies()).toHaveLength(0);
    expect(
      harness.queryDB(
        "SELECT session_id FROM session_state WHERE header_session_id = 'duplicate-header'",
      ),
    ).toHaveLength(2);
  });

  it("does not persist fingerprint adoption after a failed resumed turn", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
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
    await r.text();
    const original = loreSessionRows(harness)[0];
    await makeSessionLegacy(harness, original.session_id);
    await harness.restartPipeline();
    const globalAuthBefore = getLastSeenAuth("anthropic")?.value;

    setUpstreamInterceptor(async () =>
      Promise.resolve(
        new Response("provider failed", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );
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
    expect(r.status).toBe(500);
    await r.text();

    const rows = loreSessionRows(harness);
    expect(rows).toEqual([original]);
    // A failed provisional turn must not repopulate worker credentials after
    // restart; only a successfully committed turn may publish them.
    expect(resolveAuth(original.session_id)).toBeNull();
    // Local direct-provider requests refresh the legacy process-global fallback
    // at ingress even when their provisional session commit later fails.
    expect(globalAuthBefore).toBeUndefined();
    expect(getLastSeenAuth("anthropic")?.value).toBe("key-A");

    const retryReplay = makeReplayInterceptor([
      makeFixtureEntry({
        seq: 0,
        requestMessages: [],
        responseText: "Retry succeeded.",
      }),
    ]);
    setUpstreamInterceptor(retryReplay);
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
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    await harness.restartPipeline();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
        { role: "assistant", content: "Retry succeeded." },
        { role: "user", content: U3 },
      ]),
      "key-A",
      { "x-lore-session-id": "V3" },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const afterSecondRestart = loreSessionRows(harness);
    expect(afterSecondRestart).toHaveLength(1);
    expect(afterSecondRestart[0].session_id).toBe(original.session_id);
    expect(afterSecondRestart[0].header_session_id).toBe("V3");
  });

  it("rechecks legacy ownership inside the provisional commit savepoint", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let response = await harness.chat(
      body([{ role: "user", content: U0 }]),
      "key-A",
      { "x-lore-session-id": "savepoint-owner-old" },
    );
    await response.text();
    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "savepoint-owner-old" },
    );
    await response.text();
    const [original] = loreSessionRows(harness);
    await makeSessionLegacy(harness, original.session_id);
    const [legacy] = harness.queryDB<{ fingerprint: string }>(
      "SELECT fingerprint FROM session_state WHERE session_id = ?",
      [original.session_id],
    );
    await harness.restartPipeline();

    let releaseFinalizer!: () => void;
    const finalizerPause = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    let finalizerWaitingResolve!: () => void;
    const finalizerWaiting = new Promise<void>((resolve) => {
      finalizerWaitingResolve = resolve;
    });
    setProvisionalFinalizerPauseForTest(
      finalizerPause,
      finalizerWaitingResolve,
    );

    try {
      response = await harness.chat(
        body([
          { role: "user", content: U0 },
          { role: "assistant", content: "A0 done." },
          { role: "user", content: U1 },
          { role: "assistant", content: "A1 done." },
          { role: "user", content: U2 },
        ]),
        "key-A",
        { "x-lore-session-id": "savepoint-owner-new" },
      );
      expect(response.status).toBe(200);
      await response.text();
      await finalizerWaiting;

      const database = new DatabaseSync(harness.dbPath);
      try {
        database
          .prepare(
            "UPDATE session_state SET credential_fingerprint = ? WHERE session_id = ?",
          )
          .run("external-owner", original.session_id);
      } finally {
        database.close();
      }
      releaseFinalizer();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const [after] = harness.queryDB<{
        header_session_id: string;
        credential_fingerprint: string;
        fingerprint: string;
      }>(
        `SELECT header_session_id, credential_fingerprint, fingerprint
           FROM session_state
          WHERE session_id = ?`,
        [original.session_id],
      );
      expect(after.header_session_id).toBe("savepoint-owner-old");
      expect(after.credential_fingerprint).toBe("external-owner");
      expect(after.fingerprint).toBe(legacy.fingerprint);
      expect(
        harness.queryDB(
          "SELECT id FROM temporal_messages WHERE session_id = ? AND content LIKE ?",
          [original.session_id, `%${U2}%`],
        ),
      ).toHaveLength(0);
    } finally {
      releaseFinalizer();
      setProvisionalFinalizerPauseForTest(undefined);
    }
  });

  it("persists the resumed turn when fingerprint adoption has no session header", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
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
    await r.text();
    const original = loreSessionRows(harness)[0];
    await harness.restartPipeline();

    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      {},
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = loreSessionRows(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: original.session_id,
      header_session_id: "V1",
      message_count: 5,
    });
    expect(
      harness.queryDB<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND content LIKE ?",
        [original.session_id, `%${U2}%`],
      )[0]?.count,
    ).toBeGreaterThan(0);
  });

  it("adopts a resumed conversation from a new clone path matched by git remote", async () => {
    enableHostedMode();
    const originalPath = "/client/checkouts/adoption-original";
    const clonePath = "/client/checkouts/adoption-clone";
    const remote = `github.com/test/adoption-${crypto.randomUUID()}`;
    harness = await createHarness({
      fixtures: fixtures(),
      configOverrides: {
        hostedMode: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "clone-V1",
      "x-lore-project": originalPath,
      "x-lore-git-remote": remote,
      "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
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
      {
        "x-lore-session-id": "clone-V1",
        "x-lore-project": originalPath,
        "x-lore-git-remote": remote,
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(r.status).toBe(200);
    await r.text();
    const original = loreSessionRows(harness)[0];
    await harness.restartPipeline();

    // This path has never been registered as an alias. The persisted project's
    // normalized remote is the only signal that scopes overlap to the original
    // project rather than minting a second session for the clone.
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
        "x-lore-session-id": "clone-V2",
        "x-lore-project": clonePath,
        "x-lore-git-remote": remote,
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = loreSessionRows(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: original.session_id,
      header_session_id: "clone-V2",
      project_path: clonePath,
    });
  });

  it("does not trust a spoofed clone remote on a local gateway", async () => {
    const originalPath = "/tmp/adoption-local-original";
    const unrelatedPath = "/tmp/adoption-local-unrelated";
    const spoofedRemote = `github.com/test/adoption-spoof-${crypto.randomUUID()}`;
    harness = await createHarness({ fixtures: fixtures() });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "spoof-V1",
      "x-lore-project": originalPath,
    });
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      {
        "x-lore-session-id": "spoof-V1",
        "x-lore-project": originalPath,
      },
    );
    await r.text();
    const original = loreSessionRows(harness)[0];
    const database = new DatabaseSync(harness.dbPath);
    try {
      database
        .prepare("UPDATE projects SET git_remote = ? WHERE path = ?")
        .run(spoofedRemote, originalPath);
    } finally {
      database.close();
    }
    await harness.restartPipeline();

    // unrelatedPath is not a git repository on this local gateway. A forged
    // header must not select originalPath's project and authorize adoption.
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
        "x-lore-session-id": "spoof-V2",
        "x-lore-project": unrelatedPath,
        "x-lore-git-remote": spoofedRemote,
      },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = loreSessionRows(harness);
    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => row.session_id === original.session_id),
    ).toMatchObject({
      header_session_id: "spoof-V1",
      project_path: originalPath,
    });
    expect(
      rows.find((row) => row.header_session_id === "spoof-V2"),
    ).toMatchObject({
      project_path: unrelatedPath,
    });
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

  it("adopts a pre-credential session only after same-project transcript overlap", async () => {
    harness = await createHarness({
      fixtures: [
        ...fixtures(),
        makeFixtureEntry({
          seq: 3,
          requestMessages: [],
          responseText: "A3 done.",
        }),
      ],
    });
    const legacyHeader = "legacy-exact-header";

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": legacyHeader,
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
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();

    const before = loreSessionRows(harness);
    expect(before).toHaveLength(1);
    await makeSessionLegacy(harness, before[0].session_id);
    await harness.restartPipeline();

    const migratedHeader = "legacy-after-credential-scope";
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      { "x-lore-session-id": migratedHeader },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const after = harness.queryDB<Row & { credential_fingerprint: string }>(
      `SELECT session_id, header_session_id, credential_fingerprint
         FROM session_state
        WHERE header_name = 'x-lore-session-id'`,
    );
    expect(after).toHaveLength(1);
    expect(after[0].session_id).toBe(before[0].session_id);
    expect(after[0].header_session_id).toBe(migratedHeader);
    expect(after[0].credential_fingerprint).toMatch(/^[0-9a-f]{16}$/);

    const staleAlias = await harness.chat(
      body([{ role: "user", content: "/lore:amnesia:on" }]),
      "",
      { "x-lore-session-id": legacyHeader },
    );
    expect(staleAlias.status).toBe(200);
    expect(await staleAlias.text()).toMatch(/no active session/i);
    expect(
      harness.queryDB<{ amnesia: number }>(
        "SELECT amnesia FROM session_state WHERE session_id = ?",
        [before[0].session_id],
      )[0]?.amnesia,
    ).toBe(0);

    await harness.restartPipeline();
    const secondMigratedHeader = "legacy-after-second-restart";
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
        { role: "assistant", content: "A2 done." },
        { role: "user", content: U3 },
      ]),
      "key-A",
      { "x-lore-session-id": secondMigratedHeader },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const afterSecondRestart = loreSessionRows(harness);
    expect(afterSecondRestart).toHaveLength(1);
    expect(afterSecondRestart[0].session_id).toBe(before[0].session_id);
    expect(afterSecondRestart[0].header_session_id).toBe(secondMigratedHeader);
  });

  it("does not adopt an ownerless legacy session without a presented credential", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let response = await harness.chat(
      body([{ role: "user", content: U0 }]),
      "key-A",
      { "x-lore-session-id": "legacy-auth-required-old" },
    );
    await response.text();
    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "legacy-auth-required-old" },
    );
    await response.text();
    const [original] = loreSessionRows(harness);
    await makeSessionLegacy(harness, original.session_id);
    await harness.restartPipeline();

    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "",
      { "x-lore-session-id": "legacy-auth-required-new" },
    );
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = loreSessionRows(harness);
    expect(
      rows.find((row) => row.header_session_id === "legacy-auth-required-old")
        ?.session_id,
    ).toBe(original.session_id);
    const independent = rows.find(
      (row) => row.header_session_id === "legacy-auth-required-new",
    );
    expect(independent).toBeDefined();
    expect(independent?.session_id).not.toBe(original.session_id);
  });

  it("does not fingerprint-match credentialless headerless sessions", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let response = await harness.chat(
      body([{ role: "user", content: U0 }]),
      "",
      { "x-lore-project": "/tmp/credentialless-project-a" },
    );
    expect(response.status).toBe(200);
    await response.text();
    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "",
      { "x-lore-project": "/tmp/credentialless-project-b" },
    );
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = harness.queryDB<{ session_id: string; project_path: string }>(
      `SELECT session_id, project_path
         FROM session_state
        WHERE project_path IN (?, ?)`,
      ["/tmp/credentialless-project-a", "/tmp/credentialless-project-b"],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(2);
  });

  it("requires the live fingerprint candidate to have the same credential owner", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let response = await harness.chat(
      body([{ role: "user", content: U0 }]),
      "key-A",
      { "x-lore-project": "/tmp/live-owner-project" },
    );
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const [state] = getActiveSessions().values();
    state.fingerprint = await fingerprintMessages(
      [{ role: "user", content: U0 }],
      {
        authSuffix: authFingerprint({
          scheme: "api-key",
          value: "key-B",
        }),
      },
    );

    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-B",
      { "x-lore-project": "/tmp/live-owner-project" },
    );
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = harness.queryDB<{ session_id: string }>(
      "SELECT session_id FROM session_state WHERE project_path = ?",
      ["/tmp/live-owner-project"],
    );
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(2);
  });

  it("does not live-match an authenticated fingerprint across confident projects", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let response = await harness.chat(
      body([{ role: "user", content: U0 }]),
      "key-A",
      { "x-lore-project": "/tmp/live-project-a" },
    );
    await response.text();
    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-project": "/tmp/live-project-b" },
    );
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = harness.queryDB<{ session_id: string; project_path: string }>(
      `SELECT session_id, project_path
         FROM session_state
        WHERE project_path IN (?, ?)`,
      ["/tmp/live-project-a", "/tmp/live-project-b"],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(2);
  });

  it("fails closed for equally close live fingerprint candidates", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let response = await harness.chat(
      body([{ role: "user", content: U0 }]),
      "key-A",
      { "x-lore-project": "/tmp/live-ambiguous-project" },
    );
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const active = getActiveSessions();
    const [state] = active.values();
    const duplicateSessionID = `live-duplicate-${crypto.randomUUID()}`;
    (active as Map<string, typeof state>).set(duplicateSessionID, {
      ...state,
      sessionID: duplicateSessionID,
    });

    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-project": "/tmp/live-ambiguous-project" },
    );
    await response.text();
    expect(getActiveSessions().size).toBe(3);
  });

  it("allows only the first concurrent credential to claim a legacy session", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let response = await harness.chat(
      body([{ role: "user", content: U0 }]),
      "seed-key",
      { "x-lore-session-id": "legacy-race-seed" },
    );
    await response.text();
    response = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "seed-key",
      { "x-lore-session-id": "legacy-race-seed" },
    );
    await response.text();
    const [original] = loreSessionRows(harness);
    await makeSessionLegacy(harness, original.session_id);
    await harness.restartPipeline();

    let releaseFirst!: () => void;
    const firstPause = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWaitingResolve!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      firstWaitingResolve = resolve;
    });
    const replay = makeReplayInterceptor([
      makeFixtureEntry({
        seq: 0,
        requestMessages: [],
        responseText: "First claimant succeeded.",
      }),
    ]);
    let upstreamCalls = 0;
    setUpstreamInterceptor(async (...args) => {
      upstreamCalls++;
      firstWaitingResolve();
      await firstPause;
      return replay(...args);
    });

    const resumed = body([
      { role: "user", content: U0 },
      { role: "assistant", content: "A0 done." },
      { role: "user", content: U1 },
      { role: "assistant", content: "A1 done." },
      { role: "user", content: U2 },
    ]);
    try {
      const first = harness.chat(resumed, "key-A", {
        "x-lore-session-id": "legacy-race-a",
      });
      await firstWaiting;
      const second = harness.chat(resumed, "key-B", {
        "x-lore-session-id": "legacy-race-b",
      });
      await vi.waitFor(() =>
        expect(pendingPipelineSessionClaimCountForTest()).toBe(1),
      );

      releaseFirst();
      response = await first;
      expect(response.status).toBe(200);
      await response.text();
      const rejected = await second;
      expect(rejected.status).toBe(404);
      expect(await rejected.text()).toMatch(/authenticated session/i);
      expect(upstreamCalls).toBe(1);

      const rows = loreSessionRows(harness);
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe(original.session_id);
      expect(rows[0].header_session_id).toBe("legacy-race-a");
    } finally {
      releaseFirst();
    }
  });

  it("does NOT let another transcript claim an exact legacy header", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    const legacyHeader = "legacy-copied-header";

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": legacyHeader,
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
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();
    const before = loreSessionRows(harness);
    await makeSessionLegacy(harness, before[0].session_id);
    await harness.restartPipeline();

    r = await harness.chat(
      body([
        { role: "user", content: "attacker opening" },
        { role: "assistant", content: "unrelated" },
        { role: "user", content: "attacker follow-up" },
      ]),
      "key-B",
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();

    const after = loreSessionRows(harness);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((row) => row.session_id)).size).toBe(2);
  });

  it("does NOT adopt a pre-credential session when only its fingerprint-implied first message overlaps", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    const legacyHeader = "legacy-one-message";

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": legacyHeader,
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
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();
    const before = loreSessionRows(harness);
    await makeSessionLegacy(harness, before[0].session_id);
    await harness.restartPipeline();

    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "unrelated response" },
        { role: "user", content: "different second user message" },
      ]),
      "key-B",
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();

    const after = loreSessionRows(harness);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((row) => row.session_id)).size).toBe(2);
  });

  it("does NOT adopt either of two equally supported legacy candidates", async () => {
    const users = [U0, U1, U2, "fourth instruction for ambiguity proof"];
    harness = await createHarness({
      fixtures: Array.from({ length: 5 }, (_, seq) =>
        makeFixtureEntry({
          seq,
          requestMessages: [],
          responseText: `A${seq} done.`,
        }),
      ),
    });

    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < users.length; i++) {
      messages.push({ role: "user", content: users[i] });
      if (i < users.length - 1) {
        messages.push({ role: "assistant", content: `A${i} done.` });
      }
      const r = await harness.chat(body(messages), "key-A", {
        "x-lore-session-id": "legacy-ambiguous-a",
      });
      expect(r.status).toBe(200);
      await r.text();
    }

    const [first] = loreSessionRows(harness);
    expect(first).toBeDefined();
    await makeSessionLegacy(harness, first.session_id);
    const secondSession = `legacy-ambiguous-${crypto.randomUUID()}`;
    const fingerprint = await fingerprintMessages([
      { role: "user", content: U0 },
    ]);
    const db = new DatabaseSync(harness.dbPath);
    try {
      const state = db
        .prepare(
          `SELECT message_count, project_path, project_path_provisional, is_subagent
             FROM session_state
            WHERE session_id = ?`,
        )
        .get(first.session_id) as {
        message_count: number;
        project_path: string;
        project_path_provisional: number;
        is_subagent: number;
      };
      db.prepare(
        `INSERT INTO session_state
           (session_id, force_min_layer, updated_at, message_count, fingerprint,
            credential_fingerprint, project_path, project_path_provisional, is_subagent)
         VALUES (?, 0, ?, ?, ?, '', ?, ?, ?)`,
      ).run(
        secondSession,
        Date.now(),
        state.message_count,
        fingerprint,
        state.project_path,
        state.project_path_provisional,
        state.is_subagent,
      );
      for (const index of [2, 6]) {
        const sourceId = deterministicID(first.session_id, "user", index, [
          { type: "text", text: users[index / 2] },
        ]);
        const nextSourceId = deterministicID(secondSession, "user", index, [
          { type: "text", text: users[index / 2] },
        ]);
        db.prepare(
          "UPDATE temporal_messages SET session_id = ?, source_id = ? WHERE source_id = ?",
        ).run(secondSession, nextSourceId, sourceId);
      }
    } finally {
      db.close();
    }
    await harness.restartPipeline();

    const resumed: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < users.length; i++) {
      resumed.push({ role: "user", content: users[i] });
      if (i < users.length - 1) {
        resumed.push({ role: "assistant", content: `A${i} done.` });
      }
    }
    const r = await harness.chat(body(resumed), "key-B", {
      "x-lore-session-id": "legacy-ambiguous-new",
    });
    expect(r.status).toBe(200);
    await r.text();

    const rows = harness.queryDB<{
      session_id: string;
      header_session_id: string | null;
    }>(
      `SELECT session_id, header_session_id
         FROM session_state
        WHERE session_id IN (?, ?)
           OR header_session_id = 'legacy-ambiguous-new'`,
      [first.session_id, secondSession],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.session_id)).toContain(first.session_id);
    expect(rows.map((row) => row.session_id)).toContain(secondSession);
    expect(rows.map((row) => row.header_session_id)).toContain(
      "legacy-ambiguous-new",
    );
  });

  it("does NOT adopt a pre-credential session across projects", async () => {
    harness = await createHarness({
      fixtures: fixtures(),
      projectPath: "/tmp/lore-legacy-project-a",
    });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "legacy-project-a",
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
      { "x-lore-session-id": "legacy-project-a" },
    );
    expect(r.status).toBe(200);
    await r.text();
    const before = loreSessionRows(harness);
    await makeSessionLegacy(harness, before[0].session_id);
    await harness.restartPipeline();

    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-B",
      {
        "x-lore-session-id": "legacy-project-a",
        "x-lore-project": "/tmp/lore-legacy-project-b",
      },
    );
    expect(r.status).toBe(200);
    await r.text();

    const after = loreSessionRows(harness);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((row) => row.session_id)).size).toBe(2);
  });
});
