import { afterEach, expect, test, vi } from "vitest";
import { db } from "../src/db";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import { formatKnowledge } from "../src/prompt";
import { estimateTokens } from "../src/tokenize";

afterEach(() => vi.restoreAllMocks());

test("a tight selection budget still sends its chosen knowledge to the prompt", async () => {
  const projectPath = "/test/ltm/knowledge-render-budget";
  const sessionID = "knowledge-render-budget-session";
  const long = {
    title: "Long connector rule",
    content:
      "Validate request bodies before routing any connector call. ".repeat(14),
  };
  const short = {
    title: "Short connector rule",
    content: "Reject malformed connector requests.",
  };
  const longId = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    ...long,
  });
  const shortId = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    ...short,
  });
  const longCost = estimateTokens(long.title + long.content) + 10;
  const shortCost = estimateTokens(short.title + short.content) + 10;
  expect(longCost - shortCost).toBeGreaterThan(47);
  const budget = 15 + longCost;

  vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
  vi.spyOn(embedding, "embed").mockResolvedValue([new Float32Array([1, 0])]);
  vi.spyOn(embedding, "vectorSearch").mockResolvedValue([
    { id: longId, similarity: 0.92 },
    { id: shortId, similarity: 0.6 },
  ]);

  const selected = await ltm.forSession(projectPath, sessionID, budget, {
    contextHint: "connectors",
    excludeCategories: ["preference"],
  });
  const renderedIds: string[] = [];
  const formatted = formatKnowledge(
    selected.map(({ id, category, title, content }) => ({
      id,
      category,
      title,
      content,
    })),
    budget,
    renderedIds,
  );

  expect(selected.map(({ id }) => id)).toEqual([shortId]);
  expect(renderedIds).toEqual(selected.map(({ id }) => id));
  expect(formatted).toContain(short.title);
  const injected = db()
    .query(
      "SELECT logical_id FROM knowledge_session_injections WHERE session_id = ?",
    )
    .all(sessionID) as Array<{ logical_id: string }>;
  expect(injected.map((row) => row.logical_id)).toEqual(renderedIds);
});

test("an ID prefix that does not fit leaves the entry available for recall", async () => {
  const projectPath = "/test/ltm/knowledge-render-id-budget";
  const title = "Connector guard";
  const content = "Validate connector requests before dispatch.";
  const id = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    title,
    content,
  });
  // The heading and text fit; the rendered ID prefix does not.
  const budget = 50 + estimateTokens(title + content) + 10;

  vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
  vi.spyOn(embedding, "embed").mockResolvedValue([new Float32Array([1, 0])]);
  vi.spyOn(embedding, "vectorSearch").mockResolvedValue([
    { id, similarity: 0.92 },
  ]);

  const overflow: ltm.KnowledgeEntry[] = [];
  const selected = await ltm.forSession(projectPath, undefined, budget, {
    contextHint: "connectors",
    excludeCategories: ["preference"],
    deferEffects: true,
    overflowSink: overflow,
  });
  const renderedIds: string[] = [];
  const formatted = formatKnowledge(selected, budget, renderedIds);

  expect(selected).toHaveLength(0);
  expect(renderedIds).toHaveLength(0);
  expect(formatted).toBe("");
  expect(overflow.map((entry) => entry.id)).toEqual([id]);
});
