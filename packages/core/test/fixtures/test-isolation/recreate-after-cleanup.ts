import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

export default function setup(project: TestProject): () => Promise<void> {
  return async () => {
    const marker = process.env.LORE_TEST_ISOLATION_RECREATE_MARKER;
    if (!marker) return;

    const root = project.getProvidedContext().loreTestRoot;
    const directory = join(root, "after-global-teardown");
    const artifact = join(directory, "test.db-wal");
    await mkdir(directory, { recursive: true });
    await writeFile(artifact, "late artifact");
    await writeFile(
      marker,
      JSON.stringify({ root, artifact, artifactExists: existsSync(artifact) }),
    );
  };
}
