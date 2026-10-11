import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { summarize } from "../stats.mjs";
import {
  processRssBytes,
  reserveLoopbackPort,
  spawnGateway,
} from "./gateway-process.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ?? resolve(repoRoot, "../spike-results"),
);
const variants = ["main", "off", "yjs", "automerge", "nocrdt", "fluid"];
const variantIndex = process.argv.indexOf("--variant");
const selected =
  variantIndex >= 0 ? [process.argv[variantIndex + 1]] : variants;
const samplesIndex = process.argv.indexOf("--samples");
const sampleCount =
  samplesIndex >= 0 ? Number(process.argv[samplesIndex + 1]) : 20;
const allowed = new Set(variants);
for (const variant of selected) {
  if (!allowed.has(variant)) throw new Error(`Unknown variant: ${variant}`);
}
if (!Number.isInteger(sampleCount) || sampleCount < 1) {
  throw new Error("--samples must be a positive integer");
}

await mkdir(resultDir, { recursive: true });
const outputPath = resolve(resultDir, "startup-rss.json");
let report = {};
try {
  const existing = await (
    await import("node:fs/promises")
  ).readFile(outputPath, "utf8");
  report = JSON.parse(existing);
} catch {}

async function withGateway(variant, action) {
  const dataDir = await mkdtemp(resolve(resultDir, `.startup-${variant}-`));
  const dbPath = resolve(dataDir, "gateway.db");
  const port = await reserveLoopbackPort();
  const gateway = spawnGateway({ variant, port, dbPath });
  try {
    const readyAt = await gateway.waitForHealth();
    return await action({ gateway, readyAt, port });
  } finally {
    await gateway.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function rssAfterGc(gateway) {
  const rawRssBytes = await processRssBytes(gateway.child.pid);
  const collected = await gateway.collectGarbage();
  return {
    rawRssBytes,
    postGcRssBytes: collected.rssBytes,
    heapUsedBytes: collected.heapUsedBytes,
    gcCalls: 2,
  };
}

async function startupSample(variant) {
  return withGateway(variant, ({ gateway, readyAt }) => {
    return readyAt - gateway.startedAt;
  });
}

async function runEdits(variant, gatewayUrl, port) {
  const require = createRequire(import.meta.url);
  const modulePath =
    variant === "fluid"
      ? resolve(packageDir, "dist/node-agent.cjs")
      : resolve(packageDir, `dist/${variant}-agent.cjs`);
  const agentModule = require(modulePath);
  let client;
  if (variant === "fluid") {
    process.env.LORE_FLUID_PORT = String(port);
    process.env.LORE_FLUID_DOMAIN = "http://127.0.0.1";
    const created = await agentModule.createDiscussion("alice");
    client = created.participant;
    for (let index = 0; index < 200; index += 1) {
      client.append(`startup-${index}`);
    }
  } else {
    client = await agentModule.createDiscussion(gatewayUrl, "alice");
    for (let index = 0; index < 200; index += 1) {
      await client.append(`startup-${index}`);
    }
  }
  const deadline = performance.now() + 10_000;
  while (client.state().length < 200 && performance.now() < deadline) {
    await new Promise((resolvePause) => setTimeout(resolvePause, 20));
  }
  if (client.state().length < 200) {
    throw new Error(
      `${variant} only observed ${client.state().length} of 200 startup edits`,
    );
  }
  await new Promise((resolvePause) => setTimeout(resolvePause, 250));
  await client.close();
}

for (const variant of selected) {
  const startupSamples = [];
  let warmupMs;
  try {
    warmupMs = await startupSample(variant);
    for (let index = 0; index < sampleCount; index += 1) {
      startupSamples.push(await startupSample(variant));
    }
    const rss = await withGateway(
      variant,
      async ({ gateway, readyAt, port }) => {
        await new Promise((resolvePause) => setTimeout(resolvePause, 10_000));
        const afterReady = await rssAfterGc(gateway);
        if (["yjs", "automerge", "nocrdt", "fluid"].includes(variant)) {
          await runEdits(variant, gateway.url, port);
          const after200Edits = await rssAfterGc(gateway);
          return {
            afterReady,
            after200Edits,
            readyAtMs: readyAt,
            edits: 200,
          };
        }
        return {
          afterReady,
          after200Edits: null,
          after200EditsUnavailable:
            "The baseline gateway does not expose a shared-document edit endpoint.",
          readyAtMs: readyAt,
          edits: null,
        };
      },
    );
    const summary = summarize(startupSamples);
    report[variant] = {
      warmupMs,
      sampleCount,
      samplesMs: startupSamples,
      startup: {
        medianMs: summary.p50,
        p95Ms: summary.p95,
        summary,
        healthPollIntervalMs: 5,
      },
      rss,
    };
    const mainMedian = report.main?.startup?.medianMs;
    report[variant].deltaVsMainMs =
      typeof mainMedian === "number" ? summary.p50 - mainMedian : null;
  } catch (error) {
    report[variant] = {
      sampleCount,
      samplesMs: startupSamples,
      error: error instanceof Error ? error.message : String(error),
    };
    await writeFile(
      resolve(resultDir, `startup-${variant}.log`),
      `${report[variant].error}\n`,
    );
  }
}

if (typeof report.main?.startup?.medianMs === "number") {
  for (const result of Object.values(report)) {
    if (result?.startup) {
      result.deltaVsMainMs =
        result.startup.medianMs - report.main.startup.medianMs;
    }
  }
}

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ path: outputPath, report }, null, 2));
