import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as adapter from "../src/temporal-adapter";
import { PreparationTiming } from "../src/semantic-preparation";
import { setForceMinLayer } from "@loreai/core";
import { createHarness, type Harness } from "./helpers/harness";
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  makeConversationFixtures,
  STANDARD_TOOLS,
} from "./helpers/fixtures";

let harness: Harness | undefined;
let projectDirectory: string | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
  if (projectDirectory)
    rmSync(projectDirectory, { recursive: true, force: true });
  projectDirectory = undefined;
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

it.each([false, true])(
  "restores a bounded source window through the real pipeline (stream=%s)",
  async (stream) => {
    projectDirectory = mkdtempSync(join(tmpdir(), "lore-source-pipeline-"));
    harness = await createHarness({
      projectPath: projectDirectory,
      budget: { maxLayer0Tokens: 8000 },
      fixtures: makeConversationFixtures([
        { userMessage: "first input", assistantText: "first reply" },
        { userMessage: "second input", assistantText: "second reply" },
        { userMessage: "third input", assistantText: "third reply" },
      ]),
    });
    const source = Array.from({ length: 5581 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content:
        i === 50
          ? "first input"
          : i === 51
            ? "first reply"
            : i === 5580
              ? "second input"
              : `history ${i}: ${"useful context ".repeat(15)}`,
    }));
    const send = async (
      messages: typeof source,
      reply: string,
      stored: number,
    ) => {
      const response = await harness!.chat(
        {
          model: DEFAULT_MODEL,
          max_tokens: 1024,
          stream,
          system: DEFAULT_SYSTEM,
          messages,
          tools: STANDARD_TOOLS,
        },
        "test-key",
        { "x-lore-session-id": "source-window-pipeline" },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(reply);
      await vi.waitFor(() =>
        expect(
          harness!.queryDB(
            "SELECT content FROM temporal_messages WHERE role = 'assistant'",
          ),
        ).toHaveLength(stored),
      );
    };
    await send(source.slice(0, 51), "first reply", 1);
    const sid = harness.queryDB<{ session_id: string }>(
      "SELECT session_id FROM temporal_messages LIMIT 1",
    )[0].session_id;
    setForceMinLayer(3, sid);
    await send(source, "second reply", 2);
    expect(
      harness.queryDB(
        "SELECT payload FROM source_windows WHERE payload IS NOT NULL",
      ),
    ).toHaveLength(1);
    await harness.restartPipeline();
    const conversion = vi.spyOn(adapter, "gatewayMessagesToLore");
    const metrics = vi.spyOn(PreparationTiming.prototype, "metric");
    await send(
      [
        ...source,
        { role: "assistant", content: "second reply" },
        { role: "user", content: "third input" },
      ],
      "third reply",
      3,
    );
    expect(
      conversion.mock.calls.map((call) => [call[0].length, call[2], call[3]]),
      JSON.stringify(
        metrics.mock.calls.filter((call) => call[0].startsWith("source_")),
      ),
    ).toContainEqual([2, 5581, 5581]);
    expect(
      conversion.mock.calls.some(
        (call) => call[0].length === 2 && call[2] === 5581 && call[3] === 5581,
      ),
    ).toBe(true);
    expect(conversion.mock.calls.every((call) => call[0].length <= 2)).toBe(
      true,
    );
  },
);
