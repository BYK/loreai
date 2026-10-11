import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import { assertConverged, latencySamples, summarize } from "../stats.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { loadConfig, startServer } = require("../../gateway/dist/index.cjs");
const variantIndex = process.argv.indexOf("--variant");
const variant = variantIndex >= 0 ? process.argv[variantIndex + 1] : "fluid";
const allowedVariants = new Set(["fluid", "yjs", "automerge", "nocrdt"]);
if (!allowedVariants.has(variant))
  throw new Error(`Unknown variant: ${variant}`);
const nodeAgent =
  variant === "fluid"
    ? require("../dist/node-agent.cjs")
    : require(`../dist/${variant}-agent.cjs`);
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ??
    resolve(packageDir, "../../../spike-results"),
);
const participants = ["alice", "bob", "agent"];
const now = () => performance.timeOrigin + performance.now();
const pause = (ms) =>
  new Promise((resolvePause) => setTimeout(resolvePause, ms));
const log = (message) => console.log(`[fluid-spike] ${message}`);

async function waitUntil(time) {
  const delay = time - now();
  if (delay > 0) await pause(delay);
}

async function browserEdits(page, author, count, startAt, interval) {
  return page.evaluate(
    async ({ author, count, startAt, interval }) => {
      const clock = () => performance.timeOrigin + performance.now();
      const waitUntil = async (time) => {
        const delay = time - clock();
        if (delay > 0) {
          await new Promise((resolveWait) => setTimeout(resolveWait, delay));
        }
      };
      const edits = [];
      if (interval === 0) await waitUntil(startAt);
      for (let seq = 0; seq < count; seq += 1) {
        if (interval > 0) await waitUntil(startAt + seq * interval);
        const at = clock();
        edits.push(window.spike.append(author, `${author}#${seq}`, at));
      }
      return Promise.all(edits);
    },
    { author, count, startAt, interval },
  );
}

async function waitForBrowser(page) {
  await page.evaluate(() => window.spike.ready());
}

async function run(pages, gatewayPort, interval, runIndex) {
  const url =
    variant === "fluid"
      ? `http://127.0.0.1:${vitePort}/?port=${gatewayPort}`
      : `http://127.0.0.1:${vitePort}/spike.html?variant=${variant}&port=${gatewayPort}`;
  if (variant === "fluid") {
    await Promise.all(
      pages.map((page) =>
        page.addInitScript(() => {
          Object.defineProperty(window, "spike", {
            configurable: true,
            get() {
              const fluid = window.fluidSpike;
              if (!fluid) return undefined;
              return {
                create: (...args) => fluid.create(...args),
                load: (...args) => fluid.load(...args),
                share: (...args) => fluid.share(...args),
                append: (author, text, at) => fluid.append(author, text, at),
                observations: () =>
                  fluid.observations().map(({ reply, seenAt }) => ({
                    text: reply.text,
                    seen: seenAt,
                  })),
                finalState: () => fluid.finalState(),
                ready: async () => {
                  await pageWaitForFluid(fluid);
                },
                dispose: () => fluid.dispose(),
              };
            },
          });
          async function pageWaitForFluid(fluid) {
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline && fluid.connectionState() !== "2") {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (fluid.connectionState() !== "2")
              throw new Error("Fluid connection timeout");
          }
        }),
      ),
    );
  }
  await Promise.all(
    pages.map((page, index) =>
      page.goto(
        `${url}${url.includes("?") ? "&" : "?"}author=${participants[index]}`,
      ),
    ),
  );
  log(`run ${runIndex}, ${interval}ms: pages loaded`);
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(() => typeof window.spike?.create === "function", {
        timeout: 20_000,
      }),
    ),
  );
  const docId = await pages[0].evaluate(() => window.spike.create());
  await Promise.all(
    ["bob", "agent"].map((participant) =>
      pages[0].evaluate(({ id, name }) => window.spike.share(id, name), {
        id: docId,
        name: participant,
      }),
    ),
  );
  log(`run ${runIndex}: alice created ${docId}`);
  await Promise.all([
    pages[1].evaluate((currentId) => window.spike.load(currentId), docId),
    waitForBrowser(pages[0]),
  ]);
  await waitForBrowser(pages[0]);
  await waitForBrowser(pages[1]);
  log(`run ${runIndex}: browsers connected`);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const agent =
    variant === "fluid"
      ? await nodeAgent.joinDiscussion(docId, "agent")
      : await nodeAgent.joinDiscussion(gatewayUrl, docId, "agent");
  log(`run ${runIndex}: agent connected`);
  const shares = { alice: 67, bob: 67, agent: 66 };

  const browserState = async (page) =>
    page.evaluate(() => window.spike.finalState());
  const initialStates = await Promise.all([
    browserState(pages[0]),
    browserState(pages[1]),
    agent.state(),
  ]);
  if (initialStates.some((state) => state.length !== 0)) {
    throw new Error("Participants did not start with an empty discussion");
  }

  const startAt = now() + 2_000;
  log(`run ${runIndex}: T0=${startAt}`);
  const edits = [];
  const mutationRuns = [
    browserEdits(pages[0], "alice", shares.alice, startAt, interval),
    browserEdits(pages[1], "bob", shares.bob, startAt, interval),
    (async () => {
      if (interval === 0) await waitUntil(startAt);
      const localEdits = [];
      for (let seq = 0; seq < shares.agent; seq += 1) {
        if (interval > 0) await waitUntil(startAt + seq * interval);
        const at = now();
        const text = `agent#${seq}`;
        localEdits.push(
          variant === "nocrdt"
            ? await agent.append(text, "agent", at)
            : await agent.append(text, at),
        );
      }
      return localEdits;
    })(),
  ];
  edits.push(...(await Promise.all(mutationRuns)).flat());
  log(`run ${runIndex}: mutation complete (${edits.length})`);

  const deadline = now() + 30_000;
  while (now() < deadline) {
    const states = await Promise.all([
      browserState(pages[0]),
      browserState(pages[1]),
      agent.state(),
    ]);
    if (states.every((state) => state.length === 200)) break;
    await pause(10);
  }
  const stateValues = await Promise.all([
    browserState(pages[0]),
    browserState(pages[1]),
    agent.state(),
  ]);
  const finalStates = Object.fromEntries(
    participants.map((name, index) => [name, stateValues[index]]),
  );
  if (participants.some((name) => finalStates[name].length !== 200)) {
    throw new Error(`Fluid browser convergence timed out on run ${runIndex}`);
  }
  log(`run ${runIndex}: convergence complete`);

  const [aliceObservations, bobObservations] = await Promise.all(
    pages.map((page) => page.evaluate(() => window.spike.observations())),
  );
  const observations = [
    ...aliceObservations.map(({ text, seen }) => ({
      observer: "alice",
      text,
      seen,
    })),
    ...bobObservations.map(({ text, seen }) => ({
      observer: "bob",
      text,
      seen,
    })),
    ...agent.observations().map(({ text, seen }) => ({
      observer: "agent",
      text,
      seen,
    })),
  ];
  const samples = latencySamples(edits, observations, participants);
  assertConverged(finalStates, edits);
  const audiences = {
    alice:
      variant === "fluid"
        ? await pages[0].evaluate(() => window.fluidSpike.audience())
        : null,
    bob:
      variant === "fluid"
        ? await pages[1].evaluate(() => window.fluidSpike.audience())
        : null,
    agent: variant === "fluid" ? agent.audience() : null,
  };
  const convergenceMs =
    Math.max(...observations.map(({ seen }) => seen)) - startAt;
  await agent.close();
  return {
    run: runIndex,
    intervalMs: interval,
    startAt,
    convergenceMs,
    latency: summarize(samples),
    samples,
    edits,
    observations,
    finalStates,
    audiences,
  };
}

