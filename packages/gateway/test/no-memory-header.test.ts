import { describe, expect, test } from "vitest";
import { ltm } from "@loreai/core";
import { createTestDatabasePath } from "../../core/test/helpers/test-db-path";
import { createHarness } from "./helpers/harness";
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  STANDARD_TOOLS,
} from "./helpers/fixtures";
import {
  canInjectMemory,
  setUpstreamInterceptor,
  suppressesMemoryInjection,
} from "../src/pipeline";

describe("x-lore-no-memory", () => {
  test("suppresses LTM reads only when explicitly requested", () => {
    expect(suppressesMemoryInjection({ "x-lore-no-memory": "true" })).toBe(
      true,
    );
    expect(suppressesMemoryInjection({ "x-lore-no-store": "true" })).toBe(
      false,
    );
    expect(suppressesMemoryInjection({})).toBe(false);
  });

  test("blocks both LTM injection paths for a no-memory request", () => {
    expect(canInjectMemory(true, { "x-lore-no-memory": "true" })).toBe(false);
    expect(canInjectMemory(true, {})).toBe(true);
    expect(canInjectMemory(false, {})).toBe(false);
  });

  test("omits seeded project knowledge from the actual upstream request", async () => {
    const projectPath = createTestDatabasePath("no-memory-project").slice(
      0,
      -3,
    );
    const harness = await createHarness({ fixtures: [], projectPath });
    try {
      const marker = "SYNTHETIC-NO-MEMORY-EXPERIMENT-ONLY";
      ltm.create({
        projectPath,
        category: "preference",
        title: "Evaluation preference",
        content: marker,
        scope: "project",
        confidence: 1,
      });
      const upstreamBodies: string[] = [];
      setUpstreamInterceptor(async (body) => {
        upstreamBodies.push(JSON.stringify(body));
        return new Response(
          JSON.stringify({
            id: "msg_eval_control",
            type: "message",
            role: "assistant",
            model: DEFAULT_MODEL,
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      const request = {
        model: DEFAULT_MODEL,
        max_tokens: 128,
        stream: false,
        system: DEFAULT_SYSTEM,
        messages: [
          { role: "user", content: "Help with the project convention" },
        ],
        tools: STANDARD_TOOLS,
      };
      const normal = await harness.chat(request, "test-key", {
        "x-lore-session-id": "eval-with-memory",
        "x-lore-no-store": "true",
      });
      expect(normal.status).toBe(200);
      await normal.text();
      expect(upstreamBodies).toHaveLength(1);
      expect(upstreamBodies[0].includes(marker)).toBe(true);
      const normalTools = (
        JSON.parse(upstreamBodies[0]) as { tools: Array<{ name: string }> }
      ).tools;
      expect(normalTools.some((tool) => tool.name === "recall")).toBe(true);

      const control = await harness.chat(request, "test-key", {
        "x-lore-session-id": "eval-without-memory",
        "x-lore-no-memory": "true",
        "x-lore-no-store": "true",
      });
      expect(control.status).toBe(200);
      await control.text();
      expect(upstreamBodies).toHaveLength(2);
      expect(upstreamBodies[1].includes(marker)).toBe(false);
      const controlTools = (
        JSON.parse(upstreamBodies[1]) as { tools: Array<{ name: string }> }
      ).tools;
      expect(controlTools.some((tool) => tool.name === "recall")).toBe(false);
      expect(
        upstreamBodies[1].includes("Lore actively manages and compresses"),
      ).toBe(false);
    } finally {
      await harness.teardown();
    }
  });
});
