/**
 * Tests for `lore data export` — regenerates .lore.md / AGENTS.md from the
 * current DB for a project, on demand. Used to reconcile a drifted file (e.g.
 * stale entries that consolidation/tombstones removed from the DB but still
 * linger in a committed .lore.md) without waiting for the idle exporter or
 * running a destructive `clear`.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, ltm } from "@loreai/core";
import { commandData } from "../src/cli/data";

let projectDir: string;

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "lore-export-"));
  // Load config for the project (default: .lore.md + AGENTS.md pointer).
  await load(projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("lore data export", () => {
  test("regenerates .lore.md (+ AGENTS.md) from the DB", async () => {
    ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Export A",
      content: "first",
      scope: "project",
    });
    ltm.create({
      projectPath: projectDir,
      category: "gotcha",
      title: "Export B",
      content: "second",
      scope: "project",
    });

    await commandData(["export"], { project: projectDir });

    const loreFile = join(projectDir, ".lore.md");
    expect(existsSync(loreFile)).toBe(true);
    const content = readFileSync(loreFile, "utf8");
    expect(content).toContain("Export A");
    expect(content).toContain("Export B");
    // AGENTS.md pointer is written in the default config.
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);
  });

  test("does not list entries deleted via remove() (tombstoned)", async () => {
    const keep = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Keep",
      content: "stays",
      scope: "project",
    });
    const drop = ltm.create({
      projectPath: projectDir,
      category: "gotcha",
      title: "Drop",
      content: "removed",
      scope: "project",
    });
    ltm.remove(drop);

    await commandData(["export"], { project: projectDir });

    const content = readFileSync(join(projectDir, ".lore.md"), "utf8");
    expect(content).toContain("Keep");
    expect(content).not.toContain("Drop");
    expect(ltm.get(keep)).not.toBeNull();
  });

  test("removes a stale .lore.md when the project has no knowledge", async () => {
    // Seed + export so a .lore.md exists, then delete all entries and re-export.
    const id = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Temp",
      content: "x",
      scope: "project",
    });
    await commandData(["export"], { project: projectDir });
    expect(existsSync(join(projectDir, ".lore.md"))).toBe(true);

    ltm.remove(id);
    await commandData(["export"], { project: projectDir });

    // No knowledge left → the stale file is removed so git won't re-import it.
    expect(existsSync(join(projectDir, ".lore.md"))).toBe(false);
  });
});
