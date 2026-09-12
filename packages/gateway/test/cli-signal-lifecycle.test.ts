/**
 * Real-process signal lifecycle regressions.
 *
 * Unit tests of the shutdown callback cannot catch gaps before the callback is
 * installed. These tests spawn the production bundle and deliver a real POSIX
 * signal at the earliest externally-observable publication point.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";

const BUNDLE = resolve(process.cwd(), "packages/gateway/dist/bin.cjs");
const SUPERVISOR = resolve(
  process.cwd(),
  "packages/gateway/dist/supervisor.cjs",
);
const TEST_TIMEOUT_MS = 30_000;
const children = new Set<ReturnType<typeof spawn>>();
const servers = new Set<ReturnType<typeof createServer>>();
const blockingSockets = new Set<Socket>();
const childProcessGroups = new Set<number>();
const tempDirs = new Set<string>();

function forceStopProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function directChildPid(parentPid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  const childrenPath = `/proc/${parentPid}/task/${parentPid}/children`;
  if (!existsSync(childrenPath)) return undefined;
  const pid = Number(readFileSync(childrenPath, "utf8").trim().split(" ")[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        const statPath = `/proc/${pid}/stat`;
        if (
          !existsSync(statPath) ||
          readFileSync(statPath, "utf8").split(" ")[2] === "Z"
        ) {
          return;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`process ${pid} remained alive after its supervisor exited`);
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  children.clear();
  for (const pid of childProcessGroups) forceStopProcessGroup(pid);
  childProcessGroups.clear();
  for (const socket of blockingSockets) socket.destroy();
  blockingSockets.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
  await Promise.all(
    [...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.clear();
});

describe.skipIf(process.platform === "win32")(
  "bundled CLI signal lifecycle",
  () => {
    test(
      "supervised startup errors do not stay alive on the IPC channel",
      async () => {
        if (!existsSync(BUNDLE)) throw new Error("Gateway bundle is required");
        const blocker = createServer();
        servers.add(blocker);
        blocker.on("connection", (socket) => {
          blockingSockets.add(socket);
          socket.once("close", () => blockingSockets.delete(socket));
        });
        await new Promise<void>((resolveListen, reject) => {
          blocker.once("error", reject);
          blocker.listen(0, "127.0.0.1", resolveListen);
        });
        const address = blocker.address();
        if (!address || typeof address === "string") {
          blocker.close();
          throw new Error("failed to allocate occupied test port");
        }
        const dir = await mkdtemp(join(tmpdir(), "lore-startup-error-"));
        tempDirs.add(dir);
        const child = spawn(
          process.execPath,
          [BUNDLE, "start", "--local", "--port", String(address.port)],
          {
            env: {
              ...process.env,
              NODE_ENV: "test",
              LORE_DB_PATH: join(dir, "lore.db"),
              XDG_DATA_HOME: dir,
              LORE_NO_UPDATE_CHECK: "1",
              SENTRY_ENABLED: "0",
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        children.add(child);
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        const code = await new Promise<number | null>((resolveExit, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("startup error was held open by supervision IPC"));
          }, 5000);
          child.on("error", reject);
          child.on("close", (exitCode) => {
            clearTimeout(timer);
            resolveExit(exitCode);
          });
        });
        children.delete(child);
        for (const socket of blockingSockets) socket.destroy();
        await new Promise<void>((resolveClose) =>
          blocker.close(() => resolveClose()),
        );
        servers.delete(blocker);

        expect(code).toBe(1);
        expect(stderr).toContain("already in use");
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "SIGTERM at listener publication enters Lore's shutdown path",
      async () => {
        if (!existsSync(BUNDLE)) {
          throw new Error(
            `Bundle not found at ${BUNDLE} — run \`pnpm --filter @loreai/gateway run bundle\` first.`,
          );
        }

        const dir = await mkdtemp(join(tmpdir(), "lore-signal-lifecycle-"));
        tempDirs.add(dir);
        const child = spawn(
          process.execPath,
          [BUNDLE, "start", "--bg=false", "--local", "--port", "0"],
          {
            env: {
              ...process.env,
              NODE_ENV: "test",
              LORE_DB_PATH: join(dir, "lore.db"),
              XDG_DATA_HOME: dir,
              LORE_NO_UPDATE_CHECK: "1",
              SENTRY_ENABLED: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        children.add(child);

        let stdout = "";
        let stderr = "";
        let signalSent = false;
        let recordedPid: number | undefined;
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (!signalSent && stdout.includes("Gateway listening")) {
            signalSent = true;
            const record = JSON.parse(
              readFileSync(join(dir, "lore", "gateway.pid"), "utf8"),
            ) as { pid: number };
            recordedPid = record.pid;
            const gatewayPid = child.pid
              ? directChildPid(child.pid)
              : undefined;
            if (gatewayPid) childProcessGroups.add(gatewayPid);
            child.kill("SIGTERM");
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        const outcome = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolveExit, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("gateway did not exit after SIGTERM"));
          }, TEST_TIMEOUT_MS - 1000);
          child.on("error", reject);
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolveExit({ code, signal });
          });
        });
        children.delete(child);
        if (recordedPid) {
          const gatewayPid = directChildPid(recordedPid);
          if (gatewayPid) childProcessGroups.delete(gatewayPid);
        }

        expect(signalSent).toBe(true);
        // The published process boundary must be the independently responsive
        // supervisor, not the potentially stalled server child.
        expect(recordedPid).toBe(child.pid);
        expect(stderr).toContain("Shutting down");
        expect(outcome).toEqual({ code: 143, signal: null });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the independent supervisor kills a main-thread-stalled gateway at the deadline",
      async () => {
        if (!existsSync(SUPERVISOR)) {
          throw new Error(
            `Supervisor not found at ${SUPERVISOR} — run the gateway bundle first.`,
          );
        }
        const blockedChild = [
          'require("node:fs").writeSync(1, `BLOCKED_GATEWAY_READY:${process.pid}\\n`)',
          "while (true) {}",
        ].join(";");
        const runner = [
          `const { runGatewaySupervisor } = require(${JSON.stringify(SUPERVISOR)})`,
          `runGatewaySupervisor({ childArgs: ["-e", ${JSON.stringify(blockedChild)}], deadlineMs: 100 }).then((code) => { process.exitCode = code })`,
        ].join(";");
        const child = spawn(process.execPath, ["-e", runner], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.add(child);

        let stdout = "";
        let stderr = "";
        let signalSentAt = 0;
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          const match = stdout.match(/BLOCKED_GATEWAY_READY:(\d+)/);
          if (match) childProcessGroups.add(Number(match[1]));
          if (!signalSentAt && match) {
            signalSentAt = Date.now();
            child.kill("SIGTERM");
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        const outcome = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolveExit, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("supervisor did not enforce its hard deadline"));
          }, 5000);
          child.on("error", reject);
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolveExit({ code, signal });
          });
        });
        children.delete(child);
        const gatewayPid = Number(
          stdout.match(/BLOCKED_GATEWAY_READY:(\d+)/)?.[1],
        );
        if (gatewayPid) childProcessGroups.delete(gatewayPid);

        expect(signalSentAt).toBeGreaterThan(0);
        expect(Date.now() - signalSentAt).toBeLessThan(3000);
        expect(stderr).toContain("supervisor is forcing exit");
        expect(outcome).toEqual({ code: 137, signal: null });
      },
      TEST_TIMEOUT_MS,
    );

    test.runIf(process.platform === "linux")(
      "supervisor death cannot orphan a main-thread-stalled gateway",
      async () => {
        if (!existsSync(SUPERVISOR)) {
          throw new Error(
            `Supervisor not found at ${SUPERVISOR} — run the gateway bundle first.`,
          );
        }
        const watchedChild = [
          `const { initializeSupervisedGatewayChild } = require(${JSON.stringify(SUPERVISOR)})`,
          "initializeSupervisedGatewayChild()",
          'require("node:fs").writeSync(1, `WATCHED_GATEWAY_READY:${process.pid}\\n`)',
          "while (true) {}",
        ].join(";");
        const runner = [
          `const { runGatewaySupervisor } = require(${JSON.stringify(SUPERVISOR)})`,
          `runGatewaySupervisor({ childArgs: ["-e", ${JSON.stringify(watchedChild)}], deadlineMs: 100 }).then((code) => { process.exitCode = code })`,
        ].join(";");
        const child = spawn(process.execPath, ["-e", runner], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.add(child);

        let stdout = "";
        let gatewayPid = 0;
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          const match = stdout.match(/WATCHED_GATEWAY_READY:(\d+)/);
          if (match && gatewayPid === 0) {
            gatewayPid = Number(match[1]);
            childProcessGroups.add(gatewayPid);
            child.kill("SIGKILL");
          }
        });

        await new Promise<void>((resolveExit, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("supervisor child did not become ready"));
          }, 5000);
          child.on("error", reject);
          child.on("close", () => {
            clearTimeout(timer);
            resolveExit();
          });
        });
        children.delete(child);

        expect(gatewayPid).toBeGreaterThan(0);
        await waitForProcessExit(gatewayPid);
        childProcessGroups.delete(gatewayPid);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "authenticated control shutdown arms the production supervisor deadline",
      async () => {
        if (!existsSync(BUNDLE) || !existsSync(SUPERVISOR)) {
          throw new Error("Gateway bundles are required for this test");
        }
        const dir = await mkdtemp(join(tmpdir(), "lore-control-shutdown-"));
        tempDirs.add(dir);
        const runner = [
          `const { runGatewaySupervisor } = require(${JSON.stringify(SUPERVISOR)})`,
          `runGatewaySupervisor({ childArgs: [${JSON.stringify(BUNDLE)}, "start", "--local", "--port", "0"], deadlineMs: 100, env: process.env }).then((code) => { process.exitCode = code })`,
        ].join(";");
        const child = spawn(process.execPath, ["-e", runner], {
          env: {
            ...process.env,
            NODE_ENV: "test",
            LORE_DB_PATH: join(dir, "lore.db"),
            XDG_DATA_HOME: dir,
            LORE_NO_UPDATE_CHECK: "1",
            LORE_SHUTDOWN_TIMEOUT_MS: "1000",
            SENTRY_ENABLED: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.add(child);

        let stdout = "";
        let stderr = "";
        let stalledSocket: Socket | undefined;
        let requestStarted = false;
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (requestStarted || !stdout.includes("Gateway listening")) return;
          requestStarted = true;
          const record = JSON.parse(
            readFileSync(join(dir, "lore", "gateway.pid"), "utf8"),
          ) as { port: number; token: string };
          const gatewayPid = child.pid ? directChildPid(child.pid) : undefined;
          if (gatewayPid) childProcessGroups.add(gatewayPid);
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
          stalledSocket = socket;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        const outcome = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolveExit, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("authenticated shutdown did not exit"));
          }, 5000);
          child.on("error", reject);
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolveExit({ code, signal });
          });
        });
        children.delete(child);
        stalledSocket?.destroy();

        expect(requestStarted).toBe(true);
        expect(stderr).toContain("supervisor is forcing exit");
        expect(outcome).toEqual({ code: 137, signal: null });
      },
      TEST_TIMEOUT_MS,
    );
  },
);
