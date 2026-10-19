import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./helpers/harness";
import { makeReplayInterceptor } from "./helpers/replay";
import {
  makeConversationFixtures,
  makeFixtureEntry,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  STANDARD_TOOLS,
} from "./helpers/fixtures";
import {
  _waitForProviderQuotaCapturesForTest,
  getActiveSessions,
  setPostResponseStartObserverForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { setUpstreamFetchOverrideForTest } from "../src/fetch";
import { authFingerprint } from "../src/auth";
import { buildOpenAIResponsesResponse } from "../src/translate/openai-responses";
import {
  _resetCostAttributionForTest,
  recordSuccessfulAnthropicOAuthAuth,
} from "../src/cost-attribution";
import { db, isProviderQuotaStale, listProviderQuotas } from "@loreai/core";

const quotaHeaders = {
  "anthropic-ratelimit-unified-5h-utilization": "0.23",
  "anthropic-ratelimit-unified-5h-reset": "1999999999",
  "anthropic-ratelimit-unified-7d-utilization": "0.41",
  "anthropic-ratelimit-unified-7d-reset": "2000500000",
  "anthropic-ratelimit-unified-status": "allowed",
};

const TEST_ANTHROPIC_OAUTH_CREDENTIAL = {
  scheme: "bearer",
  value: "sk-ant-oat01-test-token",
} as const;

function trustTestAnthropicOAuthCredential(): void {
  recordSuccessfulAnthropicOAuthAuth({
    credential: TEST_ANTHROPIC_OAUTH_CREDENTIAL,
    upstreamURL: "https://api.anthropic.com/v1/messages",
    responseURL: "https://api.anthropic.com/v1/messages",
    responseStatus: 200,
    directUpstreamResponse: true,
  });
}

let harness: Harness | undefined;
afterEach(async () => {
  await _waitForProviderQuotaCapturesForTest();
  await harness?.teardown();
  harness = undefined;
  _resetCostAttributionForTest();
});

async function consumeResponseAndQuotaCapture(
  response: Response,
): Promise<void> {
  await response.text();
  await _waitForProviderQuotaCapturesForTest();
}

it("persists upstream quota headers without touching the client response", async () => {
  db().exec("DELETE FROM provider_quotas");
  trustTestAnthropicOAuthCredential();
  const fixtures = [
    makeFixtureEntry({
      seq: 0,
      requestMessages: [{ role: "user", content: "Hello" }],
      responseText: "Hello back",
    }),
  ];
  harness = await createHarness({ fixtures });
  const replay = makeReplayInterceptor(fixtures);
  setUpstreamInterceptor(async (...args) => {
    const response = await replay(...args);
    for (const [name, value] of Object.entries(quotaHeaders)) {
      response.headers.set(name, value);
    }
    return response;
  });

  const response = await harness.chat(
    {
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      stream: false,
      system: DEFAULT_SYSTEM,
      tools: STANDARD_TOOLS,
      messages: [{ role: "user", content: "Hello" }],
    },
    null,
    { authorization: "Bearer sk-ant-oat01-test-token" },
  );
  await consumeResponseAndQuotaCapture(response);
  expect(response.status).toBe(200);

  const quotas = listProviderQuotas().filter(
    (q) => q.provider === "anthropic" && q.authKind === "subscription",
  );
  const fiveH = quotas.find((q) => q.window === "5h");
  const sevenD = quotas.find((q) => q.window === "7d");
  expect(fiveH).toMatchObject({
    usedPercent: 23,
    windowMinutes: 300,
    resetsAt: 1_999_999_999_000,
    source: "anthropic-unified",
    label: "allowed",
  });
  expect(sevenD).toMatchObject({
    usedPercent: 41,
    windowMinutes: 10080,
    resetsAt: 2_000_500_000_000,
    source: "anthropic-unified",
  });

  // The client-visible response headers are unchanged by quota capture.
  for (const [name, value] of Object.entries(quotaHeaders)) {
    expect(response.headers.get(name), name).toBe(value);
  }
});

it("captures quota on the first successful Anthropic OAuth response", async () => {
  db().exec("DELETE FROM provider_quotas");
  const fixture = makeFixtureEntry({
    seq: 0,
    requestMessages: [{ role: "user", content: "First OAuth request" }],
    responseText: "Recorded",
  });
  harness = await createHarness({ fixtures: [fixture] });
  const previousFetchOverride = setUpstreamFetchOverrideForTest(async () => {
    const response = new Response(JSON.stringify(fixture.response), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...quotaHeaders,
      },
    });
    Object.defineProperty(response, "url", {
      value: "https://api.anthropic.com/v1/messages",
    });
    return response;
  });
  setUpstreamInterceptor(async (_body, _model, _stream, makeRealRequest) =>
    makeRealRequest(),
  );
  try {
    const response = await harness.chat(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        stream: false,
        system: DEFAULT_SYSTEM,
        tools: STANDARD_TOOLS,
        messages: [{ role: "user", content: "First OAuth request" }],
      },
      null,
      { authorization: "Bearer sk-ant-oat01-first-request" },
    );
    await consumeResponseAndQuotaCapture(response);
    expect(response.status).toBe(200);
  } finally {
    setUpstreamFetchOverrideForTest(previousFetchOverride);
    setUpstreamInterceptor(undefined);
  }
  expect(
    listProviderQuotas().filter(
      (quota) =>
        quota.provider === "anthropic" && quota.authKind === "subscription",
    ),
  ).toHaveLength(2);
});

