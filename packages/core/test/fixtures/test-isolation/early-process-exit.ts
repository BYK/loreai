import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject): Promise<void> {
  const marker = process.env.LORE_TEST_ISOLATION_PROCESS_EXIT_MARKER;
  if (!marker) return;

  const root = project.getProvidedContext().loreTestRoot;
  const directory = join(root, "before-process-exit");
  const artifact = join(directory, "test.db-wal");
  await mkdir(directory, { recursive: true });
  await writeFile(artifact, "early-exit artifact");

  const pendingMarker = `${marker}.pending`;
  await writeFile(pendingMarker, JSON.stringify({ root, artifact }));
  await rename(pendingMarker, marker);
  process.exit(37);
}
