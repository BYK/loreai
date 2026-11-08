import { describe, expect, it } from "vitest";
import { RECALL_TOOL_DESCRIPTION, RECALL_TOOL_NAME } from "@loreai/core";
import { DEFAULT_MODEL, makeFixtureEntry } from "./helpers/fixtures.js";
import { createHarness } from "./helpers/harness.js";

describe("native recall reminder ingress", () => {
  it("keeps the commit reminder on a client-provided recall tool", async () => {
    const message = "Search my project memory.";
    const harness = await createHarness({
      fixtures: [
        makeFixtureEntry({
          seq: 0,
          model: DEFAULT_MODEL,
          requestMessages: [{ role: "user", content: message }],
          responseText: "done",
          wasStreaming: false,
        }),
      ],
    });
    try {
      const response = await harness.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
          "x-lore-agent": "code",
          "x-lore-project": process.cwd(),
          "x-lore-session-id": "native-recall-reminder-session",
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: 100,
          stream: false,
          messages: [{ role: "user", content: message }],
          tools: [
            {
              name: RECALL_TOOL_NAME,
              description: RECALL_TOOL_DESCRIPTION,
              input_schema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const upstreamBody = JSON.parse(harness.upstreamBodies()[0]) as {
        tools?: Array<{ name?: string; description?: string }>;
      };
      const recallTool = upstreamBody.tools?.find(
        (tool) => tool.name === RECALL_TOOL_NAME,
      );
      const { LORE_COMMIT_REMINDER } = await import("../src/pipeline.js");

      expect(recallTool?.description?.endsWith(LORE_COMMIT_REMINDER)).toBe(
        true,
      );
    } finally {
      await harness.teardown();
    }
  });
});
