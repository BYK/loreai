import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { config } from "../src/config";
import { db, ensureProject } from "../src/db";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import { KNOWLEDGE_HEADER_OVERHEAD_TOKENS } from "../src/prompt";
import { runReadJob } from "../src/read-job";
import { ReadPreparationUnavailableError } from "../src/read-offload";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  vectorSearchTimeoutMs,
} from "../src/vector-pool";
import type { VectorWorkerInbound } from "../src/vector-worker-types";
import { withTenant } from "../src/tenant";

const PROJECT = "/test/ltm/candidate-hydration";
const taskFilter = config().knowledge.taskFilter;
type Read = { sql: string; rows: Record<string, unknown>[] };

beforeEach(() => {
  db().query("DELETE FROM knowledge").run();
  config().knowledge.taskFilter = false;
  vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
});

afterEach(() => {
  _setTestVectorWorkerFactory(null);
  _resetVectorPoolForTest();
  config().knowledge.taskFilter = taskFilter;
  vi.restoreAllMocks();
});

function serve(beforeHydration?: () => void | boolean): Read[] {
  const reads: Read[] = [];
  let headerReads = 0;
  class Reader extends EventEmitter {
    unref(): void {}
    terminate(): Promise<number> {
      this.emit("exit", 0);
      return Promise.resolve(0);
    }
    postMessage(message: VectorWorkerInbound): void {
      if (message.type !== "read") return;
      const { sql } = message.spec;
      const knowledgeRead = sql.includes("FROM knowledge_current");
      const bodyRead = sql.slice(0, sql.indexOf("FROM")).includes("content");
      try {
        if (
          knowledgeRead &&
          bodyRead &&
          headerReads >= 2 &&
          beforeHydration?.() === false
        )
          return;
        const rows = runReadJob(db(), message.spec) as Record<
          string,
          unknown
        >[];
        reads.push({ sql, rows });
        if (knowledgeRead && !bodyRead) headerReads++;
        this.emit("message", { type: "read-result", id: message.id, rows });
      } catch {
        this.emit("message", {
          type: "error",
          id: message.id,
          error: "injected required hydration failure",
        });
      }
    }
  }
  _resetVectorPoolForTest();
  _setTestVectorWorkerFactory(() => new Reader() as unknown as Worker);
  return reads;
}

function create(
  title: string,
  content: string,
  extra: Partial<Parameters<typeof ltm.create>[0]> = {},
) {
  return ltm.create({
    projectPath: PROJECT,
    scope: "project",
    category: "gotcha",
    title,
    content,
    ...extra,
  });
}

test("loads bodies only for relevant candidates while preserving the complete overflow", async () => {
  const eligible = Array.from({ length: 8 }, (_, index) =>
    create(
      "Quasar routing contract " + index,
      "Quasar routing invariant " + index,
      {
        metadata: { gitHead: "quasar-" + index },
      },
    ),
  );
  for (let index = 0; index < 60; index++)
    create("Orchid palette rule " + index, "Orchid palette invariant " + index);
  const reads = serve();
  const overflow: ltm.KnowledgeEntry[] = [];
  const selected = await ltm.forSession(
    PROJECT,
    undefined,
    KNOWLEDGE_HEADER_OVERHEAD_TOKENS,
    {
      contextHint: "quasar routing",
      overflowSink: overflow,
      deferEffects: true,
    },
  );
  expect(selected).toEqual([]);
  expect(new Set(overflow.map((entry) => entry.id))).toEqual(new Set(eligible));
  expect(
    overflow.every((entry) => entry.metadata?.gitHead?.startsWith("quasar-")),
  ).toBe(true);
  const bodies = reads.flatMap((read) =>
    read.rows.filter((row) => typeof row.content === "string"),
  );
  expect(new Set(bodies.map((row) => row.id))).toEqual(new Set(eligible));
  expect(bodies).toHaveLength(eligible.length);
});

