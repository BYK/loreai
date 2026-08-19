import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearGitRemoteCache, db, embedding, entities } from "@loreai/core";
import { commandEntity } from "../src/cli/entity";

let projectDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let embeddingAvailabilitySpy: ReturnType<typeof vi.spyOn>;
let embeddingBackfillSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lore-entity-dedup-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  embeddingAvailabilitySpy = vi
    .spyOn(embedding, "isAvailable")
    .mockReturnValue(true);
  embeddingBackfillSpy = vi
    .spyOn(embedding, "backfillEntityEmbeddings")
    .mockResolvedValue(0);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  embeddingAvailabilitySpy.mockRestore();
  embeddingBackfillSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("lore entity dedup safety policy", () => {
  test("--dry-run overrides --yes and preserves a real duplicate cluster", async () => {
    const canonical = ensureEntity("tool", "Prefer idempotent writes", {
      type: "github",
      value: "idempotent-writes",
    });
    const duplicate = ensureEntity("tool", "Use atomic skill writes", {
      type: "nickname",
      value: "idempotent-writes",
    });

    expect(canonical).not.toBe(duplicate);
    expect(
      db().query("SELECT COUNT(*) AS n FROM entities").get(),
    ).toMatchObject({ n: 2 });

    const preview = await entities.deduplicateEntities(projectDir, {
      dryRun: true,
    });
    expect(preview.merged).toHaveLength(1);

    await commandEntity(["dedup"], {
      project: projectDir,
      yes: true,
      "dry-run": true,
    });

    expect(
      db().query("SELECT COUNT(*) AS n FROM entities").get(),
    ).toMatchObject({ n: 2 });
    expect(embeddingBackfillSpy).not.toHaveBeenCalled();
  });

  test("--dry-run does not create an unknown project", async () => {
    const before = db().query("SELECT COUNT(*) AS n FROM projects").get() as {
      n: number;
    };

    await commandEntity(["dedup"], {
      project: projectDir,
      yes: true,
      "dry-run": true,
    });

    const after = db().query("SELECT COUNT(*) AS n FROM projects").get() as {
      n: number;
    };
    expect(after.n).toBe(before.n);
    expect(embeddingBackfillSpy).not.toHaveBeenCalled();
  });

  test("--dry-run does not reconcile an unsettled project remote", async () => {
    ensureEntity("tool", "Known tool", {
      type: "github",
      value: "known-tool",
    });
    ensureEntity("tool", "Another known tool", {
      type: "nickname",
      value: "known-tool",
    });
    execFileSync("git", ["init", "-q"], { cwd: projectDir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/test/preview.git"],
      { cwd: projectDir },
    );
    clearGitRemoteCache();

    const before = db()
      .query("SELECT git_remote FROM projects WHERE path = ?")
      .get(projectDir) as { git_remote: string | null };
    expect(before.git_remote).toBeNull();

    const preview = await entities.deduplicateEntities(projectDir, {
      dryRun: true,
    });

    expect(preview.merged).toHaveLength(1);
    const after = db()
      .query("SELECT git_remote FROM projects WHERE path = ?")
      .get(projectDir) as { git_remote: string | null };
    expect(after.git_remote).toBeNull();
  });

  test("interactive dedup uses --yes as confirmation, not auto-apply", async () => {
    const deduplicateSpy = vi
      .spyOn(entities, "deduplicateEntities")
      .mockResolvedValue({
        merged: [],
        suggested: [],
        pairSimilarities: new Map(),
        names: new Map(),
      });

    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    try {
      await commandEntity(["dedup"], {
        project: projectDir,
        interactive: true,
        yes: true,
      });
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }

    expect(deduplicateSpy).toHaveBeenCalledWith(projectDir, { dryRun: true });
    expect(embeddingBackfillSpy).not.toHaveBeenCalled();
    deduplicateSpy.mockRestore();
  });

  test("manual merge rejects different entity types", async () => {
    const person = ensureEntity("person", "A person", {
      type: "nickname",
      value: "person-one",
    });
    const service = ensureEntity("service", "A service", {
      type: "nickname",
      value: "service-one",
    });

    await expect(
      commandEntity(["merge", person, service], {
        project: projectDir,
        yes: true,
      }),
    ).rejects.toMatchObject({ name: "UsageError", exitCode: 20 });
    expect(entities.get(person)).not.toBeNull();
    expect(entities.get(service)).not.toBeNull();
  });

  test("manual merge preserves the self/person compatibility exception", async () => {
    const self = ensureEntity("self", "The user", {
      type: "email",
      value: "user@example.com",
    });
    const person = ensureEntity("person", "User", {
      type: "nickname",
      value: "the-user",
    });

    await commandEntity(["merge", self, person], {
      project: projectDir,
      yes: true,
    });

    expect(entities.get(self)).not.toBeNull();
    expect(entities.get(person)).toBeNull();
  });
});

function ensureEntity(
  type: string,
  name: string,
  alias: { type: string; value: string },
): string {
  const result = entities.create({
    projectPath: projectDir,
    entityType: type as Parameters<typeof entities.create>[0]["entityType"],
    canonicalName: name,
    aliases: [
      alias as NonNullable<
        Parameters<typeof entities.create>[0]["aliases"]
      >[number],
    ],
    crossProject: false,
  });
  return result.id;
}
