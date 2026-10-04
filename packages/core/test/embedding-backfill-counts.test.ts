import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { config } from "../src/config";
import { close, db, ensureProject } from "../src/db";
import { missingEmbeddingSql, readStorageMode } from "../src/db/vec-store";
import {
  _restoreProvider,
  _saveAndClearProvider,
  runStartupBackfill,
} from "../src/embedding";

test("startup pending and coverage counts exclude unselectable orphan distillations", async () => {
  const saved = _saveAndClearProvider();
  const project = ensureProject("/test/orphan-distillation-counts");
  const now = Date.now();
  db()
    .query(
      `INSERT INTO distillations
       (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived)
       VALUES ('selectable-distillation', ?, 's', '', '', 'owned source', '', 0, 2, ?, 0)`,
    )
    .run(project, now);
  db().exec("PRAGMA foreign_keys = OFF");
  try {
    db()
      .query(
        `INSERT INTO distillations
         (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived)
         VALUES ('orphan-distillation', 'missing-project', 's', '', '', 'unselectable source', '', 0, 2, ?, 0)`,
      )
      .run(now);
  } finally {
    db().exec("PRAGMA foreign_keys = ON");
  }
  _restoreProvider({
    provider: {
      maxBatchSize: 8,
      async embed(texts: string[]) {
        return texts.map(() =>
          new Float32Array(config().search.embeddings.dimensions).fill(1),
        );
      },
    },
  });
  const summaries: string[] = [];
  const stderr = vi
    .spyOn(console, "error")
    .mockImplementation((value: string) => {
      summaries.push(value);
    });
  try {
    const stats = await runStartupBackfill();
    expect(stats.pendingDistillations).toBe(1);
    expect(stats.distillationEmbedded).toBe(1);
    expect(stats.distillationTotal).toBe(1);
    expect(stats.distillationWithEmbedding).toBe(1);
    expect(summaries.some((line) => line.includes("distillations 1/1"))).toBe(
      true,
    );
  } finally {
    stderr.mockRestore();
    _restoreProvider(saved);
  }
});

test("a delayed startup backfill never opens a successor database after close", async () => {
  const originalPath = process.env.LORE_DB_PATH!;
  const successorPath = join(
    process.env.LORE_TEST_DB_ROOT!,
    `${randomUUID()}.db`,
  );
  const saved = _saveAndClearProvider();
  const project = ensureProject("/test/startup-backfill-close");
  const now = Date.now();
  db()
    .query(
      `INSERT INTO knowledge
       (id, project_id, category, title, content, created_at, updated_at, logical_id)
       VALUES (?, ?, 'test', 'pending', 'source', ?, ?, ?)`,
    )
    .run(randomUUID(), project, now, now, randomUUID());
  _restoreProvider({
    provider: {
      maxBatchSize: 8,
      async embed(texts: string[]) {
        return texts.map(() =>
          new Float32Array(config().search.embeddings.dimensions).fill(1),
        );
      },
    },
  });

  let releaseDelay: (() => void) | undefined;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementationOnce((callback, delay) => {
      expect(delay).toBe(2_000);
      releaseDelay = () => callback();
      return {} as ReturnType<typeof setTimeout>;
    });
  try {
    const backfill = runStartupBackfill();
    timer.mockRestore();
    expect(releaseDelay).toBeTypeOf("function");
    close();
    process.env.LORE_DB_PATH = successorPath;
    releaseDelay!();
    const failure = await backfill.then(
      () => null,
      (error: unknown) => error,
    );
    expect(existsSync(successorPath)).toBe(false);
    expect(failure).toBeNull();
  } finally {
    timer.mockRestore();
    close();
    process.env.LORE_DB_PATH = originalPath;
    _restoreProvider(saved);
  }
});