test("preference selection loads own directives and only relevant foreign bodies", async () => {
  const own = create("Own preferred editor", "Always use the chosen editor.", {
    category: "preference",
  });
  const global = create("Global preferred shell", "Use the user's shell.", {
    category: "preference",
    scope: "global",
  });
  const relevant = create(
    "Quasar preferred tooling",
    "Quasar uses the deployment helper.",
    {
      category: "preference",
      projectPath: "/test/ltm/foreign-pref",
      crossProject: true,
    },
  );
  const unrelated = create(
    "Orchid preferred colors",
    "Orchid uses mauve colors.",
    {
      category: "preference",
      projectPath: "/test/ltm/foreign-pref",
      crossProject: true,
    },
  );
  const reads = serve();
  const selected = await ltm.forSession(PROJECT, undefined, 10_000, {
    categories: ["preference"],
    contextHint: "quasar",
    deferEffects: true,
  });
  expect(new Set(selected.map((entry) => entry.id))).toEqual(
    new Set([own, global, relevant]),
  );
  const bodies = reads.flatMap((read) =>
    read.rows.filter((row) => typeof row.content === "string"),
  );
  expect(bodies.map((row) => row.id)).not.toContain(unrelated);
});

test("required body-read failures reject instead of freezing an empty selection", async () => {
  create("Quasar dispatch failure", "Quasar dispatch validates the request.");
  serve(() => {
    throw new Error("reader failed");
  });
  await expect(
    ltm.forSession(PROJECT, undefined, 1000, {
      contextHint: "quasar dispatch",
      deferEffects: true,
    }),
  ).rejects.toBeInstanceOf(ReadPreparationUnavailableError);
});

test("a selected version tombstoned before hydration rejects the whole selection", async () => {
  const target = create(
    "Quasar deleted contract",
    "Quasar protects the deleted contract.",
  );
  create(
    "Quasar remaining contract",
    "Quasar protects the remaining contract.",
  );
  let changed = false;
  serve(() => {
    if (!changed) {
      changed = true;
      ltm.remove(target);
    }
  });
  await expect(
    ltm.forSession(PROJECT, undefined, 1000, {
      contextHint: "quasar contract",
      deferEffects: true,
    }),
  ).rejects.toBeInstanceOf(ReadPreparationUnavailableError);
  expect(changed).toBe(true);
});

test.each(["confidence", "sharing", "ownership"] as const)(
  "a selected header changed by %s before hydration cannot freeze stale ranking",
  async (change) => {
    const foreignProject = ensureProject("/test/ltm/candidate-hydration/other");
    const target = create(
      "Quasar mutable rule",
      "Quasar protects the mutable rule.",
      { crossProject: true },
    );
    let changed = false;
    serve(() => {
      if (changed) return;
      changed = true;
      if (change === "confidence") ltm.update(target, { confidence: 0.4 });
      else if (change === "sharing")
        db()
          .query("UPDATE knowledge SET cross_project = 0 WHERE id = ?")
          .run(target);
      else
        db()
          .query("UPDATE knowledge SET project_id = ? WHERE id = ?")
          .run(foreignProject, target);
    });
    await expect(
      ltm.forSession(PROJECT, undefined, 1000, {
        contextHint: "quasar mutable",
        deferEffects: true,
      }),
    ).rejects.toBeInstanceOf(ReadPreparationUnavailableError);
    expect(changed).toBe(true);
  },
);

