import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { extractSignals } from "../src/degradation-signals.ts";
import { stepsFromStream, toolCallTarget } from "./live/trace-extract.mjs";
import {
  analyzeBehavioralRotAB,
  formatBehavioralReport,
} from "./live/rot-behavioral.mjs";

// Build one `opencode run --format json` event line.
function ev(type: string, part: Record<string, unknown>): string {
  return JSON.stringify({ type, part });
}
function stepStart(): string {
  return ev("step_start", {});
}
function toolUse(
  tool: string,
  status: "completed" | "error" | "pending",
  input: unknown,
): string {
  return ev("tool_use", { tool, state: { status, input } });
}
function text(t: string): string {
  return ev("text", { text: t });
}
function stepFinish(input: number, cacheRead = 0, cacheWrite = 0): string {
  return ev("step_finish", {
    tokens: {
      input,
      output: 10,
      cache: { read: cacheRead, write: cacheWrite },
    },
  });
}

function writeStream(dir: string, name: string, lines: string[]): void {
  writeFileSync(join(dir, "sessions", name), lines.join("\n") + "\n");
}

describe("trace-extract: toolCallTarget", () => {
  test("file tools -> path", () => {
    expect(toolCallTarget("edit", { filePath: "src/a.ts" })).toBe("src/a.ts");
    expect(toolCallTarget("read", { path: "b/c.py" })).toBe("b/c.py");
    expect(toolCallTarget("write", { file: "x.md" })).toBe("x.md");
  });
  test("bash -> command; unknown targetless tool -> null", () => {
    expect(toolCallTarget("bash", { command: "ls -la" })).toBe("ls -la");
    expect(toolCallTarget("task", { description: "do a thing" })).toBeNull();
  });
});

describe("trace-extract: stepsFromStream", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rotb-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("folds tool_use + text between step_start/step_finish into one step with prompt tokens", () => {
    writeStream(dir, "s1-s1.json", [
      stepStart(),
      toolUse("bash", "completed", { command: "npm test" }),
      stepFinish(1000, 500, 200), // promptTokens = 1000+500+200 = 1700
      stepStart(),
      text("done"),
      stepFinish(2000),
    ]);
    const steps = stepsFromStream(join(dir, "sessions", "s1-s1.json"));
    expect(steps).toHaveLength(2);
    expect(steps[0].promptTokens).toBe(1700);
    expect(steps[0].toolCalls).toEqual([
      { name: "bash", target: "npm test", isError: false },
    ]);
    expect(steps[1].promptTokens).toBe(2000);
    expect(steps[1].assistantText).toBe("done");
  });

  test("error tool status maps to isError", () => {
    writeStream(dir, "s1-s1.json", [
      stepStart(),
      toolUse("edit", "error", { filePath: "x.ts" }),
      stepFinish(500),
    ]);
    const steps = stepsFromStream(join(dir, "sessions", "s1-s1.json"));
    expect(steps[0].toolCalls?.[0]).toEqual({
      name: "edit",
      target: "x.ts",
      isError: true,
    });
    // and the signal engine flags it as an edit_failure + tool_error
    const sig = extractSignals(steps);
    expect(sig[0].tool_error).toBe(true);
    expect(sig[0].edit_failure).toBe(true);
  });
});

describe("rot-behavioral: analyzeBehavioralRotAB", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotb-root-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // A run = 20 steps ramping 10K..200K tokens; if `degradeDeep`, every step
  // >=120K fails an edit (behavioral degradation deep in context).
  function writeRun(cell: string, n: number, degradeDeep: boolean): void {
    const dir = join(root, `${cell}-run${n}`);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      const tokens = 10_000 + i * 10_000;
      lines.push(stepStart());
      const isDeep = tokens >= 120_000;
      lines.push(
        toolUse("edit", degradeDeep && isDeep ? "error" : "completed", {
          filePath: `f${i}.ts`,
        }),
      );
      lines.push(stepFinish(tokens));
    }
    writeStream(dir, "s1-s1.json", lines);
  }

  test("lore (clean) vs nolore (degrades deep): significant deep advantage", () => {
    // Same scenario/model/cap; only the arm differs.
    for (const n of [1, 2]) writeRun("long-lore-m3-cap200", n, false);
    for (const n of [1, 2]) writeRun("long-nolore-m3-cap200", n, true);

    const reports = analyzeBehavioralRotAB(root);
    expect(reports).toHaveLength(1);
    const r = reports[0];
    // one lore arm + one nolore comparator
    const lore = r.arms.find((a: { arm: string }) => a.arm === "lore");
    const nolore = r.arms.find((a: { arm: string }) => a.arm === "nolore");
    expect(lore).toBeTruthy();
    expect(nolore).toBeTruthy();
    // nolore degrades deep; lore does not
    expect(nolore.deepRate).toBeGreaterThan(0);
    expect(lore.deepRate).toBe(0);
    // the contrast reports lore significantly better deep
    expect(r.contrasts).toHaveLength(1);
    expect(r.contrasts[0].arm).toBe("nolore");
    expect(r.contrasts[0].loreDeepAdvantageSignificant).toBe(true);
    // report renders without throwing
    expect(formatBehavioralReport(reports)).toContain("SIGNIFICANTLY better");
  });

  test("both arms clean: no significant advantage", () => {
    for (const n of [1, 2]) writeRun("long-lore-m3-cap200", n, false);
    for (const n of [1, 2]) writeRun("long-nolore-m3-cap200", n, false);
    const reports = analyzeBehavioralRotAB(root);
    expect(reports[0].contrasts[0].loreDeepAdvantageSignificant).toBe(false);
  });

  // A run with exactly ONE deep-zone edit failure, at the single deepest step.
  function writeThinRun(
    cell: string,
    n: number,
    oneDeepFailure: boolean,
  ): void {
    const dir = join(root, `${cell}-run${n}`);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      const tokens = 10_000 + i * 10_000;
      lines.push(stepStart());
      // Only the single deepest step (i===19) fails, and only when requested.
      const fail = oneDeepFailure && i === 19;
      lines.push(
        toolUse("edit", fail ? "error" : "completed", { filePath: `f${i}.ts` }),
      );
      lines.push(stepFinish(tokens));
    }
    writeStream(dir, "s1-s1.json", lines);
  }

  test("lore lower deep rate but overlapping CIs (tiny n): NOT significant", () => {
    // lore: 0 deep failures; nolore: 1 deep failure across a tiny deep zone.
    // lore.deepRate < nolore.deepRate, but with such small n the Wilson
    // intervals overlap, so the significance gate must return false.
    for (const n of [1, 2]) writeThinRun("long-lore-m3-cap200", n, false);
    for (const n of [1, 2]) writeThinRun("long-nolore-m3-cap200", n, true);
    const reports = analyzeBehavioralRotAB(root);
    const c = reports[0].contrasts[0];
    // Precondition: lore IS numerically lower deep (so the gate is actually
    // exercised, not short-circuited by the `l.deepRate < a.deepRate` guard).
    expect(c.loreDeepRate).toBeLessThan(c.armDeepRate as number);
    // ...but not SIGNIFICANTLY lower — overlapping Wilson intervals.
    expect(c.loreDeepAdvantageSignificant).toBe(false);
  });
});
