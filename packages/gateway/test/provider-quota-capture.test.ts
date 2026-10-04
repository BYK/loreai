import { dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
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
  getActiveSessions,
  setPostResponseStartObserverForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { buildOpenAIResponsesResponse } from "../src/translate/openai-responses";
import { db, listProviderQuotas } from "@loreai/core";

const quotaHeaders = {
  "anthropic-ratelimit-unified-5h-utilization": "0.23",
  "anthropic-ratelimit-unified-5h-reset": "1999999999",
  "anthropic-ratelimit-unified-7d-utilization": "0.41",
  "anthropic-ratelimit-unified-7d-reset": "2000500000",
  "anthropic-ratelimit-unified-status": "allowed",
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

it("persists upstream quota headers without touching the client response", async () => {
  db().exec("DELETE FROM provider_quotas");
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
  await response.text();
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

it("attributes quota headers to the session credential on the provisional path", async () => {
  db().exec("DELETE FROM provider_quotas");
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
  await initial.text();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  db().exec("DELETE FROM provider_quotas");

  // A new canonical session id routes the turn through the provisional
  // verification path. Even though this request carries an api-key-shaped
  // credential, quota capture must attribute it to the session (OAuth →
  // subscription, same account) via the forwarded sessionID.
  const response = await harness.chat(request, null, {
    authorization: "Bearer sk-ant-api03-test-token",
    "x-claude-code-session-id": alias,
    "x-lore-session-id": "claude-session-after-plugin",
  });
  await response.text();
  expect(response.status).toBe(200);

  const quotas = listProviderQuotas().filter((q) => q.provider === "anthropic");
  expect(quotas.length).toBeGreaterThan(0);
  for (const q of quotas) {
    expect(q.authKind).toBe("subscription");
  }
});

it("attributes quota headers to the Codex session account on the provisional path", async () => {
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
    // api.openai.com resolves provider "openai" without self-identifying as
    // the ChatGPT subscription backend — the session's stored
    // chatgpt-account-id (captured on the first turn) is the only
    // subscription discriminator on the provisional forward.
    "x-lore-upstream-url": "https://api.openai.com",
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
  await initial.text();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  db().exec("DELETE FROM provider_quotas");

  // A new canonical session id routes the turn through the provisional
  // verification path — quota capture must resolve the ChatGPT account from
  // the session snapshot via the forwarded sessionID.
  const migrated = await harness.request("/v1/codex/responses", {
    method: "POST",
    headers: { ...headers, "x-lore-session-id": "codex-after-plugin" },
    body: JSON.stringify(request),
  });
  await migrated.text();
  expect(migrated.status).toBe(200);

  const quotas = listProviderQuotas().filter((q) => q.provider === "openai");
  expect(quotas.length).toBeGreaterThan(0);
  for (const q of quotas) {
    expect(q.authKind).toBe("subscription");
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
