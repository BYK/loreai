import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { loadConfig, startServer } = require("../../gateway/dist/index.cjs");
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ??
    resolve(packageDir, "../../../spike-results"),
);
const port = 0;

await mkdir(resultDir, { recursive: true });
process.env.LORE_FLUID_SPIKE = "1";
process.env.LORE_LISTEN_HOST = "127.0.0.1";
process.env.LORE_LISTEN_PORT = String(port);
process.env.LORE_REMOTE_GATEWAY = "0";
process.env.LORE_HOSTED_MODE = "0";
process.env.LORE_DB_PATH = resolve(resultDir, `fluid-cjs-${process.pid}.db`);

const config = loadConfig();
config.hosts = ["127.0.0.1"];
config.port = port;
config.remoteGateway = false;
config.hostedMode = false;

let gateway;
try {
  gateway = await startServer(config);
  await gateway.ready;
  const child = spawn(process.execPath, ["src/node-bench.mjs"], {
    cwd: packageDir,
    env: {
      ...process.env,
      LORE_FLUID_PORT: String(gateway.port),
      SPIKE_RUNS: process.env.SPIKE_RUNS ?? "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`Node benchmark exited from ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  const logPath = resolve(resultDir, "fluid-node-cjs-convergence.log");
  await writeFile(
    logPath,
    `${Buffer.concat(stdout).toString()}${stderr.length ? `\n--- stderr ---\n${Buffer.concat(stderr).toString()}` : ""}`,
  );
  if (exitCode !== 0) {
    throw new Error(`Node CJS convergence exited ${exitCode}; see ${logPath}`);
  }
  console.log(
    JSON.stringify({
      variant: "fluid-node-cjs-agent",
      gatewayPort: gateway.port,
      exitCode,
      logPath,
      resultsPath: resolve(resultDir, "fluid-node-cjs-convergence.json"),
    }),
  );
} finally {
  await gateway?.stop();
}
