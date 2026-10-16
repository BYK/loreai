import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import {
  KNOWLEDGE_HEADER_OVERHEAD_TOKENS,
  knowledgeEntryTokenCost,
} from "../src/prompt";
import { runRecall } from "../src/recall";
import { db, ensureProject } from "../src/db";
import { uuidv7 } from "uuidv7";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLoreFile, LORE_FILE } from "../src/agents-file";

const PROJECT = "/test/task-admission-filter";
const originalFilter = config().knowledge.taskFilter;

afterEach(() => {
  config().knowledge.taskFilter = originalFilter;
  vi.restoreAllMocks();
});

function vectors(ids: readonly string[]) {
  vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
  vi.spyOn(embedding, "embed").mockResolvedValue([new Float32Array([1, 0])]);
  vi.spyOn(embedding, "vectorSearch").mockResolvedValue(
    ids.map((id, index) => ({ id, similarity: 1 - index * 0.1 })),
  );
}

describe("task-filtered passive knowledge", () => {
  it.each(["Security", "Operations", "Mixed Case"])(
    "preserves imported %s facts alongside normal filtered selection",
    async (heading) => {
      const projectPath = mkdtempSync(join(tmpdir(), "lore-task-category-"));
      try {
        writeFileSync(
          join(projectPath, LORE_FILE),
          `## Long-term Knowledge\n\n### ${heading}\n\n<!-- lore:${uuidv7()} -->\n* **Audit boundary**: Keep auditors read access when rotating labels.\n`,
        );
        importLoreFile(projectPath);
        const imported = ltm
          .forProject(projectPath)
          .find((entry) => entry.title === "Audit boundary")!;
        expect(imported.category).toBe(heading.toLowerCase());
        const omitted = ltm.create({
          projectPath,
          scope: "project",
          category: "decision",
          title: "Ledger topology",
          content: "Ledger batches keep the original topology.",
        });
        vectors([imported.id, omitted]);
        config().knowledge.taskFilter = true;
        const selected = await ltm.forSession(
          projectPath,
          "custom-category",
          800,
          {
            contextHint: "Repair ledger batching.",
            includeContextSources: [],
            deferEffects: true,
          },
        );
        expect(selected.map((entry) => entry.id)).toEqual([imported.id]);
      } finally {
        rmSync(projectPath, { recursive: true, force: true });
      }
    },
  );

  it("enables the filter by default and leaves rejected facts available by full ID", async () => {
    const projectPath = `${PROJECT}/default`;
    expect(config().knowledge.taskFilter).toBe(true);
    const decision = ltm.create({
      projectPath,
      scope: "project",
      category: "decision",
      title: "Ledger topology",
      content: "Ledger batches keep the original topology.",
    });
    const gotcha = ltm.create({
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Ledger settlement",
      content: "Commit every batch before clearing its pending records.",
    });
    vectors([decision, gotcha]);
    const selected = await ltm.forSession(projectPath, "default-filter", 800, {
      contextHint: "Repair ledger settlement.",
      deferEffects: true,
    });
    expect(selected.map((entry) => entry.id)).toEqual([gotcha]);
    expect(ltm.get(decision)?.content).toBe(
      "Ledger batches keep the original topology.",
    );
    expect(
      await runRecall({
        query: "Ledger topology",
        id: `k:${decision}`,
        projectPath,
      }),
    ).toContain("Ledger batches keep the original topology.");
  });

  it("has an explicit off switch that retains implicit semantic matches", async () => {
    const projectPath = `${PROJECT}/implicit`;
    const id = ltm.create({
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Epoch ownership",
      content: "Preserve historical ownership when settling a generation.",
    });
    vectors([id]);
    config().knowledge.taskFilter = true;
    expect(
      await ltm.forSession(projectPath, "implicit-filter", 800, {
        contextHint: "Repair ledger batching.",
        deferEffects: true,
      }),
    ).toEqual([]);
    config().knowledge.taskFilter = false;
    expect(
      (
        await ltm.forSession(projectPath, "implicit-all", 800, {
          contextHint: "Repair ledger batching.",
          deferEffects: true,
        })
      ).map((entry) => entry.id),
    ).toEqual([id]);
  });

  it("never treats distilled ranking context as an authoritative user task", async () => {
    const projectPath = `${PROJECT}/distilled-context`;
    const sessionID = "distilled-ranking-only";
    const observations =
      "Repair ledger settlement by preserving queue ordering throughout retries.";
    const id = ltm.create({
      projectPath,
      scope: "project",
      category: "decision",
      title: "Ledger topology",
      content: "Ledger batches keep the original topology.",
    });
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, '', '', ?, '[]', 0, 20, 0, ?)`,
      )
      .run(
        uuidv7(),
        ensureProject(projectPath),
        sessionID,
        observations,
        Date.now(),
      );
    vectors([id]);
    expect(
      (
        await ltm.forSession(projectPath, sessionID, 800, {
          includeContextSources: [],
          deferEffects: true,
        })
      ).map((entry) => entry.id),
    ).toEqual([id]);
    expect(
      await ltm.forSession(projectPath, sessionID, 800, {
        contextHint: observations,
        includeContextSources: [],
        deferEffects: true,
      }),
    ).toEqual([]);
  });

  it("does not refill rejected slots or turn rejected entries into overflow hints", async () => {
    const projectPath = `${PROJECT}/budget`;
    const rejected = ltm.create({
      projectPath,
      scope: "project",
      category: "pattern",
      title: "Legacy convention",
      content: "Prefer one conventional implementation.",
    });
    const retained = ltm.create({
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Compact invariant",
      content: Array.from({ length: 16 }, (_, index) => `token${index}`).join(
        " ",
      ),
    });
    vectors([rejected, retained]);
    const first = ltm.get(rejected)!;
    const second = ltm.get(retained)!;
    const budget =
      KNOWLEDGE_HEADER_OVERHEAD_TOKENS +
      Math.max(knowledgeEntryTokenCost(first), knowledgeEntryTokenCost(second));
    const overflow: ltm.KnowledgeEntry[] = [];
    config().knowledge.taskFilter = true;
    expect(
      await ltm.forSession(projectPath, "no-refill", budget, {
        contextHint: "Repair quasar batching.",
        overflowSink: overflow,
        deferEffects: true,
      }),
    ).toEqual([]);
    expect(overflow.map((entry) => entry.id)).toEqual([retained]);
  });

  it("keeps rejected packed facts out of overflow when its work limit falls back", async () => {
    const projectPath = `${PROJECT}/overflow-fallback`;
    const rejected = ltm.create({
      projectPath,
      scope: "project",
      category: "pattern",
      title: "Conventional layout",
      content: "Keep the conventional layout.",
    });
    const oversized = ltm.create({
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Opaque history",
      content: "historical ".repeat(500),
    });
    vectors([rejected, oversized]);
    const entry = ltm.get(rejected)!;
    const overflow: ltm.KnowledgeEntry[] = [];
    config().knowledge.taskFilter = true;
    expect(
      await ltm.forSession(
        projectPath,
        "overflow-fallback",
        KNOWLEDGE_HEADER_OVERHEAD_TOKENS + knowledgeEntryTokenCost(entry),
        {
          contextHint: "Repair quasar routing",
          includeContextSources: [],
          deferEffects: true,
          overflowSink: overflow,
        },
      ),
    ).toEqual([]);
    expect(overflow.map((candidate) => candidate.id)).toEqual([oversized]);
  });
});