it("keeps a later-started quota observation when responses complete out of order", async () => {
  db().exec("DELETE FROM provider_quotas");
  trustTestAnthropicOAuthCredential();
  const fixtures = makeConversationFixtures([
    { userMessage: "Older request", assistantText: "Older response" },
    { userMessage: "Newer request", assistantText: "Newer response" },
  ]);
  harness = await createHarness({ fixtures });
  const replay = makeReplayInterceptor(fixtures);
  const entered = [deferred<void>(), deferred<void>()];
  const release: Array<() => void> = [];
  const utilization = ["0.10", "0.60"];
  let callCount = 0;
  setUpstreamInterceptor(async (...args) => {
    const index = callCount++;
    await new Promise<void>((resolve) => {
      release[index] = resolve;
      entered[index].resolve();
    });
    const response = await replay(...args);
    response.headers.set(
      "anthropic-ratelimit-unified-5h-utilization",
      utilization[index],
    );
    response.headers.set("anthropic-ratelimit-unified-5h-reset", "1999999999");
    response.headers.set("anthropic-ratelimit-unified-status", "allowed");
    return response;
  });

  let now = Date.now();
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  const headers = { authorization: "Bearer sk-ant-oat01-test-token" };
  const request = (message: string) =>
    harness!.chat(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        stream: false,
        system: DEFAULT_SYSTEM,
        tools: STANDARD_TOOLS,
        messages: [{ role: "user", content: message }],
      },
      null,
      headers,
    );

  try {
    const older = request("Older request");
    await entered[0].promise;
    now += 1_000;
    const newer = request("Newer request");
    await entered[1].promise;

    now += 1_000;
    release[1]();
    const newerResponse = await newer;
    await consumeResponseAndQuotaCapture(newerResponse);

    now += 1_000;
    release[0]();
    const olderResponse = await older;
    await consumeResponseAndQuotaCapture(olderResponse);
  } finally {
    nowSpy.mockRestore();
    for (const resolve of release) resolve();
  }

  const quota = listProviderQuotas().find(
    (row) =>
      row.provider === "anthropic" &&
      row.authKind === "subscription" &&
      row.window === "5h",
  );
  expect(quota?.usedPercent).toBe(60);
});

