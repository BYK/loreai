import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runVerifierProcess } from "./verifier.mjs";

function failedSpawn() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { end(): void };
    stdout: EventEmitter;
    kill(): void;
  };
  child.stdin = { end() {} };
  child.stdout = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => child.emit("error", new Error("spawn python3 ENOENT")));
  return child;
}

describe("runVerifierProcess", () => {
  it("settles when the verifier process fails to spawn without emitting exit", async () => {
    const result = await runVerifierProcess({
      spawn: failedSpawn,
      verifier: "print('unused')",
      checkpoint: "checkpoint-1",
      scope: "core",
      project: "/project",
      image: "python:3.12-alpine",
      facts: {},
      timeoutMs: 10,
    });

    expect(result).toEqual({
      passed: false,
      error: "verifier failed to start: spawn python3 ENOENT",
    });
  });
});
