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
    expect(RECALL_TOOL_NAME).toBe("lore_recall");
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
      parseRecallToolArguments({
        id: "k:019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
        detailOffset: 4,
      }),
    ).toEqual({
      valid: true,
      value: {
        id: "k:019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
        detailOffset: 4,
      },
    });
    expect(parseRecallToolArguments({ query: " " }).valid).toBe(false);
    expect(
      parseRecallToolArguments({
        id: "k:019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
        ids: ["d:019e18ec-e328-76c4-9c3c-09dbe8d51c6c"],
      }).valid,
    ).toBe(false);
    expect(
      parseRecallToolArguments({ detailLimit: 10, query: "detail" }).valid,
    ).toBe(false);
    expect(
      parseRecallToolArguments({ query: "cache", extra: true }).valid,
    ).toBe(false);
    expect(parseRecallToolArguments({ ids: Array(1) }).valid).toBe(false);
  });

  test("rejects query text masquerading as a source selector", () => {
    const privateQuery = "find the private cache behavior note";

    expect(parseRecallToolArguments({ id: privateQuery }).valid).toBe(false);
    expect(parseRecallToolArguments({ ids: [privateQuery] }).valid).toBe(false);
    expect(
      parseRecallToolArguments({
        ids: ["k:019e18ec-e328-76c4-9c3c-09dbe8d51c6c", privateQuery],
      }).valid,
    ).toBe(false);
  });

  test("accepts only supported source and detail-reference formats", () => {
    for (const id of [
      "xk:019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
      "d:019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
      `t:${"a".repeat(32)}`,
      "t:lore_tm_v1_" + "A".repeat(43),
      "lat:packages/core/README#Long-term Knowledge",
      "r:019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
    ]) {
      expect(parseRecallToolArguments({ id }).valid, id).toBe(true);
    }

    for (const id of [
      "k:short",
      "t:source-1",
      "other:019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
      "lat:private query",
    ]) {
      expect(parseRecallToolArguments({ id }).valid, id).toBe(false);
    }
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
      detailRefs: true,
      recordTransfers: false,
      signal,
    });
  });

  test("does not return results after cancellation settles an accepted lookup", async () => {
    const search = {} as unknown as LoreConfig["search"];
    const cfg = {
      knowledge: { enabled: false },
      search,
    } as unknown as LoreConfig;
    const controller = new AbortController();
    let resolveRun: ((value: string) => void) | undefined;
    const run = vi.fn(
      (_input: RecallInput) =>
        new Promise<string>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const execute = createRecallToolExecutor(run, () => cfg);

    const pending = execute(
      { query: "private query" },
      { projectPath: "/project", signal: controller.signal },
    );
    controller.abort();
    resolveRun?.("private recall results");

    await expect(pending).resolves.toBe("Recall was cancelled.");
    expect(run).toHaveBeenCalledOnce();
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
