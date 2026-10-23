import { afterEach, expect, it } from "vitest";
import { setUpstreamInterceptor } from "../src/pipeline";
import { createHarness, type Harness } from "./helpers/harness";
import { makeReplayInterceptor } from "./helpers/replay";
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  makeFixtureEntry,
  STANDARD_TOOLS,
} from "./helpers/fixtures";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

it("keeps cold OpenCode sessions subagent-scoped until parent lookup resolves", async () => {
  const sessionID = "opencode-pending-parent-state";
  const fixtures = [
    makeFixtureEntry({
      seq: 0,
      system: DEFAULT_SYSTEM,
      requestMessages: [{ role: "user", content: "First turn" }],
      responseText: "First reply",
    }),
    makeFixtureEntry({
      seq: 1,
      system: DEFAULT_SYSTEM,
      requestMessages: [
        { role: "user", content: "First turn" },
        { role: "assistant", content: "First reply" },
        { role: "user", content: "Second turn" },
      ],
      responseText: "Second reply",
    }),
  ];
  harness = await createHarness({ fixtures });
  setUpstreamInterceptor(makeReplayInterceptor(fixtures));

  const request = (messages: Array<{ role: string; content: string }>) => ({
    model: DEFAULT_MODEL,
    max_tokens: 128,
    stream: false,
    system: DEFAULT_SYSTEM,
    tools: STANDARD_TOOLS,
    messages,
  });

  const pending = await harness.chat(
    request([{ role: "user", content: "First turn" }]),
    "test-key",
    {
      "x-lore-session-id": sessionID,
      "x-lore-session-parent-state": "pending",
    },
  );
  expect(pending.status).toBe(200);
  await pending.text();
  expect(
    harness.queryDB<{
      is_subagent: number;
      parent_session_pending: number;
    }>("SELECT is_subagent, parent_session_pending FROM session_state"),
  ).toEqual([{ is_subagent: 1, parent_session_pending: 1 }]);

  const resolvedPrimary = await harness.chat(
    request([
      { role: "user", content: "First turn" },
      { role: "assistant", content: "First reply" },
      { role: "user", content: "Second turn" },
    ]),
    "test-key",
    {
      "x-lore-session-id": sessionID,
      "x-lore-session-parent-state": "primary",
    },
  );
  expect(resolvedPrimary.status).toBe(200);
  await resolvedPrimary.text();
  expect(
    harness.queryDB<{
      is_subagent: number;
      parent_session_pending: number;
    }>("SELECT is_subagent, parent_session_pending FROM session_state"),
  ).toEqual([{ is_subagent: 0, parent_session_pending: 0 }]);
});
