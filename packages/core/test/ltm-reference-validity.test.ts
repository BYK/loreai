import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { db } from "../src/db";
import * as ltm from "../src/ltm";
import { DirectFsResolver, NoopResolver } from "../src/references";

// Each test gets a fresh temp dir used as BOTH the DB project path AND the
// filesystem root the resolver checks (local mode: gateway co-located with repo).
let root: string;
const resolver = () => new DirectFsResolver(root);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-refval-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "real.ts"), "a\nb\nc\nd\ne\n"); // 5 lines
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { lint: "biome", test: "vitest" } }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Unique title per seed — a shared title would collide with ltm.create's
// per-project (and cross_project) dedup guard across tests in the shared DB.
let seedCounter = 0;
function seed(content: string, opts: { crossProject?: boolean } = {}): string {
  return ltm.create({
    projectPath: root,
    scope: opts.crossProject ? "global" : "project",
    crossProject: opts.crossProject ?? false,
    category: "gotcha",
    title: `Ref entry ${++seedCounter}`,
    content,
  });
}

const conf = (id: string) => ltm.get(id)?.confidence;

describe("validateProjectReferences (#627 Phase 0)", () => {
  test("existing file + in-range line → no penalty", async () => {
    const id = seed("see src/real.ts:3 for the impl");
    const res = await ltm.validateProjectReferences(root, resolver());
    expect(res.penalized).toBe(0);
    expect(res.checked).toBe(1);
    expect(conf(id)).toBe(1.0);
  });

  test("missing file → penalized by REFERENCE_DRIFT_PENALTY, NOT deleted", async () => {
    const id = seed("the fix is in src/gone.ts:10");
    const res = await ltm.validateProjectReferences(root, resolver());
    expect(res.penalized).toBe(1);
    expect(conf(id)).toBeCloseTo(1.0 - ltm.REFERENCE_DRIFT_PENALTY, 5);
    // not deleted — still resolvable
    expect(ltm.get(id)).not.toBeNull();
  });

  test("existing file + out-of-range line → penalized", async () => {
    const id = seed("see src/real.ts:999 (past EOF)");
    await ltm.validateProjectReferences(root, resolver());
    expect(conf(id)).toBeCloseTo(0.9, 5);
  });

  test("pnpm run <removed-script> → penalized", async () => {
    const id = seed("always `pnpm run typecheck` before commit"); // typecheck not in scripts
    await ltm.validateProjectReferences(root, resolver());
    expect(conf(id)).toBeCloseTo(0.9, 5);
  });

  test("present script → no penalty", async () => {
    const id = seed("run `pnpm run lint` to format");
    await ltm.validateProjectReferences(root, resolver());
    expect(conf(id)).toBe(1.0);
  });

  test("entry with NO extractable refs → untouched (no refs ≠ broken)", async () => {
    const id = seed("a purely prose insight with no citations at all");
    const res = await ltm.validateProjectReferences(root, resolver());
    expect(res.checked).toBe(0);
    expect(conf(id)).toBe(1.0);
  });

  test("ONE flat penalty regardless of how many refs are broken", async () => {
    const id = seed("src/gone1.ts:1 and src/gone2.ts:2 and `pnpm run nope`");
    await ltm.validateProjectReferences(root, resolver());
    // exactly one −0.1, never 3×
    expect(conf(id)).toBeCloseTo(0.9, 5);
  });

  test("promoted (cross_project=1, still project-scoped) entry with a broken ref → UNTOUCHED", async () => {
    // The load-bearing case (cf. PR #902): a PROMOTED entry keeps its origin
    // project_id AND sets cross_project=1, so `project_id = ?` alone would still
    // select it — only the `cross_project = 0` guard excludes it. (A pure global
    // entry has project_id=NULL and is already excluded by the project filter, so
    // it would NOT exercise this guard.)
    const id = seed("broken ref src/gone.ts:1");
    const logicalId = ltm.get(id)?.logical_id;
    db()
      .query("UPDATE knowledge SET cross_project = 1 WHERE logical_id = ?")
      .run(logicalId);
    const res = await ltm.validateProjectReferences(root, resolver());
    expect(res.penalized).toBe(0);
    expect(conf(id)).toBe(1.0);
  });

  test("rate gate: second pass within the interval is a no-op", async () => {
    const id = seed("src/gone.ts:1");
    const now = Date.now();
    const first = await ltm.validateProjectReferences(root, resolver(), now);
    expect(first.gated).toBe(false);
    expect(conf(id)).toBeCloseTo(0.9, 5);
    const second = await ltm.validateProjectReferences(
      root,
      resolver(),
      now + 1000,
    );
    expect(second.gated).toBe(true);
    // no second decrement
    expect(conf(id)).toBeCloseTo(0.9, 5);
  });

  test("clock-not-reset: a penalty does NOT touch last_reinforced_at", async () => {
    const id = seed("src/gone.ts:1");
    const before = ltm.get(id)?.last_reinforced_at;
    await ltm.validateProjectReferences(root, resolver());
    expect(conf(id)).toBeCloseTo(0.9, 5); // penalty applied
    expect(ltm.get(id)?.last_reinforced_at).toBe(before); // clock untouched
  });

  test("neutral-on-unknown: a null-resolver batch penalizes NOTHING", async () => {
    const id = seed("src/gone.ts:1"); // would be 'missing' under Direct-FS
    const res = await ltm.validateProjectReferences(root, new NoopResolver());
    expect(res.neutral).toBe(true);
    expect(res.penalized).toBe(0);
    expect(conf(id)).toBe(1.0);
  });

  test("unverifiable refs (absolute / ambiguous) never penalize", async () => {
    const id = seed("see /opt/elsewhere/gone.ts:1 (absolute, out of tree)");
    const res = await ltm.validateProjectReferences(root, resolver());
    expect(res.penalized).toBe(0);
    expect(conf(id)).toBe(1.0);
  });

  // Regression (#939 Seer): a write failure inside the penalty transaction must
  // still advance the 24h rate gate — otherwise the next idle tick re-runs the
  // same failing pass (re-resolve / re-probe) every tick forever.
  test("a penalty-transaction write failure still stamps the rate gate (no retry loop)", async () => {
    seed("src/gone.ts:1"); // a broken ref → reaches the penalty/insert write
    db().exec("DROP TABLE knowledge_ref_validity"); // force the upsert to throw
    const now = Date.now();
    try {
      // The pass throws (the transaction rolls back), but the gate is stamped
      // in `finally`, so the SECOND pass is rate-gated instead of re-running.
      await expect(
        ltm.validateProjectReferences(root, resolver(), now),
      ).rejects.toThrow();
      const second = await ltm.validateProjectReferences(
        root,
        resolver(),
        now + 1000,
      );
      expect(second.gated).toBe(true);
    } finally {
      db().exec(
        `CREATE TABLE IF NOT EXISTS knowledge_ref_validity (
           logical_id TEXT PRIMARY KEY,
           broken     INTEGER NOT NULL DEFAULT 0,
           total      INTEGER NOT NULL DEFAULT 0,
           checked_at INTEGER NOT NULL DEFAULT 0
         )`,
      );
    }
  });

  test("records resolve counts in knowledge_ref_validity", async () => {
    const id = seed("ok: src/real.ts:1 broken: src/gone.ts:1");
    const logicalId = ltm.get(id)?.logical_id;
    await ltm.validateProjectReferences(root, resolver());
    const row = db()
      .query(
        "SELECT broken, total FROM knowledge_ref_validity WHERE logical_id = ?",
      )
      .get(logicalId) as { broken: number; total: number } | null;
    expect(row).toMatchObject({ broken: 1, total: 2 });
  });
});

