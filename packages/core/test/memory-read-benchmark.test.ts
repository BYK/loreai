import { it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { config } from "../src/config";
import { db, ensureProject, withTransaction } from "../src/db";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import { searchRecall } from "../src/recall";
import {
  setReadPathTimingHook,
  type ReadPathTiming,
} from "../src/read-telemetry";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  shutdownVectorPoolAsync,
} from "../src/vector-pool";

// This opt-in benchmark uses real SQLite reader threads, not Vitest's normal
// in-process fallback. It deliberately measures FTS-only retrieval: no network,
// model downloads, or simulated embedding timings enter the samples.
it.skipIf(process.env.LORE_MEMORY_BENCHMARK !== "1")(
  "measures memory selection and recall over a populated knowledge corpus",
  async () => {
    const samples = Number(process.env.LORE_MEMORY_RUNS ?? 100);
    const warmups = Number(process.env.LORE_MEMORY_WARMUPS ?? 10);
    const entries = Number(process.env.LORE_MEMORY_ENTRIES ?? 1_000);
    for (const n of [samples, warmups, entries])
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error("Invalid benchmark count");
    if (samples < 1 || entries < 10)
      throw new Error("Benchmark needs samples and a corpus");
    const projectPath = "/test/memory-read-benchmark";
    const pid = ensureProject(projectPath);
    const fixtureId = (i: number) =>
      "018bcfe5-6800-7000-8000-" + i.toString(16).padStart(12, "0");
    const topics = [
      "sqlite",
      "gateway",
      "embedding",
      "recall",
      "typescript",
      "cache",
      "timeout",
      "privacy",
      "worker",
      "gradient",
    ];
    const disabled = vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
    // Use a real creation to obtain the current schema defaults. Bulk copying
    // that row only seeds fixtures; production FTS/sync triggers remain enabled.
    const first = ltm.create({
      id: fixtureId(0),
      projectPath,
      category: "architecture",
      title: "sqlite synthetic module 0",
      content:
        "sqlite synthetic behavior for benchmark module 0. Preserve the module invariant when modifying its implementation.",
      scope: "project",
    });
    const row = db()
      .query("SELECT * FROM knowledge WHERE logical_id = ?")
      .get(first) as Record<string, string | number | null | Uint8Array>;
    const columns = Object.keys(row);
    const insert = db().query(
      `INSERT INTO knowledge (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    withTransaction(() => {
      for (let i = 1; i < entries; i++) {
        const id = fixtureId(i);
        const topic = topics[i % topics.length];
        const next = {
          ...row,
          id,
          logical_id: id,
          title: `${topic} synthetic module ${i}`,
          content: `${topic} synthetic behavior for benchmark module ${i}. Preserve the module invariant when modifying its implementation.`,
          project_id: pid,
        };
        insert.run(...columns.map((c) => next[c as keyof typeof next]));
      }
    });
    expect(
      (
        db()
          .query(
            "SELECT count(*) AS n FROM knowledge_current WHERE project_id = ?",
          )
          .get(pid) as { n: number }
      ).n,
    ).toBe(entries);
    const compiled = await build({
      entryPoints: [resolve("packages/core/src/vector-worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      external: ["sqlite-vec"],
      logLevel: "silent",
    });
    const source = `module.paths.unshift(${JSON.stringify(resolve("packages/core/node_modules"))});\n${compiled.outputFiles[0].text}`;
    _resetVectorPoolForTest();
    let spawnedWorkers = 0;
    let bodyRows = 0;
    let headerRows = 0;
    _setTestVectorWorkerFactory((data) => {
      spawnedWorkers++;
      const worker = new Worker(source, { eval: true, workerData: data });
      worker.on(
        "message",
        (message: { type: string; rows?: Record<string, unknown>[] }) => {
          if (
            message.type !== "read-result" ||
            !Array.isArray(message.rows) ||
            !message.rows.length
          )
            return;
          const firstRow = message.rows[0];
          if (typeof firstRow.content === "string")
            bodyRows += message.rows.length;
          else if ("project_id" in firstRow) headerRows += message.rows.length;
        },
      );
      return worker;
    });
    const runs: unknown[] = [];
    const expected = new Map<string, string>();
    let readTiming: ReadPathTiming | undefined;
    setReadPathTimingHook((timing) => {
      readTiming = timing;
    });
    try {
      for (let sample = -warmups; sample < samples; sample++) {
        const topic =
          topics[((sample % topics.length) + topics.length) % topics.length];
        for (const mode of sample % 2
          ? ["recall", "selection"]
          : ["selection", "recall"]) {
          const cpu = process.cpuUsage();
          bodyRows = 0;
          headerRows = 0;
          readTiming = undefined;
          const start = performance.now();
          const result =
            mode === "selection"
              ? await ltm.forSession(projectPath, undefined, 2_000, {
                  contextHint: topic,
                  deferEffects: true,
                })
              : await searchRecall({
                  query: topic,
                  projectPath,
                  scope: "knowledge",
                  searchConfig: { ...config().search, queryExpansion: false },
                });
          const elapsedMs = performance.now() - start;
          const cpuDelta = process.cpuUsage(cpu);
          expect(result.length, `${mode}:${topic}`).toBeGreaterThan(0);
          const hash = createHash("sha256")
            .update(JSON.stringify(result))
            .digest("hex");
          const semanticHash = createHash("sha256")
            .update(
              JSON.stringify(result, (key, value: unknown) =>
                key === "project_id"
                  ? "synthetic-project"
                  : ["created_at", "updated_at", "last_reinforced_at"].includes(
                        key,
                      ) && value !== null
                    ? 0
                    : value,
              ),
            )
            .digest("hex");
          const key = `${mode}:${topic}`;
          if (expected.has(key)) expect(hash).toBe(expected.get(key));
          else expected.set(key, hash);
          if (sample >= 0)
            runs.push({
              sample,
              mode,
              topic,
              elapsedMs,
              cpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
              count: result.length,
              hash,
              semanticHash,
              bodyRows,
              headerRows,
              rssBytes: process.memoryUsage().rss,
              readTiming,
            });
        }
      }
      expect(spawnedWorkers).toBeGreaterThan(0);
      const report = {
        node: process.version,
        samples,
        warmups,
        entries,
        spawnedWorkers,
        embeddings: "disabled",
        workers: "real node worker_threads + query-only SQLite WAL connections",
        runs,
      };
      if (process.env.LORE_MEMORY_REPORT)
        writeFileSync(
          process.env.LORE_MEMORY_REPORT,
          JSON.stringify(report, null, 2) + "\n",
        );
      process.stdout.write(
        JSON.stringify({ entries, samples: runs.length, spawnedWorkers }) +
          "\n",
      );
    } finally {
      await shutdownVectorPoolAsync();
      _setTestVectorWorkerFactory(null);
      _resetVectorPoolForTest();
      disabled.mockRestore();
      setReadPathTimingHook(null);
    }
  },
);
