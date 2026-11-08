import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import * as core from "@loreai/core";
import { executeRecall, RECALL_TOOL_NAME } from "../src/recall";
import type { GatewayToolUseBlock } from "../src/translate/types";

function recallBlock(input: Record<string, unknown>): GatewayToolUseBlock {
  return {
    type: "tool_use",
    id: "recall-detail-scope-test",
    name: RECALL_TOOL_NAME,
    input,
  };
}

test("id-only recall keeps the scope bound into an opaque detail ref", async () => {
  const projectPath = `/test/recall-detail-scope/${randomUUID()}`;
  const sessionID = randomUUID();
  const marker = `recall-detail-scope-body-${randomUUID()}`;
  const title = `recall-detail-scope-title-${randomUUID()}`;
  core.ltm.create({
    projectPath,
    scope: "project",
    crossProject: false,
    category: "gotcha",
    title,
    content: Array.from({ length: 100 }, () => `${marker}.`).join(" "),
  });

  const preview = await executeRecall(
    recallBlock({ query: title, scope: "knowledge" }),
    projectPath,
    sessionID,
  );
  const detailRef = preview.result.match(/detail ref: `([^`]+)`/)?.[1];

  expect(detailRef).toMatch(/^r:[0-9a-f-]{36}$/);

  const detail = await executeRecall(
    recallBlock({ id: detailRef }),
    projectPath,
    sessionID,
  );

  expect(detail.result).toContain(marker);
  expect(detail.input.scope).toBeUndefined();

  const batch = await executeRecall(
    recallBlock({ ids: [detailRef] }),
    projectPath,
    sessionID,
  );
  expect(batch.result).toContain(marker);
  expect(batch.input.scope).toBeUndefined();

  const wrongScope = await executeRecall(
    recallBlock({ ids: [detailRef], scope: "all" }),
    projectPath,
    sessionID,
  );
  expect(wrongScope.result).not.toContain(marker);
});
