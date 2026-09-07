import { afterEach, expect, it, vi } from "vitest";
import * as adapter from "../src/temporal-adapter";
import { createHarness, type Harness } from "./helpers/harness";
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  makeConversationFixtures,
  STANDARD_TOOLS,
} from "./helpers/fixtures";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
  vi.restoreAllMocks();
});

it.each([false, true])(
  "converts history once across a complete request and response (stream=%s)",
  async (stream) => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "latest input", assistantText: "stored reply" },
      ]),
    });
    const conversion = vi.spyOn(adapter, "gatewayMessagesToLore");
    const resolution = vi.spyOn(adapter, "resolveToolResults");
    const messages = Array.from({ length: 51 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: i === 50 ? "latest input" : `history ${i}`,
    }));
    const response = await harness.chat({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      stream,
      system: DEFAULT_SYSTEM,
      messages,
      tools: STANDARD_TOOLS,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("stored reply");
    await vi.waitFor(() =>
      expect(
        harness!.queryDB(
          "SELECT content FROM temporal_messages WHERE content = 'stored reply'",
        ),
      ).toHaveLength(1),
    );
    expect(
      conversion.mock.calls.filter(
        (call) => call[0].length === messages.length,
      ),
    ).toHaveLength(1);
    expect(
      conversion.mock.calls.every(
        (call) => call[0].length === messages.length || call[0].length === 1,
      ),
    ).toBe(true);
    expect(resolution).toHaveBeenCalledTimes(1);
    expect(
      harness.queryDB(
        "SELECT content FROM temporal_messages WHERE role = 'user'",
      ),
    ).toEqual([{ content: "latest input" }]);
  },
);
