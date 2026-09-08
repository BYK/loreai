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
import { setUpstreamInterceptor } from "../src/pipeline";

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
for (const stream of [true, false]) {
  it(`preserves subscription windows through a real conversation (stream=${stream})`, async () => {
    const fixtures = [
      makeFixtureEntry({
        seq: 0,
        requestMessages: [{ role: "user", content: "Hello" }],
        responseText: "Hello back",
        inputTokens: 600000,
      }),
    ];
    harness = await createHarness({ fixtures });
    const replay = makeReplayInterceptor(fixtures);
    setUpstreamInterceptor(async (...args) => {
      const response = await replay(...args);
      for (const [name, value] of Object.entries(quotaHeaders))
        response.headers.set(name, value);
      response.headers.set("set-cookie", "upstream-secret=private");
      response.headers.set("x-private-upstream", "private");
      response.headers.set(
        "connection",
        "keep-alive, Anthropic-Ratelimit-Private-Hop",
      );
      response.headers.set("anthropic-ratelimit-private-hop", "not end-to-end");
      response.headers.set("content-encoding", "gzip");
      response.headers.set("content-length", "99999999");
      return response;
    });
    const response = await harness.chat({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      stream,
      system: DEFAULT_SYSTEM,
      tools: STANDARD_TOOLS,
      messages: [{ role: "user", content: "Hello" }],
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    for (const [name, value] of Object.entries(quotaHeaders))
      expect(response.headers.get(name), name).toBe(value);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-private-upstream")).toBeNull();
    expect(response.headers.get("anthropic-ratelimit-private-hop")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("99999999");
    expect(body).toContain("Hello");
    const message = stream
      ? JSON.parse(
          body
            .split("\n")
            .find(
              (line) =>
                line.startsWith("data: ") &&
                line.includes('"type":"message_start"'),
            )!
            .slice(6),
        ).message
      : JSON.parse(body);
    expect(message.usage.input_tokens).toBeLessThan(600000);
  });
}

for (const stream of [true, false]) {
  it(`preserves quota exhaustion and reset headers on 429 (stream=${stream})`, async () => {
    harness = await createHarness({ fixtures: [] });
    setUpstreamInterceptor(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "rate_limit_error",
              message: "private upstream detail",
            },
          }),
          {
            status: 429,
            headers: {
              ...quotaHeaders,
              "anthropic-ratelimit-unified-status": "rejected",
              "retry-after": "30",
              "set-cookie": "private=secret",
            },
          },
        ),
    );
    const response = await harness.chat({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      stream,
      system: DEFAULT_SYSTEM,
      tools: STANDARD_TOOLS,
      messages: [{ role: "user", content: "Hello" }],
    });
    const body = await response.text();
    expect(response.status).toBe(429);
    expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe(
      "rejected",
    );
    expect(response.headers.get("anthropic-ratelimit-unified-5h-reset")).toBe(
      quotaHeaders["anthropic-ratelimit-unified-5h-reset"],
    );
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(body).not.toContain("private upstream detail");
  });
}
it("preserves quota headers on buffered side-channel requests", async () => {
  const fixtures = makeConversationFixtures([
    { userMessage: "Title", assistantText: "A title" },
  ]);
  harness = await createHarness({ fixtures });
  const replay = makeReplayInterceptor(fixtures);
  setUpstreamInterceptor(async (...args) => {
    const response = await replay(...args);
    for (const [name, value] of Object.entries(quotaHeaders))
      response.headers.set(name, value);
    return response;
  });
  const response = await harness.chat({
    model: DEFAULT_MODEL,
    max_tokens: 32,
    stream: false,
    messages: [{ role: "user", content: "Title" }],
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  for (const [name, value] of Object.entries(quotaHeaders))
    expect(response.headers.get(name)).toBe(value);
});
it("never reuses another account's quota when an upstream omits it", async () => {
  const fixtures = makeConversationFixtures([
    { userMessage: "One", assistantText: "One" },
    { userMessage: "Two", assistantText: "Two" },
  ]);
  harness = await createHarness({ fixtures });
  const replay = makeReplayInterceptor(fixtures);
  let calls = 0;
  setUpstreamInterceptor(async (...args) => {
    const response = await replay(...args);
    if (calls++ === 0)
      for (const [name, value] of Object.entries(quotaHeaders))
        response.headers.set(name, value);
    return response;
  });
  const request = {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    tools: STANDARD_TOOLS,
    messages: [{ role: "user", content: "Hello" }],
  };
  const first = await harness.chat(request, "account-one");
  await first.text();
  expect(first.headers.get("anthropic-ratelimit-unified-5h-utilization")).toBe(
    "0.23",
  );
  const second = await harness.chat(request, "account-two");
  await second.text();
  expect(second.status).toBe(200);
  for (const name of Object.keys(quotaHeaders))
    expect(second.headers.get(name)).toBeNull();
});
