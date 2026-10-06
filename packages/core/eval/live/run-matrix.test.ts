import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const owned: string[] = [];

afterEach(() => {
  for (const dir of owned.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("matrix runner", () => {
  it("forwards an explicit OpenCode executable to every driver cell", () => {
    const source = fs.readFileSync(path.join(here, "run-matrix.mjs"), "utf8");
    expect(source).toContain(
      '...(args.opencode ? ["--opencode", args.opencode] : []),',
    );
  });

  it("plans paired eight-checkpoint workflow cells with test-only credentials", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lore-matrix-plan-"));
    owned.push(root);
    const auth = path.join(root, "synthetic-auth.json");
    fs.writeFileSync(
      auth,
      JSON.stringify({
        openrouter: { key: "synthetic-placeholder" },
        "minimax-coding-plan": { key: "synthetic-placeholder" },
      }),
    );
    const plan = JSON.parse(
      execFileSync(
        "bun",
        [
          "run-matrix.mjs",
          "--manifest",
          path.join(here, "matrix-iterative-orders.json"),
          "--auth",
          auth,
          "--out",
          path.join(root, "results"),
          "--dry-run",
        ],
        { cwd: here, encoding: "utf8" },
      ),
    );
    const fixture = JSON.parse(
      fs.readFileSync(path.join(here, "task-iterative-orders.json"), "utf8"),
    );
    const checkpoints = fixture.sessions[0].turns.map(
      (turn: { checkpoint: string }) => turn.checkpoint,
    );
    expect(checkpoints).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
      "c7",
      "c8",
    ]);
    expect(fixture.workflowGate).toMatchObject({
      checkpoint: "c7",
      minBaselineCompactions: 2,
      minBaselineProviderTokens: 1_000_000,
    });
    expect(plan.totalCells).toBe(180);
    const workflow = plan.cells.filter(
      (cell: { task: string }) => cell.task === fixture.id,
    );
    expect(workflow).toHaveLength(60);
    for (let i = 0; i < workflow.length; i += 2) {
      expect(workflow[i].factMapId).toBe(workflow[i + 1].factMapId);
      expect(new Set([workflow[i].arm, workflow[i + 1].arm])).toEqual(
        new Set(["nolore", "lore"]),
      );
    }
  });
});
