import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
        expectedCheckpoints: 5,
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

test("lore cost handles paths containing shell metacharacters", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-score-$(inert)-"));
  roots.push(root);
  const dir = join(root, "lore");
  const noLoreDir = join(root, "nolore");
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(noLoreDir, "project"), { recursive: true });
  execFileSync("python3", [
    "-c",
    "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE daily_costs (bucket TEXT, cost REAL)');c.execute(\"INSERT INTO daily_costs VALUES ('conversation', 1.25)\");c.commit()",
    join(dir, "data", "lore.db"),
  ]);
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({
      valid: true,
      arm: "lore",
      task: "pref-long",
      model: "test-model",
      agent: "opencode",
      repetition: 1,
      factMapId: "facts",
      factMap: {},
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
    join(noLoreDir, "result.json"),
    JSON.stringify({
      valid: true,
      arm: "nolore",
      task: "pref-long",
      model: "test-model",
      agent: "opencode",
      repetition: 1,
      factMapId: "facts",
      factMap: {},
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

  const output = execFileSync(
    process.execPath,
    [join(import.meta.dirname, "score.mjs"), dir, noLoreDir],
    {
      encoding: "utf8",
    },
  );
  const [row] = JSON.parse(
    output.slice(0, output.indexOf("\n=== SUMMARY ===")),
  );

  expect(row.cost.loreConversationUsd).toBe(1.25);
});

test("lore cost query does not invoke a shell", () => {
  const source = readFileSync(join(import.meta.dirname, "score.mjs"), "utf8");

  expect(source).not.toContain("execSync");
});

test("rejects partial invalid results before scoring", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-score-invalid-"));
  roots.push(root);
  writeFileSync(
    join(root, "result.json"),
    JSON.stringify({ valid: false, arm: "lore" }),
  );

  expect(() =>
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, "score.mjs"), root],
      {
        encoding: "utf8",
        stdio: "pipe",
      },
    ),
  ).toThrow(/invalid run must not be scored/);
});

test("checkpoint scoring retains completed work for a terminal agent timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-checkpoint-timeout-"));
  roots.push(root);
  const dirs = ["lore", "nolore"].map((arm) => join(root, arm));
  for (const arm of ["lore", "nolore"]) {
    const dir = join(root, arm);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({
        valid: true,
        terminalOutcome: "agent-timeout",
        arm,
        task: "pref-xlong",
        model: "test-model",
        agent: "opencode",
        repetition: 1,
        factMapId: "shared-facts",
        expectedCheckpoints: 5,
        checkpoints: [
          {
            id: "c1",
            core: { passed: true },
            isolated: { passed: true },
            strict: { passed: true },
          },
        ],
        totals: { wallSec: 900, tokensTotal: 1, steps: 1 },
      }),
    );
  }

  const output = execFileSync(
    process.execPath,
    [join(import.meta.dirname, "checkpoint-score.mjs"), ...dirs],
    { encoding: "utf8" },
  );

  expect(output).toContain("core 1/1");
  expect(output).toContain("completion 1/5 | final PARTIAL");
  expect(output).toContain("terminal agent-timeout");
});

test("checkpoint scoring rejects incomplete runs without a terminal timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-checkpoint-incomplete-"));
  roots.push(root);
  writeFileSync(
    join(root, "result.json"),
    JSON.stringify({
      valid: true,
      arm: "lore",
      task: "pref-xlong",
      model: "test-model",
      agent: "opencode",
      repetition: 1,
      factMapId: "facts",
      expectedCheckpoints: 5,
      checkpoints: [],
      totals: {},
    }),
  );

  expect(() =>
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, "checkpoint-score.mjs"), root],
      { encoding: "utf8", stdio: "pipe" },
    ),
  ).toThrow(/incomplete checkpoint run/);
});

test("terminal agent timeouts tolerate truncated session events", () => {
  const source = readFileSync(join(import.meta.dirname, "driver.mjs"), "utf8");

  expect(source).toContain(
    "const turnErrors = scoredTimeout ? [] : [...(tm.errors || [])];",
  );
});

test("matrix crash cleanup removes both runtime credential files", () => {
  const source = readFileSync(
    join(import.meta.dirname, "run-matrix.mjs"),
    "utf8",
  );

  expect(source).toContain('path.join(out, "data/opencode/auth.json")');
  expect(source).toContain('path.join(out, "pi-home/auth.json")');
});
