import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { credentialTenantFingerprint } from "../src/auth";
import { setBeforeUpstreamCaptureForTest } from "../src/pipeline";
import type { SessionState } from "../src/translate/types";
import {
  createHarness,
  TEST_GATEWAY_AUTH_TOKEN,
  type Harness,
} from "./helpers/harness";
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  makeFixtureEntry,
  STANDARD_TOOLS,
} from "./helpers/fixtures";

const PROJECT_PATH = "/remote/compact-tenant-isolation";
const SESSION_HEADER = "compact-tenant-b-session";
const TENANT_A_KEY = "compact-tenant-a-key";
const TENANT_B_KEY = "compact-tenant-b-key";
const TENANT_A = credentialTenantFingerprint({
  scheme: "api-key",
  value: TENANT_A_KEY,
});
const TENANT_B = credentialTenantFingerprint({
  scheme: "api-key",
  value: TENANT_B_KEY,
});
const LOCAL_SECRET = "LOCAL_COMPACT_SECRET_malachite_71";
const TENANT_A_SECRET = "TENANT_A_COMPACT_SECRET_cinnabar_83";
const TENANT_B_SECRET = "TENANT_B_COMPACT_SECRET_sapphire_97";

type CompactEndpoint = "/v1/compact" | "/v1/responses/compact";

function conversationBody(content: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages: [{ role: "user", content }],
    tools: STANDARD_TOOLS,
  };
}

function compactBody(endpoint: CompactEndpoint): Record<string, unknown> {
  if (endpoint === "/v1/compact") {
    return { project_path: PROJECT_PATH };
  }
  return {
    model: "gpt-5.4",
    input: [{ type: "message", role: "user", content: "compact now" }],
  };
}

async function postJson(
  baseURL: string,
  endpoint: CompactEndpoint,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(endpoint, baseURL);
  const serialized = JSON.stringify(body);
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(serialized)),
          ...headers,
        },
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          responseHeaders.append(
            incoming.rawHeaders[i],
            incoming.rawHeaders[i + 1],
          );
        }
        resolve(
          new Response(
            Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>,
            {
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            },
          ),
        );
      },
    );
    request.once("error", reject);
    request.end(serialized);
  });
}

async function seedKnowledge(tenantId: string, secret: string): Promise<void> {
  const { ensureProject, ltm, withTenant } = await import("@loreai/core");
  withTenant(tenantId, () => {
    ensureProject(PROJECT_PATH);
    ltm.create({
      projectPath: PROJECT_PATH,
      scope: "project",
      category: "architecture",
      title: `Compact isolation ${secret}`,
      content: `${secret} belongs only to its storage tenant.`,
    });
  });
}

async function createTenantBSession(
  harness: Harness,
  capture?: (state: SessionState) => void,
): Promise<string> {
  if (capture) {
    setBeforeUpstreamCaptureForTest(async (_request, state) => capture(state));
  }
  try {
    const response = await harness.chat(
      conversationBody("tenant B conversation used to establish the session"),
      TENANT_B_KEY,
      {
        "x-lore-session-id": SESSION_HEADER,
        "x-lore-project": PROJECT_PATH,
        "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
      },
    );
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    setBeforeUpstreamCaptureForTest(undefined);
  }

  const sessions = harness.queryDB<{
    session_id: string;
    credential_fingerprint: string;
  }>(
    "SELECT session_id, credential_fingerprint FROM session_state WHERE credential_fingerprint = ?",
    [TENANT_B],
  );
  expect(sessions).toHaveLength(1);

  // Keep compaction deterministic and offline: the tenant-specific knowledge
  // rows below are enough to build a summary, so no urgent worker call is needed.
  const { db } = await import("@loreai/core");
  db()
    .query("UPDATE temporal_messages SET distilled = 1 WHERE session_id = ?")
    .run(sessions[0].session_id);
  return sessions[0].session_id;
}

function storageSnapshot(harness: Harness) {
  return {
    projects: harness.queryDB(
      "SELECT id, path, tenant_id FROM projects ORDER BY tenant_id, id",
    ),
    knowledge: harness.queryDB(
      `SELECT id, logical_id, project_id, tenant_id, title, content
         FROM knowledge ORDER BY tenant_id, id`,
    ),
    temporal: harness.queryDB(
      `SELECT id, project_id, session_id, role, content, distilled
         FROM temporal_messages ORDER BY id`,
    ),
    sessions: harness.queryDB(
      `SELECT session_id, credential_fingerprint, header_name,
              header_session_id, project_path, project_path_provisional
         FROM session_state ORDER BY session_id`,
    ),
  };
}

function summaryFromResponse(
  endpoint: CompactEndpoint,
  body: Record<string, unknown>,
): string {
  if (endpoint === "/v1/compact") {
    return typeof body.summary === "string" ? body.summary : "";
  }
  const output = body.output as Array<{
    content?: Array<{ text?: string }>;
  }>;
  return String(output?.[0]?.content?.[0]?.text ?? "");
}

