import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { TestProject } from "vitest/node";

interface RootSnapshot {
  providedRoot: string | null;
  roots: Array<{
    path: string;
    entries: string[];
  }>;
}

async function inspectRoot(
  path: string,
): Promise<RootSnapshot["roots"][number]> {
  const entries = existsSync(path)
    ? (await readdir(path)).filter((entry) => entry !== ".lore-owned-root")
    : [];
  return { path, entries: entries.sort() };
}

export default function setup(project: TestProject): () => Promise<void> {
  return async () => {
    const marker = process.env.LORE_TEST_ISOLATION_OBSERVER;
    if (!marker) return;

    const providedRoot = project.getProvidedContext().loreTestRoot ?? null;
    const roots = providedRoot
      ? [await inspectRoot(providedRoot)]
      : await Promise.all(
          (await readdir(tmpdir(), { withFileTypes: true }))
            .filter(
              (entry) =>
                entry.isDirectory() &&
                entry.name.startsWith("lore-test-") &&
                !entry.name.startsWith("lore-test-isolation-harness-"),
            )
            .map((entry) => inspectRoot(join(tmpdir(), entry.name))),
        );
    const snapshot: RootSnapshot = {
      providedRoot,
      roots: roots.sort((left, right) =>
        basename(left.path).localeCompare(basename(right.path)),
      ),
    };
    await writeFile(marker, JSON.stringify(snapshot));
  };
}
