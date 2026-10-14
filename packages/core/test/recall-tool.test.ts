import { describe, expect, test, vi } from "vitest";
import type { LoreConfig } from "../src/config";
import {
  createRecallToolExecutor,
  parseRecallToolArguments,
  RECALL_TOOL_INPUT_SCHEMA,
  RECALL_TOOL_NAME,
  RECALL_TOOL_SCOPES,
  type RecallInput,
} from "../src/index";

describe("shared recall tool contract", () => {
  test("defines one bounded, provider-neutral schema", () => {
    expect(RECALL_TOOL_NAME).toBe("recall");
    expect(RECALL_TOOL_SCOPES).toEqual([
      "all",
      "session",
      "project",
      "knowledge",
    ]);
    expect(RECALL_TOOL_INPUT_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      anyOf: [
        { required: ["query"] },
        { required: ["id"] },
        { required: ["ids"] },
      ],
      properties: {
        query: { type: "string", maxLength: 512 },
        id: { type: "string", minLength: 1, maxLength: 256 },
        ids: { type: "array", minItems: 1, maxItems: 8 },
        detailOffset: {
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        detailLimit: { type: "integer", minimum: 1, maximum: 16_000 },
      },
    });
  });

  test("validates identifiers, exclusive detail modes, and strict object shape", () => {
    expect(
      parseRecallToolArguments({ query: "cache behavior", scope: "session" }),
    ).toEqual({
      valid: true,
      value: { query: "cache behavior", scope: "session" },
    });
    expect(
      parseRecallToolArguments({ id: "k:entry", detailOffset: 4 }),
    ).toEqual({
      valid: true,
      value: { id: "k:entry", detailOffset: 4 },
    });
    expect(parseRecallToolArguments({ query: " " }).valid).toBe(false);
    expect(
      parseRecallToolArguments({ id: "k:entry", ids: ["d:entry"] }).valid,
    ).toBe(false);
    expect(
      parseRecallToolArguments({ detailLimit: 10, query: "detail" }).valid,
    ).toBe(false);
    expect(
      parseRecallToolArguments({ query: "cache", extra: true }).valid,
    ).toBe(false);
    expect(parseRecallToolArguments({ ids: Array(1) }).valid).toBe(false);
  });

  test("executes through shared recall with host context and trusted config", async () => {
    const search = { recallLimit: 7 } as unknown as LoreConfig["search"];
    const cfg = {
      knowledge: { enabled: true },
      search,
    } as unknown as LoreConfig;
    const signal = new AbortController().signal;
    const run = vi.fn(async (_input: RecallInput) => "memory results");
    const execute = createRecallToolExecutor(run, () => cfg);

    await expect(
      execute(
        { query: "cache behavior", scope: "session" },
        { projectPath: "/project", sessionID: "session-1", signal },
      ),
    ).resolves.toBe("memory results");
    expect(run).toHaveBeenCalledWith({
      query: "cache behavior",
      scope: "session",
      projectPath: "/project",
      sessionID: "session-1",
      knowledgeEnabled: true,
      searchConfig: search,
      recordTransfers: true,
      signal,
    });
  });

  test("returns safe failures and honors cancellation", async () => {
    const run = vi.fn(async (_input: RecallInput) => {
      throw new Error("private query text");
    });
    const search = {} as unknown as LoreConfig["search"];
    const cfg = {
      knowledge: { enabled: false },
      search,
    } as unknown as LoreConfig;
    const execute = createRecallToolExecutor(run, () => cfg);

    await expect(
      execute({ query: "query" }, { projectPath: "/project" }),
    ).resolves.toBe("Recall failed. Please try again.");
    await expect(execute({}, { projectPath: "/project" })).resolves.toBe(
      "Pass query, id, or ids to recall.",
    );
    await expect(
      execute(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("private proxy failure");
            },
          },
        ),
        { projectPath: "/project" },
      ),
    ).resolves.toBe("Recall arguments are invalid.");

    const controller = new AbortController();
    controller.abort();
    await expect(
      execute(
        { query: "query" },
        { projectPath: "/project", signal: controller.signal },
      ),
    ).resolves.toBe("Recall was cancelled.");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
