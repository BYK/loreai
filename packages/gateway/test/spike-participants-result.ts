import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeParticipantResult(
  variant: string,
  result: Record<string, unknown>,
): Promise<void> {
  const directory = process.env.SPIKE_RESULTS_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `participants-${variant}.json`),
    `${JSON.stringify({ variant, ...result }, null, 2)}\n`,
  );
}
