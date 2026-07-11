/**
 * End-to-end wiring guard for #942 (follow-up to #829/#940).
 *
 * These drive the FULL pipeline (handleRequest → handleConversationTurn →
 * setLastSeenAuth) over HTTP, then observe the global fallback credential via
 * getLastSeenAuth(). They pin the BEHAVIOR — not just the pure helper — so a
 * revert of the two `setLastSeenAuth(..., resolveLastSeenProvider(...))` call
 * sites back to `extractProviderHeader(...) || undefined` fails here (the
 * unit tests in upstream-routes.test.ts would still pass on such a revert).
 *
 * The credential and the upstream destination are built together by the SDK on
 * the same outbound request, so deriving the tag from `x-lore-upstream-url`
 * always names the credential's true owner — closing the null-tag cross-borrow
 * window without reintroducing the #829 cross-contamination.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
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

describe("global fallback provider tag derived from upstream URL (#942)", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = undefined;
  });

  it("tags the global from x-lore-upstream-url when no x-lore-provider header is sent", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "header-less credentialed turn", assistantText: "ok" },
      ]),
    });

    // A credentialed request that carries NO x-lore-provider (the shape
    // produced by title/summary-gen calls bypassing chat.headers), but whose
    // upstream destination is recognizable.
    const r = await harness.chat(
      body("header-less credentialed turn"),
      "anthropic-key-942",
      { "x-lore-upstream-url": "https://api.anthropic.com" },
    );
    expect(r.status).toBe(200);
    await r.text();

    // The global is now tagged "anthropic" (derived from the URL) — a worker
    // for a DIFFERENT provider must NOT be able to borrow it (#829 guard).
    expect(getLastSeenAuth("openai")).toBeNull();
    // The credential's OWN provider still resolves it.
    expect(getLastSeenAuth("anthropic")).toEqual({
      scheme: "api-key",
      value: "anthropic-key-942",
    });
  });

  it("leaves the global agnostic (legacy) when neither provider nor upstream-url header is present", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "plain legacy turn", assistantText: "ok" },
      ]),
    });

    // No x-lore-provider AND no x-lore-upstream-url → null/agnostic tag, which
    // every provider lookup may borrow. This is the load-bearing single-
    // provider legacy path the fix must NOT break.
    const r = await harness.chat(body("plain legacy turn"), "legacy-key-942");
    expect(r.status).toBe(200);
    await r.text();

    const cred = { scheme: "api-key", value: "legacy-key-942" };
    expect(getLastSeenAuth("openai")).toEqual(cred);
    expect(getLastSeenAuth("anthropic")).toEqual(cred);
  });
});