describe("compact endpoint remote tenant isolation", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    setBeforeUpstreamCaptureForTest(undefined);
    await harness?.teardown();
    harness = undefined;
  });

  test.each([
    {
      endpoint: "/v1/compact" as const,
      seedWrongTenantsFirst: true,
      restartBeforeCompact: false,
    },
    {
      endpoint: "/v1/responses/compact" as const,
      seedWrongTenantsFirst: false,
      restartBeforeCompact: true,
    },
  ])(
    "$endpoint reads only tenant B in adversarial order",
    async ({ endpoint, seedWrongTenantsFirst, restartBeforeCompact }) => {
      harness = await createHarness({
        fixtures: [
          makeFixtureEntry({
            seq: 0,
            requestMessages: [],
            responseText: "tenant B response",
          }),
        ],
        configOverrides: {
          remoteGateway: true,
          gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
        },
        projectPath: PROJECT_PATH,
      });

      if (seedWrongTenantsFirst) {
        await seedKnowledge("", LOCAL_SECRET);
        await seedKnowledge(TENANT_A, TENANT_A_SECRET);
      }

      await createTenantBSession(harness);
      await seedKnowledge(TENANT_B, TENANT_B_SECRET);

      if (!seedWrongTenantsFirst) {
        await seedKnowledge(TENANT_A, TENANT_A_SECRET);
        await seedKnowledge("", LOCAL_SECRET);
      }

      if (restartBeforeCompact) await harness.restartPipeline();

      const before = storageSnapshot(harness);
      expect(
        (before.projects as Array<{ tenant_id: string }>).map(
          (row) => row.tenant_id,
        ),
      ).toEqual(["", TENANT_A, TENANT_B].sort());

      const response = await postJson(
        harness.baseURL,
        endpoint,
        compactBody(endpoint),
        {
          "x-api-key": TENANT_B_KEY,
          "x-lore-session-id": SESSION_HEADER,
          "x-lore-project": PROJECT_PATH,
          "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
        },
      );
      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as Record<string, unknown>;
      const summary = summaryFromResponse(endpoint, responseBody).replaceAll(
        "\\",
        "",
      );
      expect(summary).toContain(TENANT_B_SECRET);
      expect(summary).not.toContain(TENANT_A_SECRET);
      expect(summary).not.toContain(LOCAL_SECRET);

      // Compaction is a read/assembly operation. In particular, it must not
      // create a local/A project row or rebind tenant B's persisted session.
      expect(storageSnapshot(harness)).toEqual(before);
    },
  );

  test.each(["/v1/compact" as const, "/v1/responses/compact" as const])(
    "$endpoint fails closed on an in-memory tenant mismatch",
    async (endpoint) => {
      harness = await createHarness({
        fixtures: [
          makeFixtureEntry({
            seq: 0,
            requestMessages: [],
            responseText: "tenant B response",
          }),
        ],
        configOverrides: {
          remoteGateway: true,
          gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
        },
        projectPath: PROJECT_PATH,
      });

      let sessionState: SessionState | undefined;
      await createTenantBSession(harness, (state) => {
        sessionState = state;
      });
      await seedKnowledge(TENANT_B, TENANT_B_SECRET);
      if (!sessionState)
        throw new Error("conversation did not expose session state");

      // Models the exact stale-owner state created by the old unscoped compact
      // path. The real HTTP route must reject it, never silently adopt/rewrite it.
      sessionState.storageTenantId = TENANT_A;
      const before = storageSnapshot(harness);
      const response = await postJson(
        harness.baseURL,
        endpoint,
        compactBody(endpoint),
        {
          "x-api-key": TENANT_B_KEY,
          "x-lore-session-id": SESSION_HEADER,
          "x-lore-project": PROJECT_PATH,
          "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
        },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: "session_not_found",
      });
      expect(storageSnapshot(harness)).toEqual(before);
      expect(sessionState.storageTenantId).toBe(TENANT_A);
    },
  );

  test.each(["/v1/compact" as const, "/v1/responses/compact" as const])(
    "$endpoint rejects mixed auth before storage access",
    async (endpoint) => {
      harness = await createHarness({
        fixtures: [],
        configOverrides: {
          remoteGateway: true,
          gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
        },
        projectPath: PROJECT_PATH,
      });

      const response = await postJson(
        harness.baseURL,
        endpoint,
        compactBody(endpoint),
        {
          "x-api-key": TENANT_B_KEY,
          "x-goog-api-key": "conflicting-google-key",
          "x-lore-session-id": SESSION_HEADER,
          "x-lore-project": PROJECT_PATH,
          "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN,
        },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        "Conflicting provider authentication headers",
      );
      expect(storageSnapshot(harness)).toEqual({
        projects: [],
        knowledge: [],
        temporal: [],
        sessions: [],
      });
    },
  );
});
