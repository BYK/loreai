import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/bun";
import { buildSentryOptions } from "../instrument";
import {
  SENTRY_DATA_COLLECTION,
  isolateRecallContinuationEvent,
  scrubTelemetryEvent,
  scrubTelemetryEnvelope,
  scrubTelemetryText,
  wrapTelemetryTransport,
} from "../src/telemetry-privacy";

const SECRETS = [
  "bearer-production-secret",
  "anthropic-production-key",
  "query-production-secret",
  "cookie-production-secret",
  "password-production-secret",
  "client-secret-camel-case",
  "access-token-pascal-case",
  "refresh-token-json",
  "signature-colon-value",
  "azure-subscription-secret",
  "cloudflare-client-secret",
  "/home/private/project-marker",
  "prompt-title-marker",
  "entity-alias-marker",
  "/lore:private-command-marker",
];

function expectNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of SECRETS) expect(serialized).not.toContain(secret);
}

describe("telemetry privacy boundary", () => {
  it("explicitly disables automatic sensitive-data collection", () => {
    expect(SENTRY_DATA_COLLECTION).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    });
  });

  it("wires privacy hooks and the final scrubber into production options", async () => {
    let sent: unknown;
    const options = buildSentryOptions(() => ({
      send(envelope) {
        sent = envelope;
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }));
    expect(options.sendDefaultPii).toBe(false);
    expect(options.dataCollection).toEqual(SENTRY_DATA_COLLECTION);
    expect(options.enableLogs).toBe(false);
    expect(options.beforeSend).toBeTypeOf("function");
    expect(options.beforeSendLog).toBeTypeOf("function");
    expect(options.beforeSendSpan).toBeTypeOf("function");
    expect(options.beforeSendTransaction).toBeTypeOf("function");
    expect(options.beforeBreadcrumb).toBeTypeOf("function");

    const transport = options.transport?.({
      url: "https://sentry.invalid",
      recordDroppedEvent: () => {},
    });
    await transport?.send([
      {
        event_id: "1234567890abcdef1234567890abcdef",
        sent_at: new Date(0).toISOString(),
      },
      [
        [
          { type: "event" },
          { request: { headers: { authorization: SECRETS[0] } } },
        ],
      ],
    ]);

    expectNoSecrets(sent);
  });

  it("drops application logs instead of trying to redact arbitrary content", async () => {
    const privateMarkers = [
      "PRIVATE_PROMPT_TITLE_MARKER",
      "PRIVATE_ENTITY_ALIAS_MARKER",
      "/home/private/PRIVATE_PROJECT_PATH_MARKER",
      "/lore:PRIVATE_SLASH_COMMAND_MARKER",
    ];
    let sent: unknown;
    const options = buildSentryOptions(() => ({
      send(envelope) {
        sent = envelope;
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }));

    expect(
      options.beforeSendLog?.({
        level: "info",
        message: privateMarkers.join(" "),
        attributes: { entityAlias: privateMarkers[1] },
      }),
    ).toBeNull();

    const transport = options.transport?.({
      url: "https://sentry.invalid",
      recordDroppedEvent: () => {},
    });
    const adversarialEnvelope: unknown = [
      { event_id: "event-id" },
      [
        [
          {
            type: "log",
            item_count: 1,
            content_type: "application/vnd.sentry.items.log+json",
          },
          {
            items: [
              {
                body: privateMarkers.join(" "),
                attributes: { promptTitle: privateMarkers[0] },
              },
            ],
          },
        ],
        [{ type: "event" }, { message: "designed error telemetry" }],
      ],
    ];
    await transport?.send(
      adversarialEnvelope as Parameters<
        NonNullable<typeof transport>["send"]
      >[0],
    );

    const serialized = JSON.stringify(sent);
    for (const marker of privateMarkers)
      expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('"type":"log"');
    expect(serialized).toContain("Application error");
  });

  it("reduces recall-continuation events to the fixed allowlist", () => {
    const input: Event = {
      event_id: "event-id",
      timestamp: 1,
      platform: "javascript",
      level: "warning",
      message: "Recall continuation failed",
      fingerprint: ["private-fingerprint"],
      user: { id: SECRETS[0] },
      tags: { model: SECRETS[1] },
      transaction: SECRETS[2],
      request: { url: `https://example.invalid/?secret=${SECRETS[3]}` },
      contexts: {
        trace: { trace_id: SECRETS[4], span_id: SECRETS[5] },
        recall_continuation_failure: { category: "follow_up_protocol" },
      },
      extra: { diagnostic: SECRETS[6] },
      breadcrumbs: [{ message: SECRETS[7] }],
      sdkProcessingMetadata: { private: SECRETS[8] },
    };
    const event = isolateRecallContinuationEvent(input);

    expect(event).toEqual({
      event_id: "event-id",
      timestamp: 1,
      platform: "javascript",
      level: "warning",
      message: "Recall continuation failed",
      fingerprint: ["recall-continuation-failure", "follow_up_protocol"],
      contexts: {
        recall_continuation_failure: { category: "follow_up_protocol" },
      },
    });
    expectNoSecrets(event);
    expect(scrubTelemetryEvent(input)).toEqual(event);

    const options = buildSentryOptions();
    expect(
      options.beforeSend?.(
        input as Parameters<NonNullable<typeof options.beforeSend>>[0],
        {},
      ),
    ).toEqual(event);
  });

  it("drops invalid recall categories at the isolated boundary", () => {
    expect(
      isolateRecallContinuationEvent({
        message: "Recall continuation failed",
        contexts: {
          recall_continuation_failure: { category: SECRETS[0] },
        },
      }),
    ).toBeNull();
  });

  it("scrubs request data, breadcrumbs, contexts, and span attributes", () => {
    const event = scrubTelemetryEvent({
      request: {
        url: `https://user:password-production-secret@example.com/v1/messages?api_key=query-production-secret#fragment`,
        method: "POST",
        headers: {
          authorization: "Bearer bearer-production-secret",
          "x-api-key": "anthropic-production-key",
        },
        query_string: "api_key=query-production-secret",
        cookies: { session: "cookie-production-secret" },
        data: { prompt: "private request body" },
      },
      user: {
        id: "installation-id",
        ip_address: "203.0.113.10",
        email: "private@example.com",
      },
      breadcrumbs: [
        {
          message: "Authorization: Bearer bearer-production-secret",
          data: {
            url: "https://example.com/models?token=query-production-secret",
            cookie: "cookie-production-secret",
          },
        },
      ],
      contexts: {
        trace: {
          span_id: "1234567890abcdef",
          trace_id: "1234567890abcdef1234567890abcdef",
          "http.request.header.x_api_key": "anthropic-production-key",
          "http.query": "password=password-production-secret",
          clientSecret: "client-secret-camel-case",
          AccessToken: "access-token-pascal-case",
          refresh_token: "refresh-token-json",
          "request-signature": "signature-colon-value",
          "ocp-apim-subscription-key": "azure-subscription-secret",
          "cf-access-client-id": "cloudflare-client-secret",
          promptTitle: "prompt-title-marker",
          entityAlias: "entity-alias-marker",
          projectPath: "/home/private/project-marker",
          slashCommand: "/lore:private-command-marker",
        },
      },
      tags: {
        superSecret: "camel-suffix-secret",
        cookieJar: "cookie-jar-secret",
      },
      spans: [
        {
          data: {
            authorization: "Bearer bearer-production-secret",
            "url.full":
              "https://example.com/v1/messages?key=query-production-secret",
          },
          span_id: "1234567890abcdef",
          trace_id: "1234567890abcdef1234567890abcdef",
          start_timestamp: 1,
        },
      ],
    });

    expectNoSecrets(event);
    expect(event.request).toEqual({
      method: "POST",
      url: "https://example.com/v1/messages",
    });
    expect(event.user).toEqual({ id: "installation-id" });
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.tags?.superSecret).toBe("[Filtered]");
    expect(event.tags?.cookieJar).toBe("[Filtered]");
  });

  it("uses the credential-header policy for structured and free-form values", () => {
    const azure = "azure-subscription-secret";
    const cloudflare = "cloudflare-client-secret";
    const scrubbed = scrubTelemetryEnvelope({
      attributes: {
        "ocp-apim-subscription-key": azure,
        "cf-access-client-id": cloudflare,
      },
      message:
        `ocp-apim-subscription-key=${azure}\n` +
        `cf-access-client-id: ${cloudflare}`,
    });

    expect(JSON.stringify(scrubbed)).not.toContain(azure);
    expect(JSON.stringify(scrubbed)).not.toContain(cloudflare);
  });

  it("scrubs every item sent through the final transport boundary", async () => {
    let sent: unknown;
    const transport = wrapTelemetryTransport({
      send(envelope: unknown) {
        sent = envelope;
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    });
    const envelope = [
      { event_id: "event-id" },
      [
        [
          { type: "event" },
          {
            request: {
              url: "https://example.com/path?key=query-production-secret",
              headers: { Authorization: "Bearer bearer-production-secret" },
            },
          },
        ],
        [
          { type: "log" },
          {
            items: [
              {
                body: "x-api-key=anthropic-production-key",
                attributes: {
                  password: "password-production-secret",
                },
              },
            ],
          },
        ],
        [
          { type: "span" },
          {
            items: [
              {
                data: {
                  "http.request.header.authorization":
                    "Bearer bearer-production-secret",
                  "http.request.query": "key=query-production-secret",
                },
              },
            ],
          },
        ],
      ],
    ];

    await transport.send(envelope);

    expectNoSecrets(sent);
    expect(JSON.stringify(sent)).toContain("[Filtered]");
  });

  it("replaces arbitrary exception text and removes breadcrumbs", () => {
    const marker = "PRIVATE_ARBITRARY_ERROR_MARKER";
    const event = scrubTelemetryEvent({
      message: `failure at /home/private/project: ${marker}`,
      exception: { values: [{ type: "Error", value: marker }] },
      breadcrumbs: [{ message: marker }],
      extra: { detail: marker, errorMessage: marker },
    });

    expect(JSON.stringify(event)).not.toContain(marker);
    expect(event.message).toBe("Application error");
    expect(event.exception?.values?.[0]?.value).toBe("Application error");
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.extra?.detail).toBe("[Filtered]");
    expect(event.extra?.errorMessage).toBe("[Filtered]");
  });

  it("scrubs event message text at the final envelope boundary", () => {
    const marker = "PRIVATE_FINAL_ENVELOPE_ERROR_MARKER";
    const scrubbed = scrubTelemetryEnvelope([
      { event_id: "event-id" },
      [
        [
          { type: "event" },
          {
            message: marker,
            exception: { values: [{ type: "Error", value: marker }] },
          },
        ],
      ],
    ]);

    expect(JSON.stringify(scrubbed)).not.toContain(marker);
    expect(JSON.stringify(scrubbed)).toContain("Application error");
  });

  it("scrubs cache-divergence snippet attributes at the final envelope boundary", () => {
    const userMarker = "PRIVATE_DIVERGENCE_USER_MARKER";
    const systemMarker = "PRIVATE_DIVERGENCE_SYSTEM_MARKER";
    const scrubbed = scrubTelemetryEnvelope([
      { event_id: "event-id" },
      [
        [
          { type: "transaction" },
          {
            spans: [
              {
                data: {
                  "lore.cache.divergence_prev_snippet": userMarker,
                  "lore.cache.divergence_curr_snippet": systemMarker,
                  "lore.cache.divergence_snippet_after": systemMarker,
                  lorecachedivergencefallbacksnippet: userMarker,
                  "lore.cache.divergence_point": "system[0].text",
                  "lore.cache.divergence_reason": "system prompt changed",
                  "lore.cache.prefix_match": 0.012,
                },
              },
            ],
          },
        ],
      ],
    ]);

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(userMarker);
    expect(serialized).not.toContain(systemMarker);
    expect(serialized.split("[Filtered]")).toHaveLength(5);
    expect(serialized).toContain(
      '"lore.cache.divergence_point":"system[0].text"',
    );
    expect(serialized).toContain(
      '"lore.cache.divergence_reason":"system prompt changed"',
    );
    expect(serialized).toContain('"lore.cache.prefix_match":0.012');
  });

  it("redacts credentials and URL query values in free-form log text", () => {
    const scrubbed = scrubTelemetryText(
      "url=https://example.com/v1/messages?key=query-production-secret\n" +
        "Authorization: Bearer bearer-production-secret\n" +
        "x-api-key=anthropic-production-key\n" +
        "clientSecret=client-secret-camel-case\n" +
        'credentials={"refreshToken":"refresh-token-json"}\n' +
        "AccessToken: access-token-pascal-case\n" +
        "request_signature: signature-colon-value",
    );

    expectNoSecrets(scrubbed);
    expect(scrubbed).toContain("https://example.com/v1/messages");
  });

  it.each([
    {
      name: "a quoted scalar containing whitespace",
      input: 'request failed: token = "quoted secret value" status=401',
      secrets: ["quoted secret value"],
      expected: 'request failed: token = "[Filtered]" status=401',
    },
    {
      name: "an unquoted scalar containing whitespace",
      input: "request failed: token = unquoted secret value status=401",
      secrets: ["unquoted secret value"],
      expected: "request failed: token = [Filtered] status=401",
    },
    {
      name: "an unquoted JSON scalar",
      input: 'request failed: {"token":12345,"status":401}',
      secrets: ["12345"],
      expected: 'request failed: {"token":[Filtered],"status":401}',
    },
    {
      name: "a boolean JSON scalar",
      input: 'request failed: {"token":true,"status":401}',
      secrets: ["true"],
      expected: 'request failed: {"token":[Filtered],"status":401}',
    },
    {
      name: "a null JSON scalar",
      input: 'request failed: {"token":null,"status":401}',
      secrets: ["null"],
      expected: 'request failed: {"token":[Filtered],"status":401}',
    },
    {
      name: "a JSON array",
      input:
        'request failed: credentials=["array-secret",{"nested":"object-secret"}] status=401',
      secrets: ["array-secret", "object-secret"],
      expected: "request failed: credentials=[Filtered] status=401",
    },
    {
      name: "a JSON object",
      input:
        'request failed: credentials={"refreshToken":"refresh-secret","nested":["nested-secret"]} status=401',
      secrets: ["refresh-secret", "nested-secret"],
      expected: "request failed: credentials=[Filtered] status=401",
    },
    {
      name: "a Cookie compound value",
      input:
        "request failed: Cookie: session=cookie-secret; refresh=refresh-secret, oauth=oauth-secret status=401",
      secrets: ["cookie-secret", "refresh-secret", "oauth-secret"],
      expected: "request failed: Cookie: [Filtered] status=401",
    },
    {
      name: "a Cookie2 compound value",
      input:
        "request failed: Cookie2: session=cookie-secret; refresh=refresh-secret, oauth=oauth-secret status=401",
      secrets: ["cookie-secret", "refresh-secret", "oauth-secret"],
      expected: "request failed: Cookie2: [Filtered] status=401",
    },
    {
      name: "a non-cookie compound header value",
      input:
        "request failed: x-auth-token: foo=first-secret; bar=second-secret status=401",
      secrets: ["first-secret", "second-secret"],
      expected: "request failed: x-auth-token: [Filtered] status=401",
    },
  ])("redacts the complete value of $name after arbitrary text", (testCase) => {
    const scrubbed = scrubTelemetryText(testCase.input);

    for (const secret of testCase.secrets) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubbed).toBe(testCase.expected);
  });

  it.each([
    "xapikey",
    "x-authsessionid",
    "x-oauthsessionid",
    "x-secretsessionid",
    "x-tokensessionid",
    "x-keysessionid",
  ])("redacts collapsed credential alias %s in free text", (name) => {
    const secret = "collapsed-alias-secret";

    expect(scrubTelemetryText(`request failed: ${name}=${secret}`)).toBe(
      `request failed: ${name}=[Filtered]`,
    );
  });

  it("redacts compound credential headers at the final envelope boundary", () => {
    const scrubbed = scrubTelemetryEnvelope({
      contexts: {
        trace: {
          diagnostic:
            "x-auth-token: foo=first-secret; bar=second-secret status=401",
        },
      },
    });

    expect(JSON.stringify(scrubbed)).not.toContain("first-secret");
    expect(JSON.stringify(scrubbed)).not.toContain("second-secret");
    expect(JSON.stringify(scrubbed)).toContain("status=401");
  });

  it("preserves a bearer scheme diagnostic", () => {
    for (const diagnostic of [
      "routing decision scheme=bearer provider=anthropic",
      "routing decision scheme=bearer selected upstream",
    ]) {
      expect(scrubTelemetryText(diagnostic)).toBe(diagnostic);
    }
  });
});
