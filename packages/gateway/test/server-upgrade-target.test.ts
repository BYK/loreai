import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestDatabaseDirectory } from "../../core/test/helpers/test-db-path";

async function upgrade(port: number, target: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Upgrade connection did not close"));
    }, 2000);
    socket.once("connect", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Upgrade connection failed"));
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

test.each(["//", "//?private-upgrade-sentinel"])(
  "a malformed Upgrade target %s never terminates the gateway",
  async (target) => {
    const directory = createTestDatabaseDirectory("upgrade-target");
    const child = spawn(
      process.execPath,
      [
        "--conditions=development",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import { loadConfig } from './packages/gateway/src/config.ts';
          import { startServer } from './packages/gateway/src/server.ts';
          const server = await startServer({ ...loadConfig(), hosts: ['127.0.0.1'], port: 0 });
          process.send({ type: 'ready', port: server.port });
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test",
          SENTRY_ENABLED: "0",
          LORE_DEBUG: "0",
          LORE_DB_PATH: join(directory, "lore.db"),
          HOME: join(directory, "home"),
          XDG_DATA_HOME: directory,
          XDG_CACHE_HOME: join(directory, "cache"),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    // Drain diagnostics without exporting request targets or exception content.
    child.stdout?.resume();
    child.stderr?.resume();
    const exited = new Promise<void>((resolve) => child.once("close", resolve));
    const ready = new Promise<number>((resolve, reject) => {
      child.once("error", () => reject(new Error("Gateway child failed")));
      child.once("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "ready" &&
          "port" in message &&
          typeof message.port === "number"
        ) {
          resolve(message.port);
        } else {
          reject(new Error("Gateway child did not publish a port"));
        }
      });
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const port = await Promise.race([
        ready,
        exited.then(() => {
          throw new Error("Gateway child exited before listener publication");
        }),
      ]);
      const initial = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(initial.status).toBe(200);
      await initial.arrayBuffer();

      const response = await upgrade(port, target);
      if (response === "") await exited;
      expect({ code: child.exitCode, signal: child.signalCode }).toEqual({
        code: null,
        signal: null,
      });
      expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
      expect(response.toLowerCase()).toContain("connection: close\r\n");
      expect(response.split("\r\n\r\n")[1]).toBe("");
      expect(response).not.toContain("private-upgrade-sentinel");

      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(health.status).toBe(200);
      await health.arrayBuffer();
      const legitimate = await upgrade(port, "/v1/responses");
      expect(legitimate).toMatch(/^HTTP\/1\.1 426 Upgrade Required\r\n/);
      expect(legitimate).toContain("websocket_not_supported");
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited;
    }
  },
  30_000,
);
