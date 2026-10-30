import { afterEach, expect, it } from "vitest";
import { resetPipelineState, setUpstreamInterceptor } from "../src/pipeline";
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

it.each([
  [false, "opencode"],
  [true, "opencode"],
  [true, "claude"],
] as const)(
  "keeps an explicitly confirmed primary across an adapter restart (gateway restart: %s, parent signal: %s)",
  async (restartGateway, parentSignal) => {
    const sessionID = "opencode-confirmed-primary";
    const fixtures = Array.from({ length: 6 }, (_, seq) =>
      makeFixtureEntry({ seq, requestMessages: [], responseText: "Reply" }),
    );
    const activeHarness = await createHarness({ fixtures });
    harness = activeHarness;
    const messages: Array<{ role: string; content: string }> = [];
    const turn = async (headers: Record<string, string>) => {
      messages.push({ role: "user", content: `Turn ${messages.length}` });
      const response = await activeHarness.chat(
        {
          model: DEFAULT_MODEL,
          max_tokens: 128,
          stream: false,
          system: DEFAULT_SYSTEM,
          tools: STANDARD_TOOLS,
          messages,
        },
        "test-key",
        { "x-lore-session-id": sessionID, ...headers },
      );
      expect(response.status).toBe(200);
      await response.text();
      messages.push({ role: "assistant", content: "Reply" });
    };
    const classification = () =>
      activeHarness.queryDB<{
        is_subagent: number;
        parent_session_pending: number;
      }>("SELECT is_subagent, parent_session_pending FROM session_state");

    await turn({ "x-lore-session-parent-state": "primary" });
    if (restartGateway) await harness.restartPipeline();
    // OpenCode loses its metadata cache on adapter restart, even though the
    // gateway already received an explicit primary confirmation for this ID.
    await turn({ "x-lore-session-parent-state": "pending" });
    expect(classification()).toEqual([
      { is_subagent: 0, parent_session_pending: 0 },
    ]);

    // Native parent evidence must supersede even a persisted confirmation.
    const parentHeaders: Record<string, string> =
      parentSignal === "claude"
        ? {
            "x-claude-code-agent-id": "discovered-child-agent",
            "x-claude-code-session-id": "eventually-discovered-parent",
            "x-claude-code-request-class": "subagent",
          }
        : { "x-parent-session-id": "eventually-discovered-parent" };
    await turn({
      "x-lore-session-parent-state": "primary",
      ...parentHeaders,
    });
    expect(classification()).toEqual([
      { is_subagent: 1, parent_session_pending: 0 },
    ]);
    await harness.restartPipeline();
    await turn({ "x-lore-session-parent-state": "primary" });
    expect(classification()).toEqual([
      { is_subagent: 1, parent_session_pending: 0 },
    ]);
  },
);

it("keeps a cold unknown child conservative until explicit parent evidence arrives", async () => {
  const fixtures = Array.from({ length: 4 }, (_, seq) =>
    makeFixtureEntry({ seq, requestMessages: [], responseText: "Reply" }),
  );
  const activeHarness = await createHarness({ fixtures });
  harness = activeHarness;
  const messages: Array<{ role: string; content: string }> = [];
  const turn = async (headers: Record<string, string>) => {
    messages.push({ role: "user", content: `Turn ${messages.length}` });
    const response = await activeHarness.chat(
      {
        model: DEFAULT_MODEL,
        max_tokens: 128,
        stream: false,
        system: DEFAULT_SYSTEM,
        tools: STANDARD_TOOLS,
        messages,
      },
      "test-key",
      { "x-lore-session-id": "cold-child", ...headers },
    );
    expect(response.status).toBe(200);
    await response.text();
    messages.push({ role: "assistant", content: "Reply" });
  };
  const classification = () =>
    activeHarness.queryDB(
      "SELECT is_subagent, parent_session_pending, parent_session_primary FROM session_state",
    );
  await turn({ "x-lore-session-parent-state": "pending" });
  expect(classification()).toEqual([
    { is_subagent: 1, parent_session_pending: 1, parent_session_primary: 0 },
  ]);
  await harness.restartPipeline();
  await turn({ "x-lore-session-parent-state": "pending" });
  expect(classification()).toEqual([
    { is_subagent: 1, parent_session_pending: 1, parent_session_primary: 0 },
  ]);
  await turn({
    "x-lore-session-parent-state": "primary",
    "x-parent-session-id": "explicit-parent",
  });
  expect(classification()).toEqual([
    { is_subagent: 1, parent_session_pending: 0, parent_session_primary: 0 },
  ]);
});

it("restores pending parent classification across a pipeline restart", async () => {
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
    makeFixtureEntry({
      seq: 2,
      system: DEFAULT_SYSTEM,
      requestMessages: [
        { role: "user", content: "First turn" },
        { role: "assistant", content: "First reply" },
        { role: "user", content: "Second turn" },
        { role: "assistant", content: "Second reply" },
        { role: "user", content: "Third turn" },
      ],
      responseText: "Third reply",
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

  // Clear the in-memory session cache to model a gateway process restart;
  // the next turn has no parent-state header and must hydrate the durable flag.
  await resetPipelineState();
  setUpstreamInterceptor(makeReplayInterceptor(fixtures));

  const afterRestart = await harness.chat(
    request([
      { role: "user", content: "First turn" },
      { role: "assistant", content: "First reply" },
      { role: "user", content: "Second turn" },
    ]),
    "test-key",
    { "x-lore-session-id": sessionID },
  );
  expect(afterRestart.status).toBe(200);
  await afterRestart.text();
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
      { role: "assistant", content: "Second reply" },
      { role: "user", content: "Third turn" },
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
