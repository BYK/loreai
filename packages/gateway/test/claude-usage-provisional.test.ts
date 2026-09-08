import { dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/harness";
import { makeReplayInterceptor } from "./helpers/replay";
import {
  makeConversationFixtures,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  STANDARD_TOOLS,
} from "./helpers/fixtures";
import { setUpstreamInterceptor } from "../src/pipeline";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

for (const stream of [true, false]) {
  for (const status of [200, 429]) {
    it(`preserves quota during real Claude session header migration (stream=${stream}, status=${status})`, async () => {
      const fixtures = makeConversationFixtures([
        { userMessage: "Hello", assistantText: "Hello back" },
        { userMessage: "Continue", assistantText: "Continuing" },
      ]);
      harness = await createHarness({ fixtures });
      const replay = makeReplayInterceptor(fixtures);
      let calls = 0;
      setUpstreamInterceptor(async (...args) => {
        calls++;
        const response =
          calls === 2 && status === 429
            ? new Response("private upstream quota detail", {
                status,
                headers: { "retry-after": "30" },
              })
            : await replay(...args);
        response.headers.set(
          "anthropic-ratelimit-unified-5h-utilization",
          "0.82",
        );
        response.headers.set(
          "anthropic-ratelimit-unified-7d-reset",
          "2000500000",
        );
        return response;
      });
      const request = {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        stream,
        system:
          DEFAULT_SYSTEM + "\nWorking directory: " + dirname(harness.dbPath),
        tools: STANDARD_TOOLS,
        messages: [{ role: "user", content: "Hello" }],
      };
      const alias = "claude-session-before-plugin";
      const initial = await harness.chat(request, "account-one", {
        "x-claude-code-session-id": alias,
      });
      expect(initial.status).toBe(200);
      await initial.text();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      // A newly introduced canonical header must adopt the already-confirmed
      // Claude alias through the provisional verification path.
      const response = await harness.chat(request, "account-one", {
        "x-claude-code-session-id": alias,
        "x-lore-session-id": "claude-session-after-plugin",
      });
      const body = await response.text();
      expect(calls).toBe(2);
      expect(response.status, body).toBe(status);
      expect(
        response.headers.get("anthropic-ratelimit-unified-5h-utilization"),
      ).toBe("0.82");
      expect(response.headers.get("anthropic-ratelimit-unified-7d-reset")).toBe(
        "2000500000",
      );
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
        expect(body).not.toContain("private upstream quota detail");
      }
    });
  }
}