it.each([
  ["direct response", false],
  ["wrapped response", true],
])(
  "anchors relative quota resets to receipt time for a %s",
  async (_label, wrap) => {
    db().exec("DELETE FROM provider_quotas");
    const fixtures = [
      makeFixtureEntry({
        seq: 0,
        requestMessages: [{ role: "user", content: "Delayed response" }],
        responseText: "Received",
      }),
    ];
    harness = await createHarness({ fixtures });
    const replay = makeReplayInterceptor(fixtures);
    const startedAt = Date.now() + 60_000;
    let now = startedAt;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    setUpstreamInterceptor(async (...args) => {
      const response = await replay(...args);
      now += 30_000;
      for (const [name, value] of Object.entries({
        "x-rate-limit-limit": "100",
        "x-rate-limit-remaining": "90",
        "x-rate-limit-reset": "60",
      })) {
        response.headers.set(name, value);
      }
      return wrap
        ? new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        : response;
    });

    try {
      const response = await harness.chat(
        {
          model: DEFAULT_MODEL,
          max_tokens: 1024,
          stream: false,
          system: DEFAULT_SYSTEM,
          tools: STANDARD_TOOLS,
          messages: [{ role: "user", content: "Delayed response" }],
        },
        null,
        { authorization: "Bearer sk-ant-oat01-test-token" },
      );
      await consumeResponseAndQuotaCapture(response);
    } finally {
      nowSpy.mockRestore();
    }

    const quota = listProviderQuotas().find(
      (row) => row.provider === "anthropic" && row.window === "requests",
    );
    expect(quota).toBeDefined();
    expect(quota?.observedAt).toBe(startedAt);
    expect(quota?.resetsAt).toBe(startedAt + 90_000);
    expect(isProviderQuotaStale(quota!, startedAt + 70_000)).toBe(false);
  },
);

it("anchors wrapped quota resets to upstream header receipt, not wrapper completion", async () => {
  db().exec("DELETE FROM provider_quotas");
  const fixture = makeFixtureEntry({
    seq: 0,
    requestMessages: [{ role: "user", content: "Delayed response" }],
    responseText: "Received",
  });
  harness = await createHarness({ fixtures: [fixture] });
  const startedAt = Date.now() + 600_000;
  let now = startedAt;
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  const previousFetchOverride = setUpstreamFetchOverrideForTest(async () => {
    now = startedAt + 30_000;
    return new Response(JSON.stringify(fixture.response), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-rate-limit-limit": "100",
        "x-rate-limit-remaining": "90",
        "x-rate-limit-reset": "60",
      },
    });
  });
  setUpstreamInterceptor(async (_body, _model, _stream, makeRealRequest) => {
    const response = await makeRealRequest();
    now += 15_000;
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });

  try {
    const response = await harness.chat(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        stream: false,
        system: DEFAULT_SYSTEM,
        tools: STANDARD_TOOLS,
        messages: [{ role: "user", content: "Delayed response" }],
      },
      null,
      { authorization: "Bearer sk-ant-oat01-test-token" },
    );
    await consumeResponseAndQuotaCapture(response);
  } finally {
    setUpstreamFetchOverrideForTest(previousFetchOverride);
    nowSpy.mockRestore();
  }

  const quota = listProviderQuotas().find(
    (row) => row.provider === "anthropic" && row.window === "requests",
  );
  expect(quota?.observedAt).toBeGreaterThanOrEqual(startedAt);
  expect(quota?.observedAt).toBeLessThan(startedAt + 1);
  expect(quota?.resetsAt).toBe(startedAt + 90_000);
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("attributes quota headers to the session credential on the provisional path", async () => {
  db().exec("DELETE FROM provider_quotas");
  trustTestAnthropicOAuthCredential();
  const fixtures = makeConversationFixtures([
    { userMessage: "Hello", assistantText: "Hello back" },
    { userMessage: "Continue", assistantText: "Continuing" },
  ]);
  harness = await createHarness({ fixtures });
  const replay = makeReplayInterceptor(fixtures);
  setUpstreamInterceptor(async (...args) => {
    const response = await replay(...args);
    // Non-unified anthropic-ratelimit headers persist quota rows but do NOT
    // themselves classify the credential as a subscription.
    response.headers.set("anthropic-ratelimit-requests-limit", "100");
    response.headers.set("anthropic-ratelimit-requests-remaining", "63");
    return response;
  });

  const request = {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    // The billing-header sentinel marks the session as Claude Code OAuth.
    system:
      "x-anthropic-billing-header: cc_version=2.1.37.abc; cc_entrypoint=cli; cch=1a2b3;\n" +
      DEFAULT_SYSTEM +
      "\nWorking directory: " +
      dirname(harness.dbPath),
    tools: STANDARD_TOOLS,
    messages: [{ role: "user", content: "Hello" }],
  };
  const alias = "claude-session-before-plugin";
  const initial = await harness.chat(request, null, {
    authorization: "Bearer sk-ant-oat01-test-token",
    "x-claude-code-session-id": alias,
  });
  expect(initial.status).toBe(200);
  await consumeResponseAndQuotaCapture(initial);

  db().exec("DELETE FROM provider_quotas");

  // A new canonical session ID and the old alias cannot transfer OAuth
  // attribution to a different API-key credential.
  const response = await harness.chat(request, null, {
    authorization: "Bearer sk-ant-api03-test-token",
    "x-claude-code-session-id": alias,
    "x-lore-session-id": "claude-session-after-plugin",
  });
  await consumeResponseAndQuotaCapture(response);
  expect(response.status).toBe(200);

  const quotas = listProviderQuotas().filter((q) => q.provider === "anthropic");
  expect(quotas.length).toBeGreaterThan(0);
  for (const q of quotas) {
    expect(q.authKind).toBe("api_key");
  }
});

