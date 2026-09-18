// Parse throughput, GC pressure and heap retention for the four candidate
// schema libraries over the same payloads. Run with `node --expose-gc bench.mjs`
// (or `npm run bench`). Not part of CI; numbers are recorded in
// packages/ui/README.md.
import { performance, PerformanceObserver } from "node:perf_hooks";

import * as fx from "./fixtures.mjs";

const LIBS = ["zod", "zod-mini", "valibot", "typebox", "arktype"];
const WARMUP = 50;
const ITERS = Number(process.env.BENCH_ITERS ?? 400);
const RETAIN_PARSES = 10_000;
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const settleHeap = async () => {
  for (let i = 0; i < 3; i++) {
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 30));
  }
  return process.memoryUsage().heapUsed;
};

if (typeof globalThis.gc !== "function") {
  console.error("run with node --expose-gc");
  process.exit(1);
}

const knowledgePage = fx.knowledgePage(200);
const sessionDetail = fx.sessionDetail(2000);
const projectList = fx.projectList(12);

// Deep-clone per iteration so parse cost includes the object-identity a real
// `res.json()` would hand us and libraries cannot memoise on identity.
const cloneKnowledge = () => structuredClone(knowledgePage);
const cloneSession = () => structuredClone(sessionDetail);

function gcObserver() {
  const counts = { minor: 0, major: 0, other: 0 };
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const kind = e.detail?.kind ?? e.kind;
      // perf_hooks constants: 1 = minor (scavenge), 2 = major (mark-sweep), 4 = incremental, 8 = weak cb
      if (kind === 1) counts.minor++;
      else if (kind === 2) counts.major++;
      else counts.other++;
    }
  });
  obs.observe({ entryTypes: ["gc"] });
  return { counts, stop: () => obs.disconnect() };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

async function bench(label, prepare, run) {
  for (let i = 0; i < WARMUP; i++) run(prepare());
  // Pre-build inputs so structuredClone cost is excluded from the timing.
  const inputs = [];
  for (let i = 0; i < ITERS; i++) inputs.push(prepare());
  const ms = [];
  const minor = [];
  const major = [];
  for (let round = 0; round < ROUNDS; round++) {
    globalThis.gc();
    const g = gcObserver();
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) run(inputs[i]);
    ms.push(performance.now() - t0);
    await tick(); // gc entries are delivered asynchronously
    g.stop();
    minor.push(g.counts.minor);
    major.push(g.counts.major);
  }
  const m = median(ms);
  return {
    label,
    opsPerSec: Math.round(ITERS / (m / 1000)),
    msPerOp: +(m / ITERS).toFixed(3),
    minorGcPerRound: median(minor),
    majorGcPerRound: median(major),
  };
}

async function retention(lib) {
  // Long-lived tab: parse the same page 10k times, keep only the last result
  // (as a store would), then see what the heap holds after a full GC.
  const input = cloneKnowledge();
  const before = await settleHeap();
  let last;
  for (let i = 0; i < RETAIN_PARSES; i++) {
    last = lib.parse(lib.knowledgePage, input);
  }
  const after = await settleHeap();
  globalThis.__keep = last;
  return { retainedKb: Math.round((after - before) / 1024) };
}

const results = [];
for (const name of LIBS) {
  const lib = await import(`./schemas/${name}.mjs`);
  // Sanity: every library must accept the fixtures and reject a broken row.
  lib.parse(lib.knowledgePage, knowledgePage);
  lib.parse(lib.sessionDetail, sessionDetail);
  lib.parse(lib.projectList, projectList);
  lib.parse(lib.account, fx.accountStatus);
  lib.parse(lib.sharing, fx.sharingStatus);
  const broken = structuredClone(knowledgePage);
  broken.items[137].confidence = 1.5;
  if (lib.check(lib.knowledgePage, broken))
    throw new Error(`${name} accepted confidence 1.5`);
  const missing = structuredClone(sessionDetail);
  delete missing.messages[999].created_at;
  if (lib.check(lib.sessionDetail, missing))
    throw new Error(`${name} accepted missing created_at`);

  const k = await bench(`${name} knowledge page (200)`, cloneKnowledge, (d) =>
    lib.parse(lib.knowledgePage, d),
  );
  const s = await bench(`${name} session detail (2k msgs)`, cloneSession, (d) =>
    lib.parse(lib.sessionDetail, d),
  );
  const r = await retention(lib);
  results.push(
    { ...k },
    { ...s },
    { label: `${name} retained after 10k parses`, retainedKb: r.retainedKb },
  );
}

console.log(
  `node ${process.version}, iterations=${ITERS}, rounds=${ROUNDS} (median)`,
);
console.table(results);
