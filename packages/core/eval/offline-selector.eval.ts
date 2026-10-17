import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import { searchRecall } from "../src/recall";

// Synthetic examples only. Labels describe the next coding action, not keyword
// overlap. Jev was checked against these labels offline; this eval never calls it.
const cases = [
  {
    id: "search-delete",
    split: "train",
    task: "Deleting a note leaves it visible in local search. The delete handler has just been opened.",
    candidates: [
      {
        title: "Search-index transaction",
        content:
          "Delete the note's search-index row in the same transaction as the note.",
        needed: true,
      },
      {
        title: "Old index cleanup",
        content:
          "Before version 3, index rows were deleted asynchronously. Version 3 replaced this mechanism; do not use the old queue.",
        needed: false,
      },
      {
        title: "Theme palette",
        content: "Use blue buttons on the settings page.",
        needed: false,
      },
      {
        title: "Markdown export",
        content: "Include frontmatter when exporting notes to Markdown.",
        needed: false,
      },
    ],
  },
  {
    id: "json-errors",
    split: "train",
    task: "A CLI parser fails on malformed JSON and its error reveals the input, which may contain a secret.",
    candidates: [
      {
        title: "Fixed parser errors",
        content:
          "Return a fixed parse error without including the submitted JSON or the original parser exception.",
        needed: true,
      },
      {
        title: "Verbose debug logs",
        content:
          "Log the full malformed JSON on every parse failure so debugging is easier.",
        needed: false,
      },
      {
        title: "Terminal colors",
        content: "Use yellow for warning banners.",
        needed: false,
      },
    ],
  },
  {
    id: "resource-ownership",
    split: "train",
    task: "A resource endpoint looks up a record by a client-supplied ID. A user from another project can access it.",
    candidates: [
      {
        title: "Project ownership",
        content:
          "Include the authenticated project ID in every resource lookup, alongside the record ID.",
        needed: true,
      },
      {
        title: "Opaque identifiers",
        content:
          "Use long random record IDs; do not add a project filter to the lookup.",
        needed: false,
      },
      {
        title: "HTTP retry policy",
        content: "Retry transient upstream HTTP 503 responses.",
        needed: false,
      },
    ],
  },
  {
    id: "idle-cache",
    split: "holdout",
    task: "After an idle resume, a coding agent loses a previously injected knowledge entry despite an unchanged cache prefix.",
    candidates: [
      {
        title: "Stable knowledge pin",
        content:
          "Keep the pinned knowledge prefix byte-identical during a session; deliver changing context via durable tail deltas.",
        needed: true,
      },
      {
        title: "Regenerate all prompts",
        content:
          "Rewrite the system prefix on every resume to ensure the latest knowledge is included.",
        needed: false,
      },
      {
        title: "Theme palette",
        content: "Use blue buttons in settings.",
        needed: false,
      },
    ],
  },
  {
    id: "deployed-chart",
    split: "holdout",
    task: "The live site shows the old chart labels after a source edit, despite a successful deploy.",
    candidates: [
      {
        title: "Served assets",
        content:
          "Verify the bundled JavaScript assets or rendered chart; the HTML shell alone does not contain the chart copy.",
        needed: true,
      },
      {
        title: "Code comments",
        content:
          "Edit comments beside the chart component to mention the new wording.",
        needed: false,
      },
      {
        title: "Database vacuum",
        content: "Run VACUUM on the local SQLite database after deployments.",
        needed: false,
      },
    ],
  },
] as const;

describe("offline injection selector baseline (synthetic, no Jev at runtime)", () => {
  beforeEach(() => {
    db().exec("DELETE FROM knowledge");
    db().exec("DELETE FROM distillations");
    db().exec("DELETE FROM temporal_messages");
  });

  test.each(cases)("$split: $id", async (scenario) => {
    const projectPath = `/test/offline-selector/${scenario.id}`;
    const entryIds = new Map<string, string>(
      scenario.candidates.map((candidate) => [
        candidate.title,
        ltm.create({
          projectPath,
          category: "gotcha",
          scope: "project",
          title: candidate.title,
          content: candidate.content,
          confidence: 0.8,
        }),
      ]),
    );
    const idFor = (title: string): string => {
      const id = entryIds.get(title);
      if (!id) throw new Error("Missing seeded entry");
      return id;
    };
    const seededIds = new Set(entryIds.values());
    const available = vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
    try {
      const overflow: ltm.KnowledgeEntry[] = [];
      const start = performance.now();
      const selected = await ltm.forSession(projectPath, undefined, 70, {
        contextHint: scenario.task,
        deferEffects: true,
        overflowSink: overflow,
      });
      const elapsedMs = performance.now() - start;
      const selectedIds = new Set(selected.map((entry) => entry.id));
      const overflowIds = new Set(overflow.map((entry) => entry.id));
      const needed = scenario.candidates.filter(
        (candidate) => candidate.needed,
      );
      const notNeeded = scenario.candidates.filter(
        (candidate) => !candidate.needed,
      );
      const missedCritical = needed.filter(
        (candidate) => !selectedIds.has(idFor(candidate.title)),
      ).length;
      const irrelevantInjected = notNeeded.filter((candidate) =>
        selectedIds.has(idFor(candidate.title)),
      ).length;
      const presentInOverflow = needed.filter((candidate) =>
        overflowIds.has(idFor(candidate.title)),
      ).length;
      const recallStart = performance.now();
      const recallResults = await searchRecall({
        query: scenario.task,
        projectPath,
        scope: "project",
      });
      const recallElapsedMs = performance.now() - recallStart;
      const recallRanks = needed.map((candidate) => {
        const rank = recallResults.findIndex(
          (result) =>
            result.item.source === "knowledge" &&
            result.item.item.logical_id === idFor(candidate.title),
        );
        return rank < 0 ? null : rank + 1;
      });

      // The measured selection is the real forSession path, not a reimplementation
      // of its BM25 scoring, project filtering, or token-budget packing.
      expect(needed.length).toBeGreaterThan(0);
      expect(selectedIds.size).toBe(selected.length);
      expect(
        [...selectedIds, ...overflowIds].every((id) => seededIds.has(id)),
      ).toBe(true);
      console.info(
        JSON.stringify({
          scenario: scenario.id,
          split: scenario.split,
          needed: needed.length,
          selected: selected.length,
          missedCritical,
          irrelevantInjected,
          presentInOverflow,
          recallRanks,
          elapsedMs: Math.round(elapsedMs),
          recallElapsedMs: Math.round(recallElapsedMs),
        }),
      );
    } finally {
      available.mockRestore();
    }
  });
});
