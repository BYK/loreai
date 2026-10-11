import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const packageDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageDir, "../..");
const mainRoot =
  process.env.LORE_SPIKE_MAIN_DIR ?? resolve(repoRoot, "../loreai-main");
const gcHook = resolve(packageDir, "src/gc-hook.cjs");

export async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to reserve a loopback port");
  }
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

export function gatewayRootFor(variant) {
  return variant === "main" ? mainRoot : repoRoot;
}

export function spawnGateway({ variant, port, dbPath }) {
  const root = gatewayRootFor(variant);
  const gatewayDir = resolve(root, "packages/gateway");
  const binPath = resolve(gatewayDir, "dist/bin.cjs");
  const env = {
    ...process.env,
    LORE_DB_PATH: dbPath,
    LORE_DATA_DIR: resolve(dbPath, ".."),
    LORE_LISTEN_PORT: String(port),
    LORE_REMOTE_GATEWAY: "0",
    LORE_HOSTED_MODE: "0",
    NODE_ENV: "production",
  };
  delete env.LORE_SPIKE_VARIANT;
  delete env.LORE_FLUID_SPIKE;
  if (["yjs", "automerge", "nocrdt"].includes(variant)) {
    env.LORE_SPIKE_VARIANT = variant;
  } else if (variant === "fluid") {
    env.LORE_FLUID_SPIKE = "1";
    env.LORE_FLUID_PORT = String(port);
    env.LORE_FLUID_DOMAIN = "http://127.0.0.1";
  }
  const child = fork(binPath, ["start", "--port", String(port), "--local"], {
    cwd: root,
    env,
    execArgv: ["--expose-gc", "--require", gcHook],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let nextGcId = 0;
  const gcWaiters = new Map();
  child.on("message", (message) => {
    if (message?.type !== "gc-complete") return;
    const resolveWaiter = gcWaiters.get(message.id);
    if (!resolveWaiter) return;
    gcWaiters.delete(message.id);
    resolveWaiter(message);
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-32_000);
    });
  }
  const url = `http://127.0.0.1:${port}`;
  const startedAt = performance.now();
  return {
    child,
    url,
    startedAt,
    output: () => output,
    collectGarbage() {
      const id = ++nextGcId;
      return new Promise((resolveGc, rejectGc) => {
        const timeout = setTimeout(() => {
          gcWaiters.delete(id);
          rejectGc(new Error("Gateway did not acknowledge forced GC"));
        }, 5000);
        gcWaiters.set(id, (message) => {
          clearTimeout(timeout);
          if (message.error) {
            rejectGc(new Error(message.error));
            return;
          }
          resolveGc(message);
        });
        child.send({ type: "force-gc", id });
      });
    },
    async waitForHealth(timeoutMs = 30_000) {
      while (performance.now() - startedAt < timeoutMs) {
        if (child.exitCode !== null) {
          throw new Error(
            `Gateway exited ${child.exitCode} before health check:\n${output}`,
          );
        }
        try {
          const response = await fetch(`${url}/health`, {
            signal: AbortSignal.timeout(1_000),
          });
          if (response.status === 200) return performance.now();
        } catch {}
        await new Promise((resolvePause) => setTimeout(resolvePause, 5));
      }
      throw new Error(`Gateway health check timed out:\n${output}`);
    },
    async stop(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      const exited = new Promise((resolveExit) =>
        child.once("exit", resolveExit),
      );
      let timeoutId;
      const timeout = new Promise((resolveTimeout) => {
        timeoutId = setTimeout(resolveTimeout, 10_000);
      });
      await Promise.race([exited, timeout]);
      clearTimeout(timeoutId);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolveExit) => child.once("exit", resolveExit));
      }
    },
  };
}

export async function processRssBytes(pid) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  if (!match) throw new Error(`RSS unavailable for process ${pid}`);
  return Number(match[1]) * 1024;
}
