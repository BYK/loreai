/**
 * Tests for `lore data show knowledge <id>` metadata rendering (#627 Phase 1).
 *
 * The display path JSON-stringifies the parsed `metadata` object — without the
 * stringify, an object would render as `[object Object]`. These tests drive the
 * real `commandData` dispatcher against a temp project so the actual CLI handler
 * (`cmdShow`) executes, covering the metadata branch.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ltm } from "@loreai/core";
import { commandData } from "../src/cli/data";

let projectDir: string;
let logLines: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lore-show-meta-"));
  logLines = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("lore data show knowledge — metadata rendering (#627 Phase 1)", () => {
  test("renders metadata as JSON, not [object Object]", async () => {
    const id = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Show with metadata",
      content: "body",
      scope: "project",
      metadata: { gitHead: "abc1234deadbeef" },
    });

    await commandData(["show", "knowledge", id], { project: projectDir });

    const metaLine = logLines.find((l) => l.startsWith("Metadata:"));
    expect(metaLine).toBeDefined();
    // The bug guarded: an object would stringify to "[object Object]".
    expect(metaLine).not.toContain("[object Object]");
    expect(metaLine).toContain('{"gitHead":"abc1234deadbeef"}');
  });

  test("omits the Metadata line entirely when there is no metadata", async () => {
    const id = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Show without metadata",
      content: "body",
      scope: "project",
    });

    await commandData(["show", "knowledge", id], { project: projectDir });

    expect(logLines.some((l) => l.startsWith("Metadata:"))).toBe(false);
    // Sanity: the entry itself still rendered.
    expect(logLines.some((l) => l.includes("Show without metadata"))).toBe(
      true,
    );
  });
});
