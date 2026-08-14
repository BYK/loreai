/**
 * End-to-end regression coverage for authenticated session identity on a
 * remote gateway. Client-provided session/project headers are not tenant IDs:
 * two credentials may send identical values and must still receive isolated
 * Lore sessions, prompts, persistence, and background-worker credentials.
 */
import { afterEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolveAuth } from "../src/auth";
import type { Harness } from "./helpers/harness";
import { createHarness, TEST_GATEWAY_AUTH_TOKEN } from "./helpers/harness";
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  makeFixtureEntry,
  STANDARD_TOOLS,
} from "./helpers/fixtures";

const SHARED_SESSION = "shared-client-session-1234";
const SHARED_PROJECT = "/remote/shared-project";
const PRIVATE_A = "tenant A private prompt: rotate the alpha signing key";
const PRIVATE_B = "tenant B private prompt: investigate the beta payroll job";
const FOLLOW_UP_A = "tenant A follow-up: add the alpha regression test";

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

function fixtures(count = 3) {
  return Array.from({ length: count }, (_, seq) =>
    makeFixtureEntry({
      seq,
      requestMessages: [],
      responseText:
        seq === 0
          ? "tenant A response"
          : seq === 1
            ? "tenant B response"
            : `response-${seq}`,
    }),
  );
}

type AuthCase = {
  name: string;
  scheme: "api-key" | "bearer";
  credentialA: string;
  credentialB: string;
};

const AUTH_CASES: AuthCase[] = [
  {
    name: "API keys",
    scheme: "api-key",
    credentialA: "remote-api-key-tenant-A",
    credentialB: "remote-api-key-tenant-B",
  },
  {
    name: "bearer credentials",
    scheme: "bearer",
    credentialA: "remote-bearer-tenant-A",
    credentialB: "remote-bearer-tenant-B",
  },
];

async function chatAs(
  harness: Harness,
  requestBody: unknown,
  authCase: AuthCase,
  credential: string,
  clientSessionId = SHARED_SESSION,
): Promise<Response> {
  const authHeaders: Record<string, string> =
    authCase.scheme === "api-key"
      ? {}
      : { authorization: `Bearer ${credential}` };
  return harness.chat(
    requestBody,
    authCase.scheme === "api-key" ? credential : null,
    {
      "x-lore-session-id": clientSessionId,
      "x-lore-project": SHARED_PROJECT,
      "x-lore-tenant": "attacker-controlled-storage-owner",
      "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      ...authHeaders,
    },
  );
}

