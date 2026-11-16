// Reproducible evidence for /docs/example/. This deliberately uses reviewed,
// manually-created knowledge: it does not simulate successful LLM extraction.
import { expect, test, vi } from "vitest";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import * as temporal from "../src/temporal";
import { searchRecall } from "../src/recall";

test("website example: a later session recovers a corrected webhook rule and its earlier conversation", async () => {
  const projectPath = "/test/website-workflow";
  const sessionID = "webhook-first-session";
  const source =
    "Webhook deliveries may repeat. Check the event ID before updating an order. Reuse the duplicate-event guard. The test server is on port 4330 today.";
  temporal.store({
    projectPath,
    info: {
      id: "website-decision",
      sessionID,
      role: "user",
      time: { created: Date.now() },
    },
    parts: [
      {
        id: "website-decision-text",
        sessionID,
        messageID: "website-decision",
        type: "text",
        text: source,
      },
    ],
  });
  const id = ltm.create({
    projectPath,
    scope: "project",
    category: "decision",
    session: sessionID,
    title: "Webhook duplicate event guard",
    content: "Check the event ID before updating an order.",
  });
  // A person corrects the incomplete rule before relying on it later.
  const corrected =
    "Check the event ID before updating an order. Reuse the duplicate-event guard for repeated webhook deliveries.";
  ltm.update(id, { content: corrected });
  const history = ltm.versionHistory(id);
  expect(history.map((v) => v.content)).toEqual([
    "Check the event ID before updating an order.",
    corrected,
  ]);
  expect(history.at(-1)?.is_current).toBe(1);
  const available = vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
  try {
    const results = await searchRecall({
      projectPath,
      sessionID: "webhook-next-session",
      scope: "project",
      query: "webhook duplicate event guard",
    });
    const knowledge = results.flatMap((r) =>
      r.item.source === "knowledge" ? [r.item.item.content] : [],
    );
    expect(knowledge).toContain(corrected);
    expect(knowledge.join(" ")).not.toContain("4330");
    const conversation = results.flatMap((r) =>
      r.item.source === "temporal" ? [r.item.item.content] : [],
    );
    expect(conversation).toContain(source);
  } finally {
    available.mockRestore();
  }
});
