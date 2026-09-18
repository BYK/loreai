// Runtime + memory benchmark of the candidate schema libraries over the same
// payloads (see workload.mjs). Run with `npm run bench` (node --expose-gc).
// Not part of CI; numbers are recorded in packages/ui/README.md.
//
//   BENCH_RUN_MS=10000   sustained window per payload (default 10 s)
//   BENCH_RETAIN=100000  parses in the long-lived-tab retention loop
//   BENCH_LIBS=zod,valibot  subset
//   BENCH_JSON=out.json  also write raw results
import { writeFileSync } from "node:fs";
import { performance, PerformanceObserver } from "node:perf_hooks";

import {
  PAYLOADS,
  allocation,
  retention,
  sanity,
  throughput,
} from "./workload.mjs";

const LIBS = (
  process.env.BENCH_LIBS ?? "zod,zod-mini,valibot,typebox,arktype"
).split(",");
const RUN_MS = Number(process.env.BENCH_RUN_MS ?? 10_000);
const WARM_MS = Number(process.env.BENCH_WARM_MS ?? 2_000);
const RETAIN = Number(process.env.BENCH_RETAIN ?? 100_000);
const PAYLOAD_NAMES = (
  process.env.BENCH_PAYLOADS ?? Object.keys(PAYLOADS).join(",")
).split(",");

if (typeof globalThis.gc !== "function") {
  console.error("run with node --expose-gc");
  process.exit(1);
}

const host = {
  now: () => performance.now(),
  async settle() {
    for (let i = 0; i < 3; i++) {
      globalThis.gc();
      await new Promise((r) => setTimeout(r, 30));
    }
    return process.memoryUsage().heapUsed;
  },
  keep(x) {
    globalThis.__keep = x;
  },
  observeGc() {
    const acc = { count: 0, ms: 0, minor: 0, major: 0 };
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        acc.count++;
        acc.ms += e.duration;
        // perf_hooks: 1 = minor (scavenge), 2 = major (mark-sweep)
        const kind = e.detail?.kind ?? e.kind;
        if (kind === 1) acc.minor++;
        else if (kind === 2) acc.major++;
      }
    });
    globalThis.gc();
    obs.observe({ entryTypes: ["gc"] });
    return {
      async stop() {
        await new Promise((r) => setTimeout(r, 50)); // entries arrive async
        obs.disconnect();
        return acc;
      },
    };
  },
};

const results = [];
for (const name of LIBS) {
  const lib = await import(`./schemas/${name}.mjs`);
  sanity(lib);
  for (const payload of PAYLOAD_NAMES) {
    const t = throughput(lib, payload, host, {
      warmMs: WARM_MS,
      runMs: RUN_MS,
    });
    const a = await allocation(lib, payload, host, { n: 1000 });
    const r = await retention(lib, payload, host, {
      // 2k-message sessions are ~10× a page; scale the count so each loop
      // still parses roughly the same number of objects.
      parses: payload === "session" ? Math.round(RETAIN / 10) : RETAIN,
    });
    const row = { lib: name, payload, ...t, ...a, ...r };
    results.push(row);
    console.error(JSON.stringify(row));
  }
}

console.log(
  `node ${process.version}, run=${RUN_MS} ms/payload, retain=${RETAIN} parses`,
);
console.table(results);
if (process.env.BENCH_JSON)
  writeFileSync(process.env.BENCH_JSON, JSON.stringify(results, null, 2));
