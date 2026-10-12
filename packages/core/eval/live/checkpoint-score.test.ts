import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const owned = new Set<string>();

afterEach(() => {
  for (const dir of owned) fs.rmSync(dir, { recursive: true, force: true });
  owned.clear();
});

function scorePair(
  compactionsAtFourth: number | null,
  finalCompactions = 2,
  options: {
    loreCompleted?: number;
    baselineCompleted?: number;
    baselineTokensAtFourth?: number;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lore-workflow-score-"));
  owned.add(root);
  const dirs: string[] = [];
  for (const arm of ["lore", "nolore"]) {
    const dir = path.join(root, arm);
    fs.mkdirSync(dir);
    dirs.push(dir);
    const completed =
      arm === "lore"
        ? (options.loreCompleted ?? 5)
        : (options.baselineCompleted ?? 5);
    const checkpoints = Array.from({ length: completed }, (_, index) => ({
      id: `c${index + 1}`,
      core: { passed: true },
      isolated: { passed: true },
      strict: { passed: true },
      nativeCompactions:
        arm === "lore"
          ? 0
          : index === 3
            ? compactionsAtFourth
            : index === 4
              ? finalCompactions
              : 0,
      providerTokens:
        index === 4
          ? arm === "lore"
            ? 600_000
            : 1_200_000
          : index === 3 && arm === "nolore"
            ? (options.baselineTokensAtFourth ?? 0)
            : 0,
    }));
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({
        arm,
        agent: "opencode",
        model: "synthetic-model",
        task: "iterative-orders-long",
        taskSha256: "same-frozen-task",
        factMapId: "same-frozen-facts",
        repetition: 1,
        valid: true,
        terminalOutcome: completed < 5 ? "agent-timeout" : null,
        checkpoints,
        expectedCheckpoints: 5,
        workflowGate: {
          checkpoint: "c4",
          minBaselineCompactions: 2,
          minBaselineProviderTokens: 1_000_000,
        },
        totals: {
          tokensTotal: arm === "lore" ? 600_000 : 1_200_000,
          wallSec: 20,
          steps: 12,
        },
      }),
    );
  }
  return execFileSync(
    process.execPath,
    [path.join(here, "checkpoint-score.mjs"), ...dirs],
    { encoding: "utf8" },
  );
}

describe("sustained-workflow qualification", () => {
  it("does not count compactions that occur after the scored late checkpoint", () => {
    const report = scorePair(1);
    expect(report).toContain('"qualified": false');
    expect(report).toContain("c4 requires 2 observed native compactions");
    expect(report).toContain("NOT QUALIFIED");
  });

  it("qualifies the pair when the control has two observed compactions before c4", () => {
    const report = scorePair(2);
    expect(report).toContain('"qualified": true');
    expect(report).toContain("PASS");
  });

  it("does not infer compaction evidence from an unobserved checkpoint", () => {
    const report = scorePair(null);
    expect(report).toContain('"qualified": false');
    expect(report).toContain("c4 has no compaction observation");
  });

  it("treats missing late checkpoints as failures within a qualified pair", () => {
    const report = scorePair(2, 2, { loreCompleted: 4 });
    const summary = JSON.parse(
      report.split("=== AGGREGATES (Wilson 95% CI) ===\n")[1],
    );
    expect(
      summary.find((row: { arm: string }) => row.arm === "lore"),
    ).toMatchObject({
      qualifiedRuns: 1,
      strict: { successes: 4, total: 5 },
    });
  });

  it("does not mistake a high-token early termination for a completed control", () => {
    const report = scorePair(2, 2, {
      baselineCompleted: 4,
      baselineTokensAtFourth: 1_200_000,
    });
    expect(report).toContain('"qualified": false');
    expect(report).toContain("final checkpoint not reached");
  });
});