it("caller-selected Codex headers do not establish subscription quota attribution", async () => {
  db().exec("DELETE FROM provider_quotas");
  harness = await createHarness({ fixtures: [] });
  setUpstreamInterceptor(async () => {
    const response = buildOpenAIResponsesResponse(
      {
        id: "resp_quota",
        model: "gpt-5",
        content: [{ type: "text", text: "Hello quota" }],
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 3 },
      },
      true,
    );
    const text = await response.text();
    return new Response(text, {
      headers: {
        "content-type": "text/event-stream",
        // openai-ratelimit headers persist quota rows but do NOT classify the
        // credential as a subscription (unlike x-codex-* headers).
        "x-ratelimit-limit-requests": "200",
        "x-ratelimit-remaining-requests": "150",
        "x-ratelimit-reset-requests": "30m",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-used-percent": "10",
        "x-codex-primary-reset-at": "2000000000",
        "x-codex-secondary-window-minutes": "0",
      },
    });
  });
  const projectPath = dirname(harness.dbPath);
  const request = {
    model: "gpt-5",
    stream: true,
    instructions: DEFAULT_SYSTEM + "\nWorking directory: " + projectPath,
    input: [{ role: "user", content: "Hello" }],
    tools: ["read", "write", "shell"].map((name) => ({
      type: "function",
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    })),
  };
  const headers = {
    "content-type": "application/json",
    authorization: "Bearer chatgpt-oauth-token",
    // The backend is caller-selected and the response is intercepted, so
    // neither can establish authenticated subscription state.
    "x-lore-upstream-url": "https://chatgpt.com/backend-api/codex",
    "chatgpt-account-id": "acct-xyz",
    "x-lore-project": projectPath,
    "x-session-id": "codex-before-plugin",
  };
  const initial = await harness.request("/v1/codex/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  expect(initial.status).toBe(200);
  await consumeResponseAndQuotaCapture(initial);

  db().exec("DELETE FROM provider_quotas");

  // A new canonical session id and a different caller-selected header must
  // still attribute this credential to the same bounded account key.
  const migrated = await harness.request("/v1/codex/responses", {
    method: "POST",
    headers: {
      ...headers,
      "chatgpt-account-id": "caller-selected-second-account",
      "x-lore-session-id": "codex-after-plugin",
    },
    body: JSON.stringify(request),
  });
  await consumeResponseAndQuotaCapture(migrated);
  expect(migrated.status).toBe(200);

  const quotas = listProviderQuotas().filter((q) => q.provider === "openai");
  expect(quotas.length).toBeGreaterThan(0);
  const expectedAccount = authFingerprint({
    scheme: "bearer",
    value: "chatgpt-oauth-token",
  }).slice(0, 12);
  for (const q of quotas) {
    expect(q.authKind).toBe("api_key");
    expect(q.window).not.toBe("0m");
    expect(q.account).toBe(expectedAccount);
    expect(q.account).not.toBe("acct-xyz");
    expect(q.account).not.toBe("caller-selected-second-account");
  }
});

