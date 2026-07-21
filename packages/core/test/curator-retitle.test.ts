import { describe, expect, test } from "vitest";
import { applyOps } from "../src/curator";
import * as ltm from "../src/ltm";

// D1b: the curator `update` op can carry an optional `title`. Verify it threads
// through applyOps into ltm.update, that a colliding re-title is dropped (no
// duplicate) even via the curator path, and that changedEntries reports the
// effective (post-guard) title.

const PROJECT = "/tmp/lore-curator-retitle/project";

describe("curator applyOps re-title (D1b)", () => {
  test("update op with title re-titles the surviving entry", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Auth token refresh race",
      content: "original",
    });

    const result = applyOps(
      [
        {
          op: "update",
          id,
          title: "Auth + session token refresh race across tabs",
          content: "broadened after merge",
        },
      ],
      { projectPath: PROJECT, sessionID: "sess-retitle" },
    );

    expect(result.updated).toBe(1);
    expect(ltm.getByLogical(ltm.logicalIdOf(id))?.title).toBe(
      "Auth + session token refresh race across tabs",
    );
    // changedEntries reflects the new (effective) title.
    expect(result.changedEntries[0]).toMatchObject({
      op: "updated",
      title: "Auth + session token refresh race across tabs",
    });
  });

  test("a colliding re-title via the curator is dropped — no duplicate title", () => {
    const a = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Kafka consumer lag spike",
      content: "a",
    });
    ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Elasticsearch shard rebalance stall",
      content: "b",
    });

    applyOps(
      [
        {
          op: "update",
          id: a,
          title: "Elasticsearch shard rebalance stall",
          content: "a2",
        },
      ],
      { projectPath: PROJECT, sessionID: "sess-collide" },
    );

    // A keeps its own title; content update still applied.
    expect(ltm.getByLogical(ltm.logicalIdOf(a))?.title).toBe(
      "Kafka consumer lag spike",
    );
    expect(ltm.getByLogical(ltm.logicalIdOf(a))?.content).toBe("a2");
    // Only ONE live entry owns the collided title.
    const collided = ltm
      .search({ query: "Elasticsearch shard rebalance", projectPath: PROJECT })
      .filter(
        (e) => e.title.toLowerCase() === "elasticsearch shard rebalance stall",
      );
    expect(collided).toHaveLength(1);
  });

  test("update op without a title leaves the title unchanged (backward compatible)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Unchanged title stays",
      content: "v1",
    });
    applyOps([{ op: "update", id, content: "v2" }], {
      projectPath: PROJECT,
      sessionID: "sess-notitle",
    });
    expect(ltm.getByLogical(ltm.logicalIdOf(id))?.title).toBe(
      "Unchanged title stays",
    );
    expect(ltm.getByLogical(ltm.logicalIdOf(id))?.content).toBe("v2");
  });
});
