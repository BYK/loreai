import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("generated-retention leak detection ignores binary artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-score-binary-"));
  roots.push(root);
  const arms = ["lore", "nolore"];
  const dirs = arms.map((arm) => join(root, arm));
  for (const [index, dir] of dirs.entries()) {
    mkdirSync(join(dir, "project", "src"), { recursive: true });
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({
        valid: true,
        arm: arms[index],
        task: "pref-long",
        model: "test-model",
        agent: "opencode",
        repetition: 1,
        factMapId: "shared-facts",
        factMap: {
          status: "SUBMITTED",
          channel: "WHOLESALE",
          region: "EMEA",
          warehouse: "WH-07",
        },
        totals: {
          steps: 0,
          tokensTotal: 0,
          peakContext: 0,
          toolCalls: 0,
          wallSec: 0,
          cost: 0,
        },
      }),
    );
    writeFileSync(
      join(dir, "project", "artifact.bin"),
      Buffer.from("WHOLESALE", "utf8"),
    );
  }

  const output = execFileSync(
    process.execPath,
    [join(import.meta.dirname, "score.mjs"), ...dirs],
    { encoding: "utf8" },
  );
  const rows = JSON.parse(output.slice(0, output.indexOf("\n=== SUMMARY ===")));

  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (row: { leakedFacts: string[] }) => row.leakedFacts.length === 0,
    ),
  ).toBe(true);
});
