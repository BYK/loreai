import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
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

// #1083: peekProjectRefsOffloaded runs the unbounded knowledge scan off-thread
// (the cheap 24h rate-gate read and extractReferences CPU stay in-process). It
// must return the same {gated, refs} peekProjectRefs would, offload the scan
// only when NOT gated, and re-run in-process on a worker timeout (never a
// spuriously-empty ref set).

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

let counter = 0;
function freshProject(): string {
  return `/test/peek-refs-offload-${counter++}`;
}

let titleCounter = 0;
function seedRefEntry(projectPath: string, content: string): void {
  ltm.create({
    projectPath,
    scope: "project",
    crossProject: false,
    category: "gotcha",
    title: `Peek ref entry ${++titleCounter}`,
    content,
  });
}

function openGate(projectPath: string): void {
  // A fresh project has last_refcheck_at NULL (→ 0) so the gate is already open;
  // this is belt-and-suspenders for reused ids.
  const pid = ensureProject(projectPath);
  db().query("UPDATE projects SET last_refcheck_at = 0 WHERE id = ?").run(pid);
}

function closeGate(projectPath: string): void {
  const pid = ensureProject(projectPath);
  db()
    .query("UPDATE projects SET last_refcheck_at = ? WHERE id = ?")
    .run(Date.now(), pid);
}

beforeEach(() => {
  ServingReadWorker.sqls = [];
});

afterEach(() => {
  vi.useRealTimers();
  _setTestVectorWorkerFactory(null);
  _resetVectorPoolForTest();
});

describe("ltm.peekProjectRefsOffloaded (#1083)", () => {
  it("with the pool serving, returns exactly what sync peekProjectRefs returns", async () => {
    const PROJECT = freshProject();
    openGate(PROJECT);
    seedRefEntry(PROJECT, "the impl lives in src/alpha.ts:3 — see it");
    seedRefEntry(PROJECT, "always `pnpm run build` before shipping");

    installFactory(() => new ServingReadWorker());
    const sync = ltm.peekProjectRefs(PROJECT);
    const offloaded = await ltm.peekProjectRefsOffloaded(PROJECT);

    expect(sync.gated).toBe(false);
    expect(offloaded.gated).toBe(false);
    expect(sync.refs.length).toBeGreaterThan(0);
    // Same deduped reference set (order-independent — dedupe keys on ref.raw).
    expect(new Set(offloaded.refs.map((r) => r.raw))).toEqual(
      new Set(sync.refs.map((r) => r.raw)),
    );
    // The knowledge scan was actually dispatched to the worker pool.
    expect(
      ServingReadWorker.sqls.some((s) => /FROM knowledge_current\b/.test(s)),
    ).toBe(true);
  });

  it("returns gated without offloading when the 24h gate is closed", async () => {
    const PROJECT = freshProject();
    seedRefEntry(PROJECT, "src/beta.ts:1 reference");
    closeGate(PROJECT);

    // A hanging worker would stall forever if the scan were dispatched — proving
    // the gate short-circuits before the offload.
    installFactory(() => new HangingReadWorker());
    const res = await ltm.peekProjectRefsOffloaded(PROJECT);
    expect(res).toEqual({ gated: true, refs: [] });
    expect(
      ServingReadWorker.sqls.some((s) => /FROM knowledge_current\b/.test(s)),
    ).toBe(false);
  });

  it("on a worker TIMEOUT re-runs the scan in-process (never a spurious empty)", async () => {
    const PROJECT = freshProject();
    openGate(PROJECT);
    seedRefEntry(PROJECT, "check src/gamma.ts:2 and run `pnpm run test`");
    const expected = ltm.peekProjectRefs(PROJECT);
    expect(expected.refs.length).toBeGreaterThan(0);

    installFactory(() => new HangingReadWorker());
    vi.useFakeTimers();
    const p = ltm.peekProjectRefsOffloaded(PROJECT);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    const got = await p;

    expect(got.gated).toBe(false);
    expect(new Set(got.refs.map((r) => r.raw))).toEqual(
      new Set(expected.refs.map((r) => r.raw)),
    );
  });
});
