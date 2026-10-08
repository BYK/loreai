import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { waitForAgentProcess } from "./agent-process.mjs";

describe("waitForAgentProcess", () => {
  it("settles promptly when the agent executable is unavailable", async () => {
    const child = spawn("/definitely/not/an/agent", [], { stdio: "ignore" });
    await expect(waitForAgentProcess(child, 60_000)).resolves.toEqual({
      code: 1,
      timedOut: false,
    });
  });
});
