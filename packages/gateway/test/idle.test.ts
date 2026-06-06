/**
 * Tests for buildIdleWorkHandler project isolation.
 *
 * The idle handler tests require mock.module("@loreai/core", ...) which
 * pollutes the module cache for the entire Bun process. To avoid breaking
 * other test files (e.g. cache-warmer.test.ts which also imports @loreai/core),
 * we run the actual tests in a subprocess via `bun test`.
 */
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const WORKER_PATH = join(import.meta.dir, "helpers", "idle-worker.ts");

describe("buildIdleWorkHandler", () => {
  test("uses state.projectPath for all core operations", async () => {
    const result = await runIsolatedTests();
    if (result.exitCode !== 0) {
      // Print the subprocess output for debugging
      console.error(result.stderr);
      console.log(result.stdout);
    }
    expect(result.exitCode).toBe(0);
  });
});

/**
 * Run the idle worker test file in an isolated Bun subprocess.
 */
async function runIsolatedTests(): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = spawn("bun", ["test", WORKER_PATH], {
    env: { ...process.env, NODE_ENV: "test" },
    // Explicit stdio: ignore stdin (we don't need to write to the child),
    // pipe stdout/stderr so we can capture them as strings.
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!proc.stdout || !proc.stderr) {
    throw new Error("Failed to capture subprocess output streams");
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    streamToString(proc.stdout),
    streamToString(proc.stderr),
    new Promise<number>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code) => resolve(code ?? 1));
    }),
  ]);
  return { exitCode, stdout, stderr };
}

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.once("error", reject);
  });
}
