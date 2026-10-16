import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, ltm, temporal } from "../src/index";
import type { KnowledgeEntry } from "../src/ltm";
import * as prompt from "../src/prompt";
import * as embedding from "../src/embedding";
import * as references from "../src/references";

const PROJECT = "/test/specific-knowledge-evidence";

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  // Rank eligible evidence without applying the separate admission policy.
  config().knowledge.taskFilter = false;
});

describe("specific task evidence in passive knowledge ranking", () => {
  it.each(["knowledge", "temporal"] as const)(
    "bounds reference parsing for oversized %s even with a header-only output budget",
    async (source) => {
      vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
      const projectPath = `${PROJECT}/oversized-${source}`;
      const content = `In src/ledger.ts, \`settleBatch\` preserves the contract. ${"Bounded input matters. ".repeat(1_000)}`;
      if (source === "knowledge") {
        const id = ltm.create({
          projectPath,
          scope: "project",
          category: "gotcha",
          title: "Named settlement rule",
          content,
        });
        expect(ltm.get(id)?.content).toBe(content);
      } else {
        expect(
          temporal.store({
            projectPath,
            info: {
              id: "oversized-source",
              sessionID: "source-session",
              role: "user",
              time: { created: Date.now() },
            },
            parts: [{ type: "text", text: content }],
          }),
        ).toBeDefined();
      }
      const extract = vi.spyOn(references, "extractReferences");
      expect(
        await ltm.forSession(
          projectPath,
          "bounded-reference-work",
          prompt.KNOWLEDGE_HEADER_OVERHEAD_TOKENS,
          {
            contextHint: "Repair `settleBatch` in src/ledger.ts.",
            includeContextSources: source === "temporal" ? ["temporal"] : [],
            deferEffects: true,
          },
        ),
      ).toEqual([]);
      const inputs = extract.mock.calls.map(([text]) => text);
      expect(inputs.length).toBeGreaterThan(1);
      expect(
        Math.max(...inputs.map((text) => text.length)),
      ).toBeLessThanOrEqual(4_096);
    },
  );

  it("bounds aggregate reference work and falls back to hybrid rank without removing candidates", async () => {
    vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
    vi.spyOn(embedding, "embed").mockResolvedValue([new Float32Array([1, 0])]);
    const projectPath = `${PROJECT}/total-reference-work`;
    const weakId = ltm.create({
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Freeze coordination",
      content: `${"freeze ".repeat(25)}Keep the normal hybrid winner.`,
    });
    const fillerIds = Array.from({ length: 40 }, (_, index) =>
      ltm.create({
        projectPath,
        scope: "project",
        category: "gotcha",
        title: `Stored detail ${index}`,
        content: "Unrelated stored detail. ".repeat(200),
      }),
    );
    const exactId = ltm.create({
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Settlement invariant",
      content: "For src/ledger.ts, preserve settlement.",
    });
    vi.spyOn(embedding, "vectorSearch").mockResolvedValue([
      { id: weakId, similarity: 1 },
      { id: exactId, similarity: 0.4 },
      ...fillerIds.map((id) => ({ id, similarity: 0.6 })),
    ]);
    const extract = vi.spyOn(references, "extractReferences");
    const selected = await ltm.forSession(
      projectPath,
      "total-reference-work",
      800,
      {
        contextHint:
          "Fix freeze behavior in src/ledger.ts. Investigate freeze ordering and freeze state.",
        includeContextSources: [],
        deferEffects: true,
      },
    );
    const work = extract.mock.calls.reduce(
      (sum, [text]) => sum + text.length,
      0,
    );
    expect(work).toBeLessThanOrEqual(65_536);
    expect(extract.mock.calls[1][0]).toContain("Settlement invariant");
    expect(selected[0].id).toBe(weakId);
    expect(selected.map((entry) => entry.id)).toContain(exactId);
  });

  it("bounds candidate scans while retaining all budget-omitted eligible entries", async () => {
    vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
    const projectPath = `${PROJECT}/reference-candidate-count`;
    const ids = Array.from({ length: 129 }, (_, index) =>
      ltm.create({
        projectPath,
        scope: "project",
        category: "gotcha",
        title: `Freeze contract ${index}`,
        content: "freeze",
      }),
    );
    const extract = vi.spyOn(references, "extractReferences");
    const overflow: KnowledgeEntry[] = [];
    expect(
      await ltm.forSession(
        projectPath,
        "reference-candidate-count",
        prompt.KNOWLEDGE_HEADER_OVERHEAD_TOKENS,
        {
          contextHint: "Fix freeze in src/ledger.ts.",
          includeContextSources: [],
          overflowSink: overflow,
          deferEffects: true,
        },
      ),
    ).toEqual([]);
    expect(extract.mock.calls.length).toBeLessThanOrEqual(129);
    expect(new Set(overflow.map((entry) => entry.id))).toEqual(new Set(ids));
  });

  it("prefers the exact named file over a repeated generic keyword without hiding either match", async () => {
    vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
    const weakId = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Freeze coordination",
      content: `${"freeze ".repeat(25)}Keep unrelated cache behavior consistent.`,
    });
    const strongId = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Settlement invariant",
      content:
        "For src/ledger.ts, preserve the established UTC settlement boundary.",
    });
    const contextHint =
      "Fix freeze behavior in src/ledger.ts. Investigate freeze ordering and freeze state.";
    const weak = ltm.get(weakId)!;
    const strong = ltm.get(strongId)!;
    const budget =
      prompt.KNOWLEDGE_HEADER_OVERHEAD_TOKENS +
      Math.max(
        prompt.knowledgeEntryTokenCost(weak),
        prompt.knowledgeEntryTokenCost(strong),
      );
    const tight = await ltm.forSession(PROJECT, "file-evidence", budget, {
      contextHint,
      deferEffects: true,
    });
    expect(tight.map((entry) => entry.id)).toEqual([strongId]);
    const generous = await ltm.forSession(PROJECT, "file-evidence", 800, {
      contextHint,
      deferEffects: true,
    });
    expect(generous.map((entry) => entry.id)).toEqual([strongId, weakId]);
    expect(ltm.get(weakId)?.content).toBe(weak.content);
  });

  it("distinguishes a named symbol in the same file while retaining an implicit semantic match", async () => {
    const projectPath = `${PROJECT}/symbol`;
    vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
    vi.spyOn(embedding, "embed").mockResolvedValue([new Float32Array([1, 0])]);
    const otherId = ltm.create({
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Repair settleBatching",
      content: "In src/ledger.ts, `settleBatching` handles pending drafts.",
    });
    const targetId = ltm.create({
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Settlement finalizer",
      content:
        "In src/ledger.ts, `settleBatch` preserves the exact UTC boundary.",
    });
    const implicitId = ltm.create({
      projectPath,
      scope: "project",
      category: "decision",
      title: "Inherited convention",
      content: "The internal rollover occurs on Wednesday at 04:00 UTC.",
    });
    vi.spyOn(embedding, "vectorSearch").mockResolvedValue([
      { id: otherId, similarity: 0.95 },
      { id: targetId, similarity: 0.4 },
      { id: implicitId, similarity: 0.65 },
    ]);
    const selected = await ltm.forSession(projectPath, "symbol-evidence", 800, {
      contextHint: "Repair `settleBatch` in src/ledger.ts.",
      deferEffects: true,
    });
    expect(selected.map((entry) => entry.id)).toEqual([
      targetId,
      otherId,
      implicitId,
    ]);
  });
});
