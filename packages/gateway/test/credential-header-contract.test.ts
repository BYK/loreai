import { describe, expect, test } from "vitest";
import {
  collectCandidateHeaders,
  extractKnownSessionHeader,
  isCredentialHeaderName as isLearningCredentialHeaderName,
  KNOWN_SESSION_HEADERS,
  learnHeaders,
  _resetGlobalHeaderValues,
} from "../src/session";
import {
  buildUpstreamSnapshotHeaders,
  forwardClientHeaders,
  isCredentialHeaderName as isForwardingCredentialHeaderName,
} from "../src/translate/types";
import { scrubTelemetryText } from "../src/telemetry-privacy";
import { log } from "@loreai/core";

const CREDENTIAL_HEADER_CORPUS = [
  "Authorization",
  "Proxy-Authorization",
  "Cookie",
  "Cookie2",
  "api-key",
  "cf-aig-authorization",
  "cf-access-client-id",
  "x-api-key",
  "x-goog-api-key",
  "x-lore-gateway-token",
  "x-auth-token",
  "x-authtoken",
  "x-refresh-token",
  "x-client-secret",
  "x-access-key-id",
  "x-custom-auth",
  "x-credential-id",
  "x-password",
  "x-session-key",
  "x-client-session-key",
  "x-auth-session-id",
  "x-oauth-session-id",
  "x-secret-session-id",
  "x-token-session-id",
  "x-key-session-id",
  "x-bearer-session-id",
  "X-BEARER-SESSION-ID",
  "x_bearer_session_id",
  "x.bearer.session.id",
  "xBearerSessionId",
  "XBearerSessionID",
  "x-bearer_sessionId",
  "x-bearersessionid",
  "xbearersessionid",
] as const;

const COLLAPSED_CREDENTIAL_HEADER_ALIASES = [
  "xapikey",
  "xApiKey",
  "XAPIKEY",
  "x-apikey",
  "xapi-key",
  "x_api.key",
  "x.api_key",
  "x-api_key",
  "xApi_Key",
  ...["auth", "oauth", "secret", "token", "key"].flatMap((kind) => {
    const titleKind = `${kind[0].toUpperCase()}${kind.slice(1)}`;
    return [
      `x${kind}sessionid`,
      `x-${kind}sessionid`,
      `x.${kind}sessionid`,
      `x_${kind}sessionid`,
      `x${titleKind}SessionId`,
      `x${titleKind}_session_id`,
      `X${kind.toUpperCase()}SESSIONID`,
      `x_${kind}.sessionId`,
      `x-${kind}_session.id`,
    ];
  }),
] as const;

const REJECTED_CREDENTIAL_HEADER_NAMES = [
  ...CREDENTIAL_HEADER_CORPUS,
  ...COLLAPSED_CREDENTIAL_HEADER_ALIASES,
] as const;

describe("credential header classification contract", () => {
  test("forwarding and learning expose the shared classifier", () => {
    expect(isLearningCredentialHeaderName).toBe(
      isForwardingCredentialHeaderName,
    );
  });

  test.each(REJECTED_CREDENTIAL_HEADER_NAMES)(
    "forwarding and learning reject credential-shaped header %s",
    (name) => {
      const value = "credential-value-aaaa1111";

      expect(isForwardingCredentialHeaderName(name)).toBe(true);
      expect(isLearningCredentialHeaderName(name)).toBe(
        isForwardingCredentialHeaderName(name),
      );
      expect(forwardClientHeaders({ [name]: value })).toEqual({});
      expect(buildUpstreamSnapshotHeaders({ [name]: value })).toEqual({});
      expect(collectCandidateHeaders({ [name]: value }).has(name)).toBe(false);
      const freeText = `diagnostic prefix: ${name}=${value} status=401`;
      const expected = `diagnostic prefix: ${name}=[Filtered] status=401`;
      expect(scrubTelemetryText(freeText)).toBe(expected);
      expect(log.redactSensitiveLogText(freeText)).toBe(expected);

      const compound =
        `diagnostic prefix: ${name}: foo=first-secret; ` +
        "bar=second-secret status=401";
      const compoundExpected = `diagnostic prefix: ${name}: [Filtered] status=401`;
      expect(scrubTelemetryText(compound)).toBe(compoundExpected);
      expect(log.redactSensitiveLogText(compound)).toBe(compoundExpected);
    },
  );

  test("x-bearer-session-id cannot promote from historical candidate state", () => {
    _resetGlobalHeaderValues();
    const name = "x-bearer-session-id";
    const value = "credential-value-aaaa1111";

    learnHeaders(undefined, { [name]: "credential-value-bbbb2222" });
    const result = learnHeaders(new Map([[name, { value, seenCount: 2 }]]), {
      [name]: value,
    });

    expect(result.updatedCandidates.has(name)).toBe(false);
    expect(result.promoted).toBeNull();
  });

  test.each(KNOWN_SESSION_HEADERS)(
    "established session header %s remains safe and usable",
    (name) => {
      const value = "legitimate-session-value-1234";

      expect(isForwardingCredentialHeaderName(name)).toBe(false);
      expect(isLearningCredentialHeaderName(name)).toBe(false);
      expect(collectCandidateHeaders({ [name]: value }).get(name)).toBe(value);
      expect(extractKnownSessionHeader({ [name]: value })).toEqual({
        headerName: name,
        sessionId: value,
      });
      expect(forwardClientHeaders({ [name]: value })).toEqual({});
    },
  );

  test.each([
    "x-client-session-id",
    "x-keyboard-session-id",
    "x-monkey-session-id",
  ])("safe learned session header %s remains eligible", (name) => {
    const value = "legitimate-session-value-1234";

    expect(isForwardingCredentialHeaderName(name)).toBe(false);
    expect(isLearningCredentialHeaderName(name)).toBe(false);
    expect(collectCandidateHeaders({ [name]: value }).get(name)).toBe(value);
    expect(forwardClientHeaders({ [name]: value })).toEqual({ [name]: value });
  });

  test.each([
    ...KNOWN_SESSION_HEADERS,
    "idempotency-key",
    "sec-websocket-key",
    "session-id",
    "x-client-session-id",
    "x-keyboard-session-id",
    "x-monkey-session-id",
  ])("safe diagnostic header %s remains visible in free text", (name) => {
    const diagnostic = `diagnostic prefix: ${name}=safe-diagnostic-value`;

    expect(isForwardingCredentialHeaderName(name)).toBe(false);
    expect(scrubTelemetryText(diagnostic)).toBe(diagnostic);
    expect(log.redactSensitiveLogText(diagnostic)).toBe(diagnostic);
  });

  test("does not redact a bearer scheme diagnostic without an assignment credential", () => {
    const diagnostic = "routing decision scheme=bearer provider=anthropic";

    expect(scrubTelemetryText(diagnostic)).toBe(diagnostic);
    expect(log.redactSensitiveLogText(diagnostic)).toBe(diagnostic);
  });
});
