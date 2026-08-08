import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("replays growing fixed-history prefixes and scores the final answer", async () => {
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
    headers: { sessionID?: string; project?: string };
  }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body) as Omit<
        (typeof requests)[number],
        "headers"
      >;
      requests.push({
        ...payload,
        headers: {
          sessionID: request.headers["x-lore-session-id"],
          project: request.headers["x-lore-project"],
        },
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: requests.length === 5 ? "Answer: blue" : "ACK",
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server did not bind");
  const root = mkdtempSync(path.join(os.tmpdir(), "oolong-run-"));
  dirs.push(root);
  const fixture = path.join(import.meta.dirname, "oolong.fixture.jsonl");
  const output = path.join(root, "result.jsonl");

  const command = [
    "packages/core/eval/oolong-run.ts",
    "--input",
    fixture,
    "--output",
    output,
    "--endpoint",
    `http://127.0.0.1:${address.port}/v1/chat/completions`,
    "--arm",
    "nolore",
    "--model",
    "fixture",
    "--chunk-chars",
    "20",
    "--run-id",
    "fixture-run",
  ];
  const child = spawn("bun", command, { cwd: process.cwd() });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));

  expect(exitCode).toBe(0);
  expect(requests.map((request) => request.messages.length)).toEqual([
    2, 4, 6, 8, 10,
  ]);
  expect(requests[3].messages[2]).toEqual({
    role: "assistant",
    content: "ACK",
  });
  expect(
    new Set(requests.map((request) => request.headers.sessionID)).size,
  ).toBe(1);
  expect(requests[0].headers.sessionID).toMatch(/^oolong-[a-f0-9]{32}$/);
  expect(new Set(requests.map((request) => request.headers.project))).toEqual(
    new Set([
      `/tmp/lore-eval/oolong/fixture-run/nolore/${requests[0].headers.sessionID}`,
    ]),
  );
  const result = JSON.parse(readFileSync(output, "utf8"));
  expect(result).toMatchObject({
    arm: "nolore",
    runID: "fixture-run",
    sessionID: requests[0].headers.sessionID,
    score: 1,
    chunks: 4,
  });
});
