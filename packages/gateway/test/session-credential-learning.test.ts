/**
 * End-to-end regression coverage for credential leakage through Tier 2
 * session-header learning. Credential values must never become learning inputs
 * or be promoted into session_state as raw credentials.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { _resetGlobalHeaderValues } from "../src/session";
import {
  buildUpstreamSnapshotHeaders,
  forwardClientHeaders,
} from "../src/translate/types";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  makeFixtureEntry,
  STANDARD_TOOLS,
} from "./helpers/fixtures";

const SAFE_HEADER_NAME = "x-client-session-id";

function learningHeaders(
  suffix: "aaaa" | "bbbb",
  includeAlternativeAuth = false,
): Record<string, string> {
  const headers = {
    // Non-x names cannot reach promotion, but belong in the persistence corpus
    // so the end-to-end assertion covers the complete shared policy.
    // Authorization is covered by the historical-cleanup corpus below. It is
    // intentionally absent because ingress rejects ambiguous auth mechanisms.
    "Proxy-Authorization": `proxy-authorization-credential-${suffix}`,
    "api-key": `api-key-non-x-credential-${suffix}`,
    "cf-aig-authorization": `cf-aig-authorization-credential-${suffix}`,

    // First-pass credential shapes contain session/affinity and an auth marker.
    "x-auth-session-id": `auth-session-credential-${suffix}`,
    "x-bearer-session-id": `bearer-session-credential-${suffix}`,
    "x-key-session-id": `key-session-credential-${suffix}`,
    "x-oauth-session-id": `oauth-session-credential-${suffix}`,
    "x-secret-session-id": `secret-session-credential-${suffix}`,
    "x-session-key": `session-key-credential-${suffix}`,
    "x-token-session-id": `token-session-credential-${suffix}`,

    // Second-pass credential shapes are generic ID-like x-* headers.
    "x-access-key-id": `access-key-credential-${suffix}`,
    "x-api-key": `api-key-credential-${suffix}`,
    "x-auth-token": `auth-token-credential-${suffix}`,
    "x-client-secret": `client-secret-credential-${suffix}`,
    "x-credential-id": `credential-id-value-${suffix}`,
    "x-custom-auth": `custom-auth-credential-${suffix}`,
    "x-password": `password-credential-${suffix}`,
    "x-refresh-token": `refresh-token-credential-${suffix}`,
    "x-session-auth": `session-auth-credential-${suffix}`,
    "x-session-secret": `session-secret-credential-${suffix}`,
    "x-session-token": `session-token-credential-${suffix}`,

    // A non-credential session header must still learn and persist normally.
    [SAFE_HEADER_NAME]: `safe-session-value-${suffix}`,
  };
  return includeAlternativeAuth
    ? {
        ...headers,
        "x-goog-api-key": `goog-api-key-credential-${suffix}`,
      }
    : headers;
}

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

describe("shared credential forwarding policy", () => {
  test("removes credential-shaped headers from foreground and snapshot forwarding", () => {
    // The pure filtering boundary can receive conflicting auth candidates even
    // though ingress correctly rejects that combination before session learning.
    const rawHeaders = learningHeaders("aaaa", true);
    const safe = {
      [SAFE_HEADER_NAME]: rawHeaders[SAFE_HEADER_NAME],
    };

    expect(forwardClientHeaders(rawHeaders)).toEqual(safe);
    expect(buildUpstreamSnapshotHeaders(rawHeaders)).toEqual(safe);
  });
});

describe("Tier 2 credential exclusion", () => {
  let harness: Harness;

  beforeEach(() => {
    _resetGlobalHeaderValues();
  });

  afterEach(async () => {
    _resetGlobalHeaderValues();
    if (harness) await harness.teardown();
  });

  test("never persists credential candidates while a legitimate session header still learns", async () => {
    harness = await createHarness({
      fixtures: Array.from({ length: 4 }, (_, seq) =>
        makeFixtureEntry({
          seq,
          requestMessages: [],
          responseText: `response-${seq}`,
        }),
      ),
    });

    const headersA = learningHeaders("aaaa");
    const headersB = learningHeaders("bbbb");
    const chat = async (
      messages: Array<{ role: string; content: string }>,
      headers: Record<string, string>,
    ) => {
      const response = await harness.chat(
        body(messages),
        headers["x-api-key"],
        headers,
      );
      expect(response.status).toBe(200);
      await response.text();
    };

    // Session A supplies two stable observations.
    await chat([{ role: "user", content: "session A opening" }], headersA);
    await chat(
      [
        { role: "user", content: "session A opening" },
        { role: "assistant", content: "response-0" },
        { role: "user", content: "session A follow-up" },
      ],
      headersA,
    );

    // Session B gives every header a distinct global value, satisfying the
    // vulnerable learner's cross-session uniqueness condition.
    await chat([{ role: "user", content: "session B opening" }], headersB);

    // Session A's third stable observation reaches the promotion threshold.
    await chat(
      [
        { role: "user", content: "session A opening" },
        { role: "assistant", content: "response-0" },
        { role: "user", content: "session A follow-up" },
        { role: "assistant", content: "response-1" },
        { role: "user", content: "session A final turn" },
      ],
      headersA,
    );

    const learned = harness.queryDB<{
      header_name: string;
      header_session_id: string;
    }>(
      "SELECT header_name, header_session_id FROM session_state WHERE header_name IS NOT NULL",
    );
    expect(learned).toContainEqual({
      header_name: SAFE_HEADER_NAME,
      header_session_id: headersA[SAFE_HEADER_NAME],
    });

    const credentialNames = Object.keys(headersA).filter(
      (name) => name !== SAFE_HEADER_NAME,
    );
    credentialNames.push("Authorization");
    const rawCredentialValues = [
      ...credentialNames.map((name) => headersA[name]),
      ...credentialNames.map((name) => headersB[name]),
      "authorization-credential-aaaa",
      "authorization-credential-bbbb",
    ].filter((value): value is string => value !== undefined);
    const placeholders = (values: string[]) => values.map(() => "?").join(",");
    const leaked = harness.queryDB<{
      header_name: string;
      header_session_id: string;
    }>(
      `SELECT header_name, header_session_id FROM session_state
       WHERE header_name IN (${placeholders(credentialNames)})
          OR header_session_id IN (${placeholders(rawCredentialValues)})`,
      [...credentialNames, ...rawCredentialValues],
    );
    expect(leaked).toEqual([]);
  });

  test("clears credential mappings persisted by older versions on restart", async () => {
    harness = await createHarness({
      fixtures: [
        makeFixtureEntry({
          seq: 0,
          requestMessages: [],
          responseText: "response-0",
        }),
      ],
    });
    const historicalCredentials = [
      ["historical-auth-token", "x-auth-token", "historical-auth-token-secret"],
      [
        "historical-bearer-session",
        "x-bearer-session-id",
        "historical-bearer-session-secret",
      ],
      [
        "historical-bearer-underscore",
        "x_bearer_session_id",
        "historical-bearer-underscore-secret",
      ],
      [
        "historical-bearer-camel",
        "xBearerSessionId",
        "historical-bearer-camel-secret",
      ],
    ] as const;
    const historicalSafeMappings = [
      [
        "historical-claude-session",
        "x-claude-code-session-id",
        "historical-claude-session-value",
      ],
      [
        "historical-session-affinity",
        "x-session-affinity",
        "historical-session-affinity-value",
      ],
      [
        "historical-generic-session",
        "x-session-id",
        "historical-generic-session-value",
      ],
    ] as const;
    const database = new DatabaseSync(harness.dbPath);
    try {
      const insert = database.prepare(
        `INSERT INTO session_state
             (session_id, force_min_layer, updated_at, header_name, header_session_id)
           VALUES (?, 0, ?, ?, ?)`,
      );
      for (const [sessionID, headerName, headerValue] of [
        ...historicalCredentials,
        ...historicalSafeMappings,
      ]) {
        insert.run(sessionID, Date.now(), headerName, headerValue);
      }
    } finally {
      database.close();
    }

    await harness.restartPipeline();
    const response = await harness.chat(
      body([{ role: "user", content: "restart cleanup" }]),
    );
    expect(response.status).toBe(200);
    await response.text();

    const credentialSessionIDs = historicalCredentials.map(
      ([sessionID]) => sessionID,
    );
    const placeholders = credentialSessionIDs.map(() => "?").join(",");
    expect(
      harness.queryDB<{
        session_id: string;
        header_name: string | null;
        header_session_id: string | null;
      }>(
        `SELECT session_id, header_name, header_session_id
           FROM session_state WHERE session_id IN (${placeholders})
           ORDER BY session_id`,
        credentialSessionIDs,
      ),
    ).toEqual(
      [...credentialSessionIDs].sort().map((sessionID) => ({
        session_id: sessionID,
        header_name: null,
        header_session_id: null,
      })),
    );
    expect(
      harness.queryDB<{
        session_id: string;
        header_name: string;
        header_session_id: string;
      }>(
        `SELECT session_id, header_name, header_session_id
           FROM session_state
          WHERE session_id IN (${historicalSafeMappings.map(() => "?").join(",")})
          ORDER BY session_id`,
        historicalSafeMappings.map(([sessionID]) => sessionID),
      ),
    ).toEqual(
      [...historicalSafeMappings]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sessionID, headerName, headerSessionId]) => ({
          session_id: sessionID,
          header_name: headerName,
          header_session_id: headerSessionId,
        })),
    );
  });
});