await mkdir(resultDir, { recursive: true });
process.env.LORE_FLUID_SPIKE = variant === "fluid" ? "1" : "0";
process.env.LORE_SPIKE_VARIANT = ["yjs", "automerge", "nocrdt"].includes(
  variant,
)
  ? variant
  : "";
process.env.LORE_LISTEN_HOST = "127.0.0.1";
process.env.LORE_LISTEN_PORT = "0";
process.env.LORE_REMOTE_GATEWAY = "0";
process.env.LORE_HOSTED_MODE = "0";
process.env.LORE_DB_PATH = resolve(resultDir, `${variant}-${process.pid}.db`);

const config = loadConfig();
config.hosts = ["127.0.0.1"];
config.port = 0;
config.remoteGateway = false;
config.hostedMode = false;

let gateway;
let vite;
let browser;
let pages = [];
let vitePort;
try {
  log("starting gateway");
  gateway = await startServer(config);
  await gateway.ready;
  process.env.LORE_FLUID_PORT = String(gateway.port);
  log(`gateway ready on ${gateway.port}`);
  vite = await createViteServer({
    root: packageDir,
    configFile: false,
    resolve:
      variant === "automerge"
        ? {
            alias: [
              {
                find: /^@automerge\/automerge$/,
                replacement: resolve(
                  dirname(
                    fileURLToPath(import.meta.resolve("@automerge/automerge")),
                  ),
                  "fullfat_base64.js",
                ),
              },
            ],
          }
        : undefined,
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  vitePort = vite.httpServer.address().port;
  log(`vite ready on ${vitePort}`);
  browser = await chromium.launch({ headless: true });
  pages = await Promise.all([browser.newPage(), browser.newPage()]);
  for (const page of pages) page.setDefaultTimeout(25_000);
  log("chromium ready");
  const runCount = Number(process.env.SPIKE_RUNS ?? 5);
  const normalRuns = [];
  const burstRuns = [];
  for (let index = 0; index < runCount; index += 1) {
    normalRuns.push(await run(pages, gateway.port, 5, index + 1));
  }
  for (let index = 0; index < runCount; index += 1) {
    burstRuns.push(await run(pages, gateway.port, 0, index + 1));
  }
  const report = {
    variant,
    node: process.version,
    gatewayPort: gateway.port,
    normalRuns,
    normalPooled: summarize(normalRuns.flatMap((result) => result.samples)),
    burstRuns,
    burstPooled: summarize(burstRuns.flatMap((result) => result.samples)),
  };
  const path = resolve(resultDir, `convergence-${variant}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      path,
      normalPooled: report.normalPooled,
      burstPooled: report.burstPooled,
    }),
  );
} finally {
  log("stopping services");
  await Promise.all(
    pages.map((page) =>
      page.evaluate(() => window.spike?.dispose()).catch(() => {}),
    ),
  );
  log("browser clients disposed");
  await browser?.close();
  log("chromium stopped");
  await vite?.close();
  log("vite stopped");
  await gateway?.stop();
  log("gateway stopped");
}
