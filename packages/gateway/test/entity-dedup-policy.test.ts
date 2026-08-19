import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, entities, projectId } from "@loreai/core";
import { commandEntity } from "../src/cli/entity";

let projectDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lore-entity-dedup-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("lore entity dedup safety policy", () => {
  test("legacy dedup preview preserves entities without --yes", async () => {
    const canonical = ensureEntity("tool", "Prefer idempotent writes");
    const duplicate = ensureEntity("tool", "Use atomic skill writes");
    const id = projectId(projectDir);

    expect(canonical).not.toBe(duplicate);
    expect(
      db()
        .query("SELECT COUNT(*) AS n FROM entities WHERE project_id = ?")
        .get(id),
    ).toMatchObject({ n: 2 });

    await commandEntity(["dedup"], {
      project: projectDir,
    });

    expect(
      db()
        .query("SELECT COUNT(*) AS n FROM entities WHERE project_id = ?")
        .get(id),
    ).toMatchObject({ n: 2 });
  });
});

function ensureEntity(type: string, name: string): string {
  const result = entities.create({
    projectPath: projectDir,
    entityType: type as Parameters<typeof entities.create>[0]["entityType"],
    canonicalName: name,
    crossProject: false,
  });
  return result.id;
}
