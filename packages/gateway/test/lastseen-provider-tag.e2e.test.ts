/**
 * End-to-end wiring guard for process-global auth capture.
 *
 * The global fallback is legacy single-user state. It may be populated only by
 * an unambiguous local request to a configured direct provider. Client-selected
 * routes and remote/hosted gateways must keep credentials session-scoped.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness, TEST_GATEWAY_AUTH_TOKEN } from "./helpers/harness";
import {
  makeConversationFixtures,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";
import { getLastSeenAuth } from "../src/auth";

function body(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: STANDARD_TOOLS,
  };
}

describe("legacy process-global auth capture", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = undefined;
  });

  it("does not capture auth from a client-selected upstream URL", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "header-less credentialed turn", assistantText: "ok" },
      ]),
    });

    const r = await harness.chat(
      body("header-less credentialed turn"),
      "anthropic-key-942",
      { "x-lore-upstream-url": "https://api.anthropic.com" },
    );
    expect(r.status).toBe(200);
    await r.text();

    expect(getLastSeenAuth("openai")).toBeNull();
    expect(getLastSeenAuth("anthropic")).toBeNull();
  });

  it("does not capture auth on a remote gateway", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "remote credentialed turn", assistantText: "ok" },
      ]),
      configOverrides: {
        remoteGateway: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });

    const r = await harness.chat(
      body("remote credentialed turn"),
      "remote-key-942",
      { "x-lore-gateway-token": TEST_GATEWAY_AUTH_TOKEN },
    );
    expect(r.status).toBe(200);
    await r.text();

    expect(getLastSeenAuth("openai")).toBeNull();
    expect(getLastSeenAuth("anthropic")).toBeNull();
  });

  it("captures auth for a local header-less configured direct-provider route", async () => {
    harness = await createHarness({ fixtures: [] });

    // An intercepted slash command avoids background worker activity while
    // still exercising handleRequest's early auth-capture path end-to-end.
    const r = await harness.chat(body("/lore:unknown"), "local-key-942");
    expect(r.status).toBe(200);
    await r.text();

    expect(getLastSeenAuth("openai")).toBeNull();
    expect(getLastSeenAuth("anthropic")).toEqual({
      scheme: "api-key",
      value: "local-key-942",
    });
  });
});
