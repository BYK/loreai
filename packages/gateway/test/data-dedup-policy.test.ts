import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ltm } from "@loreai/core";
import { commandData } from "../src/cli/data";

let projectDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lore-data-dedup-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("lore data dedup safety policy", () => {
  test("--dry-run overrides --yes and preserves duplicate entries", async () => {
    const first = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Keep this duplicate",
      content: "The same decision content.",
      scope: "project",
    });
    const second = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Keep this duplicate",
      content: "The same decision content.",
      scope: "project",
    });

    await commandData(["dedup"], {
      project: projectDir,
      yes: true,
      "dry-run": true,
    });

    expect(ltm.get(first)).not.toBeNull();
    expect(ltm.get(second)).not.toBeNull();
  });
});