describe("remote authenticated tenant session binding", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = undefined;
  });

  test.each(AUTH_CASES)(
    "isolates identical client headers by $name across a restart",
    async (authCase) => {
      harness = await createHarness({
        fixtures: fixtures(),
        configOverrides: {
          remoteGateway: true,
          gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
        },
      });

      let response = await chatAs(
        harness,
        body([{ role: "user", content: PRIVATE_A }]),
        authCase,
        authCase.credentialA,
      );
      expect(response.status).toBe(200);
      await response.text();

      response = await chatAs(
        harness,
        body([{ role: "user", content: PRIVATE_B }]),
        authCase,
        authCase.credentialB,
      );
      expect(response.status).toBe(200);
      await response.text();

      const beforeRestart = harness.queryDB<{
        session_id: string;
        header_session_id: string;
        credential_fingerprint: string;
      }>(
        `SELECT session_id, header_session_id, credential_fingerprint
           FROM session_state
          WHERE header_name = 'x-lore-session-id'
          ORDER BY session_id`,
      );
      expect(beforeRestart).toHaveLength(2);
      expect(new Set(beforeRestart.map((row) => row.session_id)).size).toBe(2);
      expect(
        new Set(beforeRestart.map((row) => row.credential_fingerprint)).size,
      ).toBe(2);
      for (const row of beforeRestart) {
        expect(row.header_session_id).toBe(SHARED_SESSION);
        expect(row.credential_fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(row.credential_fingerprint).not.toContain(authCase.credentialA);
        expect(row.credential_fingerprint).not.toContain(authCase.credentialB);
      }

      const tenantProjects = harness.queryDB<{
        id: string;
        tenant_id: string;
      }>(
        "SELECT id, tenant_id FROM projects WHERE path = ? ORDER BY tenant_id",
        [SHARED_PROJECT],
      );
      expect(tenantProjects).toHaveLength(2);
      expect(new Set(tenantProjects.map((row) => row.id)).size).toBe(2);
      expect(new Set(tenantProjects.map((row) => row.tenant_id))).toEqual(
        new Set(beforeRestart.map((row) => row.credential_fingerprint)),
      );

      const promptsBeforeRestart = harness.queryDB<{
        session_id: string;
        content: string;
        project_id: string;
        tenant_id: string;
      }>(
        `SELECT t.session_id, t.content, t.project_id, p.tenant_id
           FROM temporal_messages t JOIN projects p ON p.id = t.project_id
          WHERE t.content LIKE '%private prompt%'`,
      );
      const promptA = promptsBeforeRestart.find((row) =>
        row.content.includes(PRIVATE_A),
      );
      const promptB = promptsBeforeRestart.find((row) =>
        row.content.includes(PRIVATE_B),
      );
      const sidA = promptA?.session_id;
      const sidB = promptB?.session_id;
      expect(sidA).toBeTruthy();
      expect(sidB).toBeTruthy();
      expect(sidA).not.toBe(sidB);
      expect(promptA?.project_id).not.toBe(promptB?.project_id);
      expect(promptA?.tenant_id).not.toBe(promptB?.tenant_id);

      expect(resolveAuth(sidA, "anthropic")).toEqual({
        scheme: authCase.scheme,
        value: authCase.credentialA,
      });
      expect(resolveAuth(sidB, "anthropic")).toEqual({
        scheme: authCase.scheme,
        value: authCase.credentialB,
      });

      await harness.restartPipeline();

      response = await chatAs(
        harness,
        body([
          { role: "user", content: PRIVATE_A },
          { role: "assistant", content: "tenant A response" },
          { role: "user", content: FOLLOW_UP_A },
        ]),
        authCase,
        authCase.credentialA,
      );
      expect(response.status).toBe(200);
      await response.text();

      const afterRestart = harness.queryDB<{ session_id: string }>(
        `SELECT session_id
           FROM session_state
          WHERE header_name = 'x-lore-session-id'
          ORDER BY session_id`,
      );
      expect(afterRestart).toHaveLength(2);
      expect(afterRestart.map((row) => row.session_id)).toContain(sidA);
      expect(afterRestart.map((row) => row.session_id)).toContain(sidB);
      expect(
        harness.queryDB("SELECT id FROM projects WHERE path = ?", [
          SHARED_PROJECT,
        ]),
      ).toHaveLength(2);

      const allPrivatePrompts = harness.queryDB<{
        session_id: string;
        content: string;
      }>("SELECT session_id, content FROM temporal_messages");
      const aContent = allPrivatePrompts
        .filter((row) => row.session_id === sidA)
        .map((row) => row.content)
        .join("\n");
      const bContent = allPrivatePrompts
        .filter((row) => row.session_id === sidB)
        .map((row) => row.content)
        .join("\n");
      expect(aContent).toContain(PRIVATE_A);
      expect(aContent).toContain(FOLLOW_UP_A);
      expect(aContent).not.toContain(PRIVATE_B);
      expect(bContent).toContain(PRIVATE_B);
      expect(bContent).not.toContain(PRIVATE_A);

      // The restart clears every worker key, then the resumed turn repopulates
      // only tenant A's credential.
      expect(resolveAuth(sidA, "anthropic")).toEqual({
        scheme: authCase.scheme,
        value: authCase.credentialA,
      });
      expect(resolveAuth(sidB, "anthropic")).toBeNull();
    },
  );

  test("preserves provider-specific credentials inside one remote tenant session", async () => {
    harness = await createHarness({
      fixtures: fixtures(2),
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });

    let response = await harness.chat(
      body([{ role: "user", content: PRIVATE_A }]),
      AUTH_CASES[0].credentialA,
      {
        "x-lore-session-id": SHARED_SESSION,
        "x-lore-project": SHARED_PROJECT,
        "x-lore-provider": "anthropic",
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(response.status).toBe(200);
    await response.text();

    response = await harness.chat(
      body([
        { role: "user", content: PRIVATE_A },
        { role: "assistant", content: "tenant A response" },
        { role: "user", content: FOLLOW_UP_A },
      ]),
      AUTH_CASES[0].credentialA,
      {
        "x-lore-session-id": SHARED_SESSION,
        "x-lore-project": SHARED_PROJECT,
        "x-lore-provider": "openai",
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(response.status).toBe(200);
    await response.text();

    const rows = harness.queryDB<{ session_id: string }>(
      "SELECT session_id FROM session_state WHERE header_name = 'x-lore-session-id'",
    );
    expect(rows).toHaveLength(1);
    expect(resolveAuth(rows[0].session_id, "anthropic")).toEqual({
      scheme: "api-key",
      value: AUTH_CASES[0].credentialA,
    });
    expect(resolveAuth(rows[0].session_id, "openai")).toEqual({
      scheme: "api-key",
      value: AUTH_CASES[0].credentialA,
    });
  });

  test("retains tenant ownership through streamed completion callbacks", async () => {
    harness = await createHarness({
      fixtures: fixtures(2),
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });
    const authCase = AUTH_CASES[0];

    for (const [credential, content] of [
      [authCase.credentialA, PRIVATE_A],
      [authCase.credentialB, PRIVATE_B],
    ]) {
      const response = await chatAs(
        harness,
        { ...body([{ role: "user", content }]), stream: true },
        authCase,
        credential,
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    const rows = harness.queryDB<{
      content: string;
      project_id: string;
      tenant_id: string;
    }>(
      `SELECT t.content, t.project_id, p.tenant_id
         FROM temporal_messages t JOIN projects p ON p.id = t.project_id
        WHERE t.content LIKE '%private prompt%'`,
    );
    const rowA = rows.find((row) => row.content.includes(PRIVATE_A));
    const rowB = rows.find((row) => row.content.includes(PRIVATE_B));
    expect(rowA?.project_id).toBeTruthy();
    expect(rowB?.project_id).toBeTruthy();
    expect(rowA?.project_id).not.toBe(rowB?.project_id);
    expect(rowA?.tenant_id).not.toBe(rowB?.tenant_id);
  });

  test("fails closed instead of adopting an unbound historical mapping", async () => {
    harness = await createHarness({
      fixtures: fixtures(1),
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });
    const historicalSid = "historical-unbound-remote-session";
    const database = new DatabaseSync(harness.dbPath);
    try {
      database
        .prepare(
          `INSERT INTO session_state
             (session_id, force_min_layer, updated_at, header_name, header_session_id)
           VALUES (?, 0, ?, 'x-lore-session-id', ?)`,
        )
        .run(historicalSid, Date.now(), SHARED_SESSION);
    } finally {
      database.close();
    }

    await harness.restartPipeline();
    const response = await chatAs(
      harness,
      body([{ role: "user", content: PRIVATE_A }]),
      AUTH_CASES[0],
      AUTH_CASES[0].credentialA,
    );
    expect(response.status).toBe(200);
    await response.text();

    const rows = harness.queryDB<{
      session_id: string;
      credential_fingerprint: string;
    }>(
      `SELECT session_id, credential_fingerprint
         FROM session_state
        WHERE header_name = 'x-lore-session-id'
        ORDER BY session_id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      session_id: historicalSid,
      credential_fingerprint: "",
    });
    const fresh = rows.find((row) => row.session_id !== historicalSid);
    expect(fresh?.credential_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(resolveAuth(historicalSid, "anthropic")).toBeNull();
  });

  test("adopts a resumed conversation only within the same remote credential", async () => {
    harness = await createHarness({
      fixtures: fixtures(),
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });
    const authCase = AUTH_CASES[0];

    let response = await chatAs(
      harness,
      body([{ role: "user", content: PRIVATE_A }]),
      authCase,
      authCase.credentialA,
      "remote-session-before-restart",
    );
    expect(response.status).toBe(200);
    await response.text();
    response = await chatAs(
      harness,
      body([
        { role: "user", content: PRIVATE_A },
        { role: "assistant", content: "tenant A response" },
        { role: "user", content: FOLLOW_UP_A },
      ]),
      authCase,
      authCase.credentialA,
      "remote-session-before-restart",
    );
    expect(response.status).toBe(200);
    await response.text();

    const original = harness.queryDB<{ session_id: string }>(
      "SELECT session_id FROM session_state WHERE header_name = 'x-lore-session-id'",
    );
    expect(original).toHaveLength(1);
    await harness.restartPipeline();

    response = await chatAs(
      harness,
      body([
        { role: "user", content: PRIVATE_A },
        { role: "assistant", content: "tenant A response" },
        { role: "user", content: FOLLOW_UP_A },
        { role: "assistant", content: "tenant A follow-up response" },
        { role: "user", content: "tenant A third turn after restart" },
      ]),
      authCase,
      authCase.credentialA,
      "remote-session-after-restart",
    );
    expect(response.status).toBe(200);
    await response.text();

    const resumed = harness.queryDB<{
      session_id: string;
      header_session_id: string;
      credential_fingerprint: string;
    }>(
      `SELECT session_id, header_session_id, credential_fingerprint
         FROM session_state
        WHERE header_name = 'x-lore-session-id'`,
    );
    expect(resumed).toHaveLength(1);
    expect(resumed[0].session_id).toBe(original[0].session_id);
    expect(resumed[0].header_session_id).toBe("remote-session-after-restart");
    expect(resumed[0].credential_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("never adopts another credential's persisted conversation after restart", async () => {
    harness = await createHarness({
      fixtures: fixtures(),
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });
    const authCase = AUTH_CASES[0];

    let response = await chatAs(
      harness,
      body([{ role: "user", content: PRIVATE_A }]),
      authCase,
      authCase.credentialA,
      "tenant-a-before-restart",
    );
    expect(response.status).toBe(200);
    await response.text();
    response = await chatAs(
      harness,
      body([
        { role: "user", content: PRIVATE_A },
        { role: "assistant", content: "tenant A response" },
        { role: "user", content: FOLLOW_UP_A },
      ]),
      authCase,
      authCase.credentialA,
      "tenant-a-before-restart",
    );
    expect(response.status).toBe(200);
    await response.text();

    await harness.restartPipeline();
    response = await chatAs(
      harness,
      body([
        { role: "user", content: PRIVATE_A },
        { role: "assistant", content: "tenant A response" },
        { role: "user", content: FOLLOW_UP_A },
        { role: "assistant", content: "tenant A follow-up response" },
        { role: "user", content: "resumed history sent by tenant B" },
      ]),
      authCase,
      authCase.credentialB,
      "tenant-b-after-restart",
    );
    expect(response.status).toBe(200);
    await response.text();

    const rows = harness.queryDB<{ session_id: string }>(
      "SELECT session_id FROM session_state WHERE header_name = 'x-lore-session-id'",
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(2);
  });

  test("does not correlate unauthenticated remote requests by client headers", async () => {
    harness = await createHarness({
      fixtures: fixtures(2),
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });
    const headers = {
      "x-lore-session-id": SHARED_SESSION,
      "x-lore-project": SHARED_PROJECT,
      "x-lore-tenant": "attacker-controlled-storage-owner",
      "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
    };

    let response = await harness.chat(
      body([{ role: "user", content: PRIVATE_A }]),
      null,
      headers,
    );
    expect(response.status).toBe(200);
    await response.text();
    response = await harness.chat(
      body([{ role: "user", content: PRIVATE_B }]),
      null,
      headers,
    );
    expect(response.status).toBe(200);
    await response.text();

    const rows = harness.queryDB<{
      session_id: string;
      header_session_id: string | null;
      credential_fingerprint: string;
    }>(
      "SELECT session_id, header_session_id, credential_fingerprint FROM session_state",
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(2);
    expect(rows.every((row) => row.header_session_id === null)).toBe(true);
    expect(rows.every((row) => row.credential_fingerprint === "")).toBe(true);
    const projects = harness.queryDB<{ tenant_id: string }>(
      "SELECT tenant_id FROM projects WHERE path = ?",
      [SHARED_PROJECT],
    );
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((row) => row.tenant_id)).size).toBe(2);
    expect(projects.every((row) => row.tenant_id.length > 0)).toBe(true);
    expect(
      projects.every(
        (row) => row.tenant_id !== "attacker-controlled-storage-owner",
      ),
    ).toBe(true);
  });
});
