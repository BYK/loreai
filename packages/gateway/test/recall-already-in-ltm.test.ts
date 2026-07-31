/**
 * Gateway-level test for `alreadyInLtmIds` snapshot reuse across the
 * non-streaming recall loop (Seer 15623149/1).
 *
 * The pipeline's non-streaming recall loop calls `executeRecall` once per
 * recall iteration (up to MAX_RECALL_DEPTH times). The `alreadyInLtmIds`
 * Set is captured once before the loop (from `stableLtmText` +
 * `pendingKnowledgeDelta`) and MUST be the same Set passed to every
 * `executeRecall` invocation — the values don't change between iterations.
 *
 * This test pins that invariant independently of the upstream pipeline by
 * directly invoking `executeRecall` (the loop's leaf call) and asserting
 * Set identity across two consecutive calls in the same request shape.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as core from "@loreai/core";
import { executeRecall, RECALL_TOOL_NAME } from "../src/recall";
import type { GatewayToolUseBlock } from "../src/translate/types";

describe("executeRecall — alreadyInLtmIds identity across calls", () => {
  let captured: Array<ReadonlySet<string> | undefined>;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured = [];
    spy = vi
      .spyOn(core, "runRecall")
      .mockImplementation(
        async (input: { alreadyInLtmIds?: ReadonlySet<string> }) => {
          captured.push(input.alreadyInLtmIds);
          return "OK";
        },
      );
  });

  test("the same Set instance is forwarded verbatim to runRecall", async () => {
    const ids = new Set(["019f0000-0000-7000-8000-000000000001"]);

    const block: GatewayToolUseBlock = {
      type: "tool_use",
      id: "toolu_test",
      name: RECALL_TOOL_NAME,
      input: { query: "adm auth.json keys", scope: "all" },
    };

    // First call — executeRecall forwards the set identity.
    await executeRecall(block, "/tmp/proj", "sess", undefined, ids);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(ids); // identity, not deep-equal

    // Second call with the same set also gets the same identity — simulates
    // the non-streaming recall loop iterating across MAX_RECALL_DEPTH.
    await executeRecall(block, "/tmp/proj", "sess", undefined, ids);
    expect(captured).toHaveLength(2);
    expect(captured[1]).toBe(ids);

    spy.mockRestore();
  });

  test("undefined alreadyInLtmIds passes undefined (backwards compat)", async () => {
    const block: GatewayToolUseBlock = {
      type: "tool_use",
      id: "toolu_test",
      name: RECALL_TOOL_NAME,
      input: { query: "adm auth.json keys", scope: "all" },
    };

    await executeRecall(block, "/tmp/proj", "sess");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeUndefined();

    spy.mockRestore();
  });
});
