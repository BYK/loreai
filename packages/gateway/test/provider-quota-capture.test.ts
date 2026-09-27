import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/harness";
import { makeReplayInterceptor } from "./helpers/replay";
import {
  makeFixtureEntry,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  STANDARD_TOOLS,
} from "./helpers/fixtures";
import { setUpstreamInterceptor } from "../src/pipeline";
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