// Cited-symbol validation end-to-end (#911): symbols use a presence HISTORY. A
// symbol only decays confidence when it was PREVIOUSLY confirmed present and is
// now absent (genuine rename/removal drift). A never-present mention (external
// lib, historical/renamed-away name, rejected alternative) is a strict no-op.
// Needs a real git work tree (`git grep`), so these git-init the per-test root.
describe.skipIf(process.platform === "win32")(
  "validateProjectReferences — cited symbols (#911)",
  () => {
    const gitInit = (): void => {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "-A"], { cwd: root });
    };

    test("drift: a symbol once present, now absent → penalized once", async () => {
      writeFileSync(
        join(root, "src", "real.ts"),
        "export function keptHelper() {}\na\nb\nc\n",
      );
      const id = seed("`keptHelper` lives in src/real.ts:1");
      gitInit();
      const t0 = Date.now();
      // Pass 1: symbol present → records presence, no penalty.
      const p1 = await ltm.validateProjectReferences(root, resolver(), t0);
      expect(p1.penalized).toBe(0);
      expect(conf(id)).toBe(1.0);
      // The symbol is removed from the repo.
      writeFileSync(join(root, "src", "real.ts"), "a\nb\nc\nd\n");
      execFileSync("git", ["add", "-A"], { cwd: root });
      // Pass 2, after the 24h gate: absent + prior presence → drift → penalize.
      const p2 = await ltm.validateProjectReferences(
        root,
        resolver(),
        t0 + ltm.REFCHECK_INTERVAL_MS + 1,
      );
      expect(p2.penalized).toBe(1);
      expect(conf(id)).toBeCloseTo(1.0 - ltm.REFERENCE_DRIFT_PENALTY, 5);
    });

    // 🔴 BLOCKER regression: an absent symbol that was NEVER present here (React's
    // useState, a rejected alternative, a renamed-away name) must NOT penalize a
    // perfectly valid entry — "cannot verify ≠ broken".
    test("never-present mention (external/historical) absent → neutral", async () => {
      writeFileSync(
        join(root, "src", "real.ts"),
        "export const keptHelper = 1;\n",
      );
      const id = seed(
        "Unlike React's `useState`, we use signals. See src/real.ts:1",
      );
      gitInit();
      const res = await ltm.validateProjectReferences(root, resolver());
      expect(res.penalized).toBe(0);
      expect(conf(id)).toBe(1.0);
    });

    test("present symbol → no penalty, and presence is recorded", async () => {
      writeFileSync(
        join(root, "src", "real.ts"),
        "export const keptHelper = 1;\n",
      );
      const id = seed("`keptHelper` lives in src/real.ts:1");
      gitInit();
      const res = await ltm.validateProjectReferences(root, resolver());
      expect(res.penalized).toBe(0);
      expect(conf(id)).toBe(1.0);
      const lid = ltm.get(id)?.logical_id;
      const row = db()
        .query(
          "SELECT 1 FROM knowledge_symbol_presence WHERE logical_id = ? AND symbol = ?",
        )
        .get(lid, "keptHelper");
      expect(row).toBeTruthy();
    });

    test("non-git repo → symbol unverifiable, never penalizes (neutral)", async () => {
      // No gitInit(): presence is null → symbol "unknown" → no signal. The
      // co-cited file ref is valid, so the entry is checked but not penalized.
      const id = seed("`keptHelper` lives in src/real.ts:3");
      const res = await ltm.validateProjectReferences(root, resolver());
      expect(res.penalized).toBe(0);
      expect(conf(id)).toBe(1.0);
    });
  },
);
