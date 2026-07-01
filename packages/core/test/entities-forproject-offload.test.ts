import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import { runReadJob } from "../src/read-job";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  vectorSearchTimeoutMs,
} from "../src/vector-pool";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
} from "../src/vector-worker-types";

// #1081: entities.forProjectOffloaded / entitiesForSessionOffloaded are
// off-thread twins of the sync catalog scans used to build the frozen system[1]
// entities block. They must return EXACTLY what the sync path returns — the
// offload is a pure "run the same scan off-thread when possible" optimization,
// with an in-process fallback on worker timeout (never a spurious empty, which
// would be frozen for the session).

const PROJECT = "/test/entities-forproject-offload";

/** Read-worker fake that answers each read by running it against the live DB —
 *  so the pool path returns genuine rows (proves hydration + ordering). Records
 *  every dispatched read SQL so a test can prove the pool was actually used. */
class ServingReadWorker extends EventEmitter {
  static sqls: string[] = [];
  unref(): void {}
  postMessage(msg: VectorWorkerInbound): void {
    if (msg.type === "read") {
      ServingReadWorker.sqls.push(msg.spec.sql);
      const rows = runReadJob(db(), msg.spec);
      this.emit("message", { type: "read-result", id: msg.id, rows });
    }
  }
  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

/** Read-worker fake that never replies → forces the per-request timeout. */
class HangingReadWorker extends EventEmitter {
  unref(): void {}
  postMessage(): void {}
  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

function installFactory(make: () => EventEmitter): void {
  _resetVectorPoolForTest();
  _setTestVectorWorkerFactory(
    make as unknown as (d: VectorWorkerInitData) => never,
  );
}

beforeEach(() => {
  ServingReadWorker.sqls = [];
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM entities WHERE project_id = ?").run(pid);
  db()
    .query(
      "DELETE FROM entities WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/%') OR (cross_project = 1 AND project_id IS NULL)",
    )
    .run();
});

afterEach(() => {
  vi.useRealTimers();
  _setTestVectorWorkerFactory(null);
  _resetVectorPoolForTest();
});

function seed(): void {
  // Two project-scoped entities (with an alias) + one genuinely-global one, so
  // includeCross visibility and the ORDER BY (entity_type, canonical_name) both
  // matter, and withAliases attaches a real alias.
  entities.create({
    projectPath: PROJECT,
    entityType: "repo",
    canonicalName: "acme-service",
    aliases: [{ type: "name", value: "acme" }],
  });
  entities.create({
    projectPath: PROJECT,
    entityType: "infra",
    canonicalName: "prod-cluster",
  });
  entities.create({
    entityType: "org",
    canonicalName: "Globex",
    crossProject: true,
  });
}

describe("entities.forProjectOffloaded (#1081)", () => {
  it("with the pool serving, returns exactly what the sync forProject returns", async () => {
    seed();
    installFactory(() => new ServingReadWorker());
    for (const includeCross of [true, false]) {
      const sync = entities.forProject(PROJECT, includeCross);
      const offloaded = await entities.forProjectOffloaded(
        PROJECT,
        includeCross,
      );
      expect(offloaded.map((e) => e.id)).toEqual(sync.map((e) => e.id));
      expect(offloaded).toEqual(sync);
    }
    // Aliases are attached (in-process withAliases), and cross-project scoping
    // holds: the global org appears only with includeCross.
    const withCross = await entities.forProjectOffloaded(PROJECT, true);
    expect(withCross.some((e) => e.canonical_name === "Globex")).toBe(true);
    expect(
      withCross.find((e) => e.canonical_name === "acme-service")?.aliases
        .length,
    ).toBeGreaterThan(0);
    const noCross = await entities.forProjectOffloaded(PROJECT, false);
    expect(noCross.some((e) => e.canonical_name === "Globex")).toBe(false);
    // The entity scan was actually dispatched to the worker pool (not silently
    // run in-process) — proves the offload path is taken.
    expect(ServingReadWorker.sqls.some((s) => /FROM entities\b/.test(s))).toBe(
      true,
    );
  });

  it("with the pool inert, falls back to the identical in-process query", async () => {
    seed();
    // No factory installed → pool inert → offloadAllOrTimeout runs in-process.
    const sync = entities.forProject(PROJECT, true);
    const offloaded = await entities.forProjectOffloaded(PROJECT, true);
    expect(offloaded).toEqual(sync);
  });

  it("on a worker TIMEOUT falls back to the full in-process scan (never a spurious empty)", async () => {
    seed();
    const expected = entities.forProject(PROJECT, true);
    expect(expected.length).toBeGreaterThan(0);

    installFactory(() => new HangingReadWorker());
    vi.useFakeTimers();
    const p = entities.forProjectOffloaded(PROJECT, true);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    const got = await p;
    expect(got.map((e) => e.id)).toEqual(expected.map((e) => e.id));
    // Aliases still attached on the fallback path.
    expect(
      got.find((e) => e.canonical_name === "acme-service")?.aliases.length,
    ).toBeGreaterThan(0);
  });
});

describe("entities.entitiesForSessionOffloaded (#1081)", () => {
  it("matches entitiesForSession under the injection cap (offloaded ranking parity)", async () => {
    // Seed more entities than the cap so the ranking/overflow path runs, and
    // assert the offloaded twin selects the identical ranked set.
    for (let i = 0; i < 12; i++) {
      entities.create({
        projectPath: PROJECT,
        entityType: "tool",
        canonicalName: `tool-${String(i).padStart(2, "0")}`,
      });
    }
    installFactory(() => new ServingReadWorker());
    const cap = 5;
    const sync = entities.entitiesForSession(PROJECT, cap);
    const offloaded = await entities.entitiesForSessionOffloaded(PROJECT, cap);
    expect(sync.length).toBe(cap);
    expect(offloaded.map((e) => e.id)).toEqual(sync.map((e) => e.id));
  });

  it("returns [] for a zero injection cap without touching the pool", async () => {
    seed();
    installFactory(() => new HangingReadWorker()); // would hang if consulted
    expect(await entities.entitiesForSessionOffloaded(PROJECT, 0)).toEqual([]);
  });
});
