import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { assertConverged, latencySamples, summarize } from "../stats.mjs";

const require = createRequire(import.meta.url);
const {
  createDiscussion,
  joinDiscussion,
  shareDiscussion,
} = require("../dist/node-agent.cjs");
const participants = ["alice", "bob", "agent"];
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ?? "../../../spike-results",
);

const now = () => performance.timeOrigin + performance.now();
const waitUntil = async (time) => {
  const delay = time - now();
  if (delay > 0)
    await new Promise((resolveWait) => setTimeout(resolveWait, delay));
};

async function run(interval, runIndex) {
  const { id, participant: alice } = await createDiscussion("alice");
  await Promise.all(
    ["bob", "agent"].map((participant) =>
      shareDiscussion(id, "alice", participant),
    ),
  );
  const bob = await joinDiscussion(id, "bob");
  const agent = await joinDiscussion(id, "agent");
  const clients = { alice, bob, agent };
  if (participants.some((name) => clients[name].state().length !== 0)) {
    throw new Error("Participants did not start with an empty discussion");
  }

  const startAt = now() + 2_000;
  const shares = { alice: 67, bob: 67, agent: 66 };
  const edits = [];
  await Promise.all(
    participants.map(async (author) => {
      const client = clients[author];
      if (interval === 0) await waitUntil(startAt);
      for (let seq = 0; seq < shares[author]; seq += 1) {
        if (interval > 0) await waitUntil(startAt + seq * interval);
        edits.push(client.append(`${author}#${seq}`));
      }
    }),
  );

  const deadline = now() + 30_000;
  while (
    participants.some((name) => clients[name].state().length !== 200) &&
    now() < deadline
  ) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const finalStates = Object.fromEntries(
    participants.map((name) => [name, clients[name].state()]),
  );
  if (participants.some((name) => finalStates[name].length !== 200)) {
    throw new Error(`Fluid convergence timed out on run ${runIndex}`);
  }

  const observations = participants.flatMap((observer) =>
    clients[observer].observations().map((sample) => ({
      observer,
      text: sample.text,
      seen: sample.seen,
    })),
  );
  const samples = latencySamples(edits, observations, participants);
  assertConverged(finalStates, edits);
  const convergenceMs =
    Math.max(...observations.map((observation) => observation.seen)) - startAt;
  await Promise.all(Object.values(clients).map((client) => client.close()));

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
  };
}

const runCount = Number(process.env.SPIKE_RUNS ?? 5);
const runs = [];
for (let index = 0; index < runCount; index += 1) {
  runs.push(await run(5, index + 1));
}
const burstRuns = [];
for (let index = 0; index < runCount; index += 1) {
  burstRuns.push(await run(0, index + 1));
}

const report = {
  variant: "fluid-node-cjs-agent",
  agentBundle: resolve("dist/node-agent.cjs"),
  normalRuns: runs,
  normalPooled: summarize(runs.flatMap((result) => result.samples)),
  burstRuns,
  burstPooled: summarize(burstRuns.flatMap((result) => result.samples)),
};
await mkdir(resultDir, { recursive: true });
await writeFile(
  `${resultDir}/fluid-node-cjs-convergence.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
