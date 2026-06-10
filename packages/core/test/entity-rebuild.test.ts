import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import { rebuildEntitiesFromHistory } from "../src/entity-rebuild";
import type { LLMClient } from "../src/types";

const PROJECT = "/test/entity-rebuild/project";

function cleanup() {
  const d = db();
  d.exec("DELETE FROM entity_relations");
  d.exec("DELETE FROM knowledge_entity_refs");
  d.exec("DELETE FROM entity_aliases");
  d.exec("DELETE FROM entities");
  d.exec("DELETE FROM dedup_feedback");
  const pid = ensureProject(PROJECT);
  d.query("DELETE FROM distillations WHERE project_id = ?").run(pid);
}

function insertDistillation(observations: string): void {
  const pid = ensureProject(PROJECT);
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      pid,
      "session-1",
      "",
      "[]",
      observations,
      "[]",
      0,
      Math.ceil(observations.length / 3),
      0,
      Date.now(),
    );
}

/** LLMClient stub that returns a fixed extraction payload for every call. */
function stubLLM(payload: unknown): LLMClient {
  return {
    prompt: async () => JSON.stringify(payload),
  };
}

describe("entity-rebuild", () => {
  beforeEach(cleanup);

  test("returns early with zero counts when there is no history", async () => {
    const result = await rebuildEntitiesFromHistory({
      llm: stubLLM({ entities: [], relations: [] }),
      projectPath: PROJECT,
    });
    expect(result.scannedDistillations).toBe(0);
    expect(result.batches).toBe(0);
    expect(result.personsCreated).toBe(0);
  });

  test("dry run reports candidates without writing entities", async () => {
    insertDistillation("Worked with Carol on the deploy pipeline.");
    const llm = stubLLM({
      entities: [
        { type: "person", canonical_name: "Carol" },
        { type: "tool", canonical_name: "Vercel" },
      ],
      relations: [],
    });

    const result = await rebuildEntitiesFromHistory({
      llm,
      projectPath: PROJECT,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.scannedDistillations).toBe(1);
    expect(result.batches).toBe(1);
    expect(result.candidates?.map((c) => c.name).sort()).toEqual([
      "Carol",
      "Vercel",
    ]);
    // Nothing written on a dry run.
    expect(entities.listAll().length).toBe(0);
  });

  test("apply run creates detected entities from history", async () => {
    insertDistillation("Carol reviewed the PR. We deployed via Vercel.");
    const llm = stubLLM({
      entities: [
        {
          type: "person",
          canonical_name: "Carol",
          aliases: [{ type: "github", value: "carol-gh" }],
        },
        { type: "tool", canonical_name: "Vercel" },
      ],
      relations: [],
    });

    const result = await rebuildEntitiesFromHistory({
      llm,
      projectPath: PROJECT,
      dryRun: false,
    });

    expect(result.personsCreated).toBe(1);
    expect(result.otherCreated).toBe(1); // the tool

    const all = entities.listAll();
    const names = all.map((e) => e.canonical_name).sort();
    expect(names).toContain("Carol");
    expect(names).toContain("Vercel");

    const carol = all.find((e) => e.canonical_name === "Carol");
    expect(carol?.entity_type).toBe("person");
    expect(carol?.aliases.map((a) => a.alias_value)).toContain("carol-gh");
  });

  test("dedupes candidate names in the dry-run preview", async () => {
    insertDistillation("Carol again. And Carol once more.");
    const llm = stubLLM({
      entities: [
        { type: "person", canonical_name: "Carol" },
        { type: "person", canonical_name: "carol" },
      ],
      relations: [],
    });

    const result = await rebuildEntitiesFromHistory({
      llm,
      projectPath: PROJECT,
      dryRun: true,
    });

    expect(result.candidates?.length).toBe(1);
  });

  test("creates relations between detected entities", async () => {
    insertDistillation("Carol and Dave pair-programmed the refactor.");
    const llm = stubLLM({
      entities: [
        { type: "person", canonical_name: "Carol" },
        { type: "person", canonical_name: "Dave" },
      ],
      relations: [
        {
          entity_a: "Carol",
          entity_b: "Dave",
          relation: "colleague",
          metadata: { context: "pair programming" },
        },
      ],
    });

    const result = await rebuildEntitiesFromHistory({
      llm,
      projectPath: PROJECT,
      dryRun: false,
    });

    expect(result.personsCreated).toBe(2);
    expect(result.relationsCreated).toBe(1);

    // Verify the relation was actually stored.
    const carol = entities.listAll().find((e) => e.canonical_name === "Carol");
    expect(carol).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: carol is asserted above
    const relations = entities.relationsFor(carol!.id);
    expect(relations.length).toBe(1);
    expect(relations[0].relation).toBe("colleague");
  });

  test("handles LLM returning null gracefully (skips batch)", async () => {
    insertDistillation("Some session content.");
    const llm: LLMClient = { prompt: async () => null };

    const result = await rebuildEntitiesFromHistory({
      llm,
      projectPath: PROJECT,
      dryRun: false,
    });

    expect(result.detected).toBe(0);
    expect(result.personsCreated).toBe(0);
    expect(entities.listAll().length).toBe(0);
  });

  test("handles LLM returning malformed JSON gracefully", async () => {
    insertDistillation("Some other content.");
    const llm: LLMClient = { prompt: async () => "this is not json {{{" };

    const result = await rebuildEntitiesFromHistory({
      llm,
      projectPath: PROJECT,
      dryRun: false,
    });

    // parseResponse returns empty arrays for malformed JSON
    expect(result.detected).toBe(0);
    expect(result.personsCreated).toBe(0);
  });

  test("handles LLM throwing an error gracefully (skips batch)", async () => {
    insertDistillation("Content that causes an error.");
    const llm: LLMClient = {
      prompt: async () => {
        throw new Error("upstream connection failed");
      },
    };

    const result = await rebuildEntitiesFromHistory({
      llm,
      projectPath: PROJECT,
      dryRun: false,
    });

    expect(result.detected).toBe(0);
    expect(result.personsCreated).toBe(0);
  });
});
