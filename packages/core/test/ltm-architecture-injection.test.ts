import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { config } from "../src/config";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import {
  formatKnowledge,
  KNOWLEDGE_HEADER_OVERHEAD_TOKENS,
  knowledgeEntryTokenCost,
} from "../src/prompt";

const projectPath = "/test/ltm/architecture-injection";
const originalMode = config().knowledge.architectureInjection;

beforeEach(() => {
  // Compare architecture allocation before the independent task filter.
  config().knowledge.taskFilter = false;
});

afterEach(() => {
  config().knowledge.architectureInjection = originalMode;
  vi.restoreAllMocks();
});

test("the ranked default admits relevant gotchas before reserved architecture", async () => {
  const architecture = {
    title: "Component map",
    content: "The gateway has a routing layer.",
  };
  const gotcha = {
    title: "Gateway gateway gateway rejection",
    content:
      "Gateway requests reject malformed gateway input before reading a body.",
  };
  const archId = ltm.create({
    projectPath,
    scope: "project",
    category: "architecture",
    ...architecture,
  });
  const gotchaId = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    ...gotcha,
  });
  const archCost = knowledgeEntryTokenCost({ id: archId, ...architecture });
  const gotchaCost = knowledgeEntryTokenCost({ id: gotchaId, ...gotcha });
  const budget =
    KNOWLEDGE_HEADER_OVERHEAD_TOKENS + Math.max(archCost, gotchaCost);
  const unavailable = vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
  const select = async () => {
    const entries = await ltm.forSession(projectPath, undefined, budget, {
      contextHint: "gateway gateway request rejection",
      excludeCategories: ["preference"],
      deferEffects: true,
    });
    const renderedIds: string[] = [];
    formatKnowledge(entries, budget, renderedIds);
    expect(renderedIds).toEqual(entries.map((entry) => entry.id));
    return renderedIds;
  };
  try {
    expect(config().knowledge.architectureInjection).toBe("ranked");
    expect(await select()).toEqual([gotchaId]);

    config().knowledge.architectureInjection = "reserved";
    expect(await select()).toEqual([archId]);

    config().knowledge.architectureInjection = "ranked";
    expect(await select()).toEqual([gotchaId]);

    // Ranking never hides architecture from explicit reads or recall.
    // The caller's category exclusion array remains unchanged.
    const excluded: ("preference" | "architecture")[] = ["preference"];
    expect(
      (
        await ltm.forSession(projectPath, undefined, budget, {
          categories: ["architecture"],
          excludeCategories: excluded,
          deferEffects: true,
        })
      ).map((entry) => entry.id),
    ).toEqual([archId]);
    expect(excluded).toEqual(["preference"]);
    expect(
      ltm.search({ query: "component map", projectPath }).map((e) => e.id),
    ).toContain(archId);
  } finally {
    unavailable.mockRestore();
  }
});

test("ranked and reserved compete differently when vectors are available", async () => {
  const architecture = {
    title: "Gateway routing map",
    content: "Gateway requests flow through the router",
  };
  const gotcha = {
    title: "Gateway request guard",
    content: "Gateway requests must validate input before reading the body",
  };
  const archId = ltm.create({
    projectPath: `${projectPath}/vector`,
    scope: "project",
    category: "architecture",
    ...architecture,
  });
  const gotchaId = ltm.create({
    projectPath: `${projectPath}/vector`,
    scope: "project",
    category: "gotcha",
    ...gotcha,
  });
  const budget =
    KNOWLEDGE_HEADER_OVERHEAD_TOKENS +
    Math.max(
      knowledgeEntryTokenCost({ id: archId, ...architecture }),
      knowledgeEntryTokenCost({ id: gotchaId, ...gotcha }),
    );
  vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
  vi.spyOn(embedding, "embed").mockResolvedValue([new Float32Array([1, 0])]);
  const vectorSearch = vi.spyOn(embedding, "vectorSearch").mockResolvedValue([
    { id: archId, similarity: 0.6 },
    { id: gotchaId, similarity: 0.92 },
  ]);
  const select = async () => {
    const entries = await ltm.forSession(
      `${projectPath}/vector`,
      undefined,
      budget,
      {
        contextHint: "gateway request rejection",
        excludeCategories: ["preference"],
        deferEffects: true,
      },
    );
    const renderedIds: string[] = [];
    formatKnowledge(entries, budget, renderedIds);
    expect(renderedIds).toEqual(entries.map((entry) => entry.id));
    return renderedIds;
  };

  expect(await select()).toEqual([gotchaId]);
  config().knowledge.architectureInjection = "reserved";
  expect(await select()).toEqual([archId]);
  expect(vectorSearch).toHaveBeenCalledWith(
    expect.any(Float32Array),
    50,
    ["preference"],
    "knowledge",
    expect.any(Object),
  );
});

test("an invalid runtime mode never silently becomes ranked", async () => {
  const knowledge = config().knowledge as { architectureInjection: string };
  knowledge.architectureInjection = "unknown";
  await expect(
    ltm.forSession(projectPath, undefined, 200, { deferEffects: true }),
  ).rejects.toThrow("Invalid architecture injection mode");
});
