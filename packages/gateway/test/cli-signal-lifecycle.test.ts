/**
 * Real-process signal lifecycle regressions.
 *
 * Unit tests cannot catch the interval between publishing the listener/PID
 * record and installing signal handlers. These tests signal the production
 * bundle at that externally observable boundary and exercise the complete
 * gateway teardown path.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const BUNDLE = resolve(process.cwd(), "packages/gateway/dist/bin.cjs");
const TEST_TIMEOUT_MS = 30_000;
const children = new Set<ChildProcess>();
const sockets = new Set<Socket>();
const tempDirs = new Set<string>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  children.clear();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    [...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.clear();
});

function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("gateway did not exit after shutdown request"));
    }, TEST_TIMEOUT_MS - 1000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

function testEnvironment(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    LORE_DB_PATH: join(dir, "lore.db"),
    XDG_DATA_HOME: dir,
    LORE_NO_UPDATE_CHECK: "1",
    SENTRY_ENABLED: "0",
  };
}

describe.skipIf(process.platform === "win32")(
  "bundled CLI signal lifecycle",
  () => {
    test(
      "SIGTERM at listener publication enters the full shutdown path",
      async () => {
        if (!existsSync(BUNDLE)) {
          throw new Error(
            `Bundle not found at ${BUNDLE} — run the gateway bundle first.`,
          );
        }

        const dir = await mkdtemp(join(tmpdir(), "lore-signal-lifecycle-"));
        tempDirs.add(dir);
        const child = spawn(
          process.execPath,
          [BUNDLE, "start", "--local", "--port", "0"],
          {
            env: testEnvironment(dir),
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        children.add(child);

        let stdout = "";
        let stderr = "";
        let signalSent = false;
        let recordedPid: number | undefined;
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (!signalSent && stdout.includes("Gateway listening")) {
            signalSent = true;
            const record = JSON.parse(
              readFileSync(join(dir, "lore", "gateway.pid"), "utf8"),
            ) as { pid: number };
            recordedPid = record.pid;
            child.kill("SIGTERM");
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        const outcome = await waitForExit(child);
        children.delete(child);

        expect(signalSent).toBe(true);
        expect(recordedPid).toBe(child.pid);
        expect(stderr).toContain("Shutting down");
        expect(outcome).toEqual({ code: 143, signal: null });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "authenticated shutdown closes a stalled partial HTTP connection",
      async () => {
        if (!existsSync(BUNDLE)) throw new Error("Gateway bundle is required");
        const dir = await mkdtemp(join(tmpdir(), "lore-control-shutdown-"));
        tempDirs.add(dir);
        const child = spawn(
          process.execPath,
          [BUNDLE, "start", "--local", "--port", "0"],
          {
            env: {
              ...testEnvironment(dir),
              LORE_SHUTDOWN_TIMEOUT_MS: "500",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        children.add(child);

        let stdout = "";
        let stderr = "";
        let requestStarted = false;
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (requestStarted || !stdout.includes("Gateway listening")) return;
          requestStarted = true;
          const record = JSON.parse(
            readFileSync(join(dir, "lore", "gateway.pid"), "utf8"),
          ) as { port: number; token: string };
          const socket = connect(record.port, "127.0.0.1", () => {
            socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
            const req = request({
              host: "127.0.0.1",
              port: record.port,
              path: "/_lore/control",
              method: "POST",
              headers: { authorization: `Bearer ${record.token}` },
            });
            req.on("error", () => {});
            req.end();
          });
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        const outcome = await waitForExit(child);
        children.delete(child);

        expect(requestStarted).toBe(true);
        expect(stderr).toContain("Shutting down");
        expect(outcome).toEqual({ code: 0, signal: null });
        expect(sockets.size).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