test("shutdown aborts the pending startup delay without scheduling document work", async () => {
  const saved = _saveAndClearProvider();
  const controller = new AbortController();
  const project = ensureProject("/test/startup-backfill-abort");
  const now = Date.now();
  db()
    .query(
      `INSERT INTO knowledge
       (id, project_id, category, title, content, created_at, updated_at, logical_id)
       VALUES (?, ?, 'test', 'pending', 'source', ?, ?, ?)`,
    )
    .run(randomUUID(), project, now, now, randomUUID());
  _restoreProvider({
    provider: {
      maxBatchSize: 8,
      async embed(texts: string[]) {
        return texts.map(() =>
          new Float32Array(config().search.embeddings.dimensions).fill(1),
        );
      },
    },
  });

  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementationOnce(() => {
      return {} as ReturnType<typeof setTimeout>;
    });
  try {
    const backfill = runStartupBackfill({ signal: controller.signal });
    timer.mockRestore();
    controller.abort();
    const stats = await backfill;
    expect(stats.pendingKnowledge).toBeGreaterThan(0);
    expect(stats.knowledgeEmbedded).toBe(0);
  } finally {
    timer.mockRestore();
    _restoreProvider(saved);
  }
});

test.each(["distillations", "entities"] as const)(
  "shutdown settles a stalled %s startup embed without writing its vector",
  async (table) => {
    const saved = _saveAndClearProvider();
    const controller = new AbortController();
    const project = ensureProject(`/test/startup-${table}-abort`);
    const id = randomUUID();
    const now = Date.now();
    db().query("DELETE FROM knowledge").run();
    db().query("DELETE FROM distillations").run();
    db().query("DELETE FROM entities").run();
    if (table === "distillations") {
      db()
        .query(
          `INSERT INTO distillations
           (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived)
           VALUES (?, ?, 's', '', '', 'pending observation', '', 0, 2, ?, 0)`,
        )
        .run(id, project, now);
    } else {
      db()
        .query(
          `INSERT INTO entities
           (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at)
           VALUES (?, ?, 'tool', 'Pending entity', 0, ?, ?)`,
        )
        .run(id, project, now, now);
    }

    const control: {
      notifyStarted?: () => void;
      release?: () => void;
      releaseDelay?: () => void;
      settled: boolean;
    } = { settled: false };
    const started = new Promise<void>((resolve) => {
      control.notifyStarted = resolve;
    });
    _restoreProvider({
      provider: {
        maxBatchSize: 8,
        embed(texts: string[]) {
          return new Promise<Float32Array[]>((resolve) => {
            control.release = () =>
              resolve(
                texts.map(() =>
                  new Float32Array(config().search.embeddings.dimensions).fill(
                    1,
                  ),
                ),
              );
            control.notifyStarted?.();
          });
        },
      },
    });

    const timer =
      table === "distillations"
        ? vi
            .spyOn(globalThis, "setTimeout")
            .mockImplementationOnce((callback, delay) => {
              expect(delay).toBe(2_000);
              control.releaseDelay = () => callback();
              return {} as ReturnType<typeof setTimeout>;
            })
        : undefined;
    const walk = runStartupBackfill({ signal: controller.signal });
    timer?.mockRestore();
    control.releaseDelay?.();
    try {
      await started;
      void walk.then(
        () => {
          control.settled = true;
        },
        () => {
          control.settled = true;
        },
      );
      controller.abort();
      await vi.waitFor(() => expect(control.settled).toBe(true), {
        timeout: 1_500,
      });
      const stats = await walk;
      expect(stats.distillationEmbedded).toBe(0);
      expect(stats.entityEmbedded).toBe(0);
      control.release?.();
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        db()
          .query(
            `SELECT 1 FROM ${table} WHERE id = ? AND ${missingEmbeddingSql(table, readStorageMode(db()))}`,
          )
          .get(id),
      ).not.toBeNull();
    } finally {
      timer?.mockRestore();
      controller.abort();
      control.release?.();
      await walk.catch(() => {});
      _restoreProvider(saved);
    }
  },
);
