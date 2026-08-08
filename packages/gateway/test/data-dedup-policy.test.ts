import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { data, ltm } from "@loreai/core";
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
  test.each([
    [
      "move",
      () => ({ project: projectDir, to: projectDir, "dry-run": true }),
      ["move", "session", "missing-session"],
      true,
    ],
    ["split", () => ({ project: projectDir }), ["split"], undefined],
  ])(
    "%s preview does not create an untracked project",
    async (_name, flagsFor, args, expectsFailure) => {
      expect(data.listProjects()).not.toContainEqual(
        expect.objectContaining({ path: projectDir }),
      );

      const command = commandData(args, flagsFor());
      if (expectsFailure) {
        await expect(command).rejects.toThrow();
      } else {
        await command;
      }

      expect(data.listProjects()).not.toContainEqual(
        expect.objectContaining({ path: projectDir }),
      );
    },
  );

  test("--dry-run does not create an untracked project", async () => {
    expect(data.listProjects()).not.toContainEqual(
      expect.objectContaining({ path: projectDir }),
    );

    await commandData(["dedup"], {
      project: projectDir,
      yes: true,
      "dry-run": true,
    });

    expect(data.listProjects()).not.toContainEqual(
      expect.objectContaining({ path: projectDir }),
    );
  });

  test("--dry-run overrides --yes and preserves a real duplicate cluster", async () => {
    const first = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Prefer idempotent writes",
      content: "Use atomic writes for generated skill files.",
      scope: "project",
    });
    const second = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Use atomic skill writes",
      content: "Use atomic writes for generated skill files.",
      scope: "project",
    });

    expect(first).not.toBe(second);

    await commandData(["dedup"], {
      project: projectDir,
      yes: true,
      "dry-run": true,
    });

    expect(ltm.get(first)).not.toBeNull();
    expect(ltm.get(second)).not.toBeNull();
  });
});