it("records Codex subscription auth only after direct ChatGPT success", async () => {
  db().exec("DELETE FROM provider_quotas");
  harness = await createHarness({ fixtures: [] });
  _resetCostAttributionForTest();
  const previousFetchOverride = setUpstreamFetchOverrideForTest(async () => {
    const upstream = buildOpenAIResponsesResponse(
      {
        id: "resp_authenticated_codex",
        model: "gpt-5",
        content: [{ type: "text", text: "Authenticated response" }],
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 3 },
      },
      true,
    );
    return new Response(await upstream.text(), {
      headers: {
        "content-type": "text/event-stream",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-used-percent": "23",
        "x-codex-primary-reset-at": "2000000000",
        "x-codex-secondary-window-minutes": "0",
      },
    });
  });
  setUpstreamInterceptor(async (_body, _model, _stream, makeRealRequest) =>
    makeRealRequest(),
  );

  try {
    const projectPath = dirname(harness.dbPath);
    const response = await harness.request("/v1/codex/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer verified-codex-token",
        "x-lore-upstream-url": "https://chatgpt.com/backend-api/codex",
        "x-lore-project": projectPath,
        "x-session-id": "direct-codex-auth",
      },
      body: JSON.stringify({
        model: "gpt-5",
        stream: true,
        instructions: DEFAULT_SYSTEM + "\nWorking directory: " + projectPath,
        input: [{ role: "user", content: "Authenticate subscription" }],
        tools: [],
      }),
    });
    await consumeResponseAndQuotaCapture(response);
    expect(response.status).toBe(200);

    const quotas = listProviderQuotas().filter(
      (row) => row.provider === "openai",
    );
    expect(quotas.length).toBeGreaterThan(0);
    expect(quotas.every((row) => row.authKind === "subscription")).toBe(true);
    expect(quotas.every((row) => row.account === "default")).toBe(true);
  } finally {
    setUpstreamFetchOverrideForTest(previousFetchOverride);
  }
});

it("attributes conversation cost from the resolved route when session upstream is gone", async () => {
  db().exec("DELETE FROM provider_costs");
  const fixtures = [
    makeFixtureEntry({
      seq: 0,
      requestMessages: [{ role: "user", content: "Hello" }],
      responseText: "Hello back",
    }),
  ];
  harness = await createHarness({ fixtures });
  const replay = makeReplayInterceptor(fixtures);
  setUpstreamInterceptor(replay);
  try {
    // postResponse runs before accounting; simulate the session snapshot
    // being gone by then (deferred finalizer after idle eviction clears
    // lastUpstream and drops the live state). The request's resolved route
    // must still attribute the spend.
    setPostResponseStartObserverForTest(() => {
      for (const state of getActiveSessions().values()) {
        state.lastUpstream = undefined;
      }
    });
    const response = await harness.chat({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      stream: false,
      system: DEFAULT_SYSTEM,
      tools: STANDARD_TOOLS,
      messages: [{ role: "user", content: "Hello" }],
    });
    await response.text();
    expect(response.status).toBe(200);
  } finally {
    setPostResponseStartObserverForTest(undefined);
  }

  const rows = db()
    .query("SELECT provider, auth_kind FROM provider_costs")
    .all() as Array<{ provider: string; auth_kind: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ provider: "anthropic", auth_kind: "api_key" });
});