test("aborting during body hydration prevents delivery effects", async () => {
  const id = create("Quasar abort rule", "Quasar protects aborted requests.");
  const reinforcedBefore = ltm.get(id)?.last_reinforced_at;
  const controller = new AbortController();
  const reason = new Error("selection cancelled");
  serve(() => controller.abort(reason));
  await expect(
    ltm.forSession(PROJECT, "cancelled-session", 1000, {
      contextHint: "quasar abort",
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  expect(ltm.get(id)?.last_reinforced_at).toBe(reinforcedBefore);
});

test("a hydration result reordered by SQL retains full ranking and overflow order", async () => {
  const first = create(
    "Quasar first candidate",
    "Quasar routing invariant first.",
    { confidence: 0.6 },
  );
  const second = create(
    "Quasar second candidate",
    "Quasar routing invariant second.",
    { confidence: 0.95 },
  );
  serve();
  const overflow: ltm.KnowledgeEntry[] = [];
  const selected = await ltm.forSession(
    PROJECT,
    undefined,
    KNOWLEDGE_HEADER_OVERHEAD_TOKENS,
    {
      contextHint: "quasar",
      overflowSink: overflow,
      deferEffects: true,
    },
  );
  expect(selected).toEqual([]);
  expect(overflow.map((entry) => entry.id)).toEqual([second, first]);
});

test("header and body reads remain isolated from other tenants and private projects", async () => {
  const own = create("Quasar own boundary", "Quasar belongs to this project.");
  const privateId = create(
    "Quasar private boundary",
    "Quasar belongs to a private project.",
    { projectPath: "/test/ltm/candidate-hydration/private" },
  );
  const foreignTenant = withTenant("candidate-other-tenant", () =>
    create("Quasar tenant boundary", "Quasar belongs to a different tenant.", {
      crossProject: true,
    }),
  );
  const reads = serve();
  const selected = await ltm.forSession(PROJECT, undefined, 1000, {
    contextHint: "quasar",
    deferEffects: true,
  });
  expect(selected.map((entry) => entry.id)).toEqual([own]);
  const bodyIds = reads.flatMap((read) =>
    read.rows
      .filter((row) => typeof row.content === "string")
      .map((row) => row.id),
  );
  expect(bodyIds).not.toContain(privateId);
  expect(bodyIds).not.toContain(foreignTenant);
});

test.each(["include", "exclude"] as const)(
  "snapshots the caller's %s category filters across reader awaits",
  async (filter) => {
    const id = create(
      "Quasar snapshotted rule",
      "Quasar preserves request filters.",
    );
    create("Quasar excluded preference", "Quasar preference.", {
      category: "preference",
    });
    serve();
    const categories = ["gotcha"];
    const excluded = ["preference"];
    const pending = ltm.forSession(PROJECT, undefined, 1000, {
      ...(filter === "include" ? { categories } : {}),
      excludeCategories: excluded,
      contextHint: "quasar",
      deferEffects: true,
    });
    categories[0] = "architecture";
    excluded[0] = "gotcha";
    expect((await pending).map((entry) => entry.id)).toEqual([id]);
  },
);

test("a body hydration timeout rejects without reinforcing a partial selection", async () => {
  const id = create(
    "Quasar timeout rule",
    "Quasar requires available readers.",
  );
  const reinforcedBefore = ltm.get(id)?.last_reinforced_at;
  serve(() => false);
  vi.useFakeTimers();
  try {
    const pending = ltm.forSession(PROJECT, "timeout-session", 1000, {
      contextHint: "quasar timeout",
    });
    const rejected = expect(pending).rejects.toMatchObject({
      phase: "knowledge",
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    await rejected;
    expect(ltm.get(id)?.last_reinforced_at).toBe(reinforcedBefore);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["no-context", "unmatched-task"] as const)(
  "tied %s fallback membership matches the original full-row scan",
  async (mode) => {
    for (let i = 0; i < 20; i++)
      create("Orchid tied invariant " + i, "Orchid invariant " + i, {
        id:
          "018bcfe5-6800-7000-8000-" + (20 - i).toString(16).padStart(12, "0"),
      });
    const projectId = ensureProject(PROJECT);
    db()
      .query("UPDATE knowledge SET updated_at = ? WHERE project_id = ?")
      .run(1_700_000_000_000, projectId);
    const original = db()
      .query(
        "SELECT * FROM knowledge_current WHERE tenant_id = ? AND project_id = ? AND cross_project = 0 AND confidence > 0.2 ORDER BY confidence DESC, updated_at DESC",
      )
      .all("", projectId) as { id: string }[];
    const reads = serve();
    const selected = await ltm.forSession(PROJECT, undefined, 10_000, {
      ...(mode === "unmatched-task" ? { contextHint: "quasar" } : {}),
      deferEffects: true,
    });
    const expected = original
      .slice(0, mode === "no-context" ? 10 : 5)
      .map((row) => row.id)
      .sort();
    expect(selected.map((entry) => entry.id)).toEqual(expected);
    const bodies = reads.flatMap((read) =>
      read.rows.filter((row) => typeof row.content === "string"),
    );
    expect(new Set(bodies.map((row) => row.id))).toEqual(new Set(expected));
  },
);
