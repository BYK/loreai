// Runtime-agnostic benchmark workload shared by bench.mjs (node) and
// browser.mjs (Playwright chromium). The host injects `now`, `gc` and
// `heapUsed`; everything else is plain JS so the exact same loops run in
// both environments.
import * as fx from "./fixtures.mjs";

export const PAYLOADS = {
  entry: { schema: "knowledgeEntry", make: () => fx.knowledgeEntry(7), batch: 200 },
  page: { schema: "knowledgePage", make: () => fx.knowledgePage(200) },
  session: { schema: "sessionDetail", make: () => fx.sessionDetail(2000) },
};

const quantile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

/** Bounded LRU keyed by an integer, mimicking the SPA's keyed store. */
export class Lru {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

/**
 * (1) Sustained throughput: warm for `warmMs`, then time each op for at least
 * `runMs`. Reports ops/s plus p50/p99 per-op latency. Inputs are rotated
 * through a pool of distinct clones so libraries cannot memoise on identity.
 */
export function throughput(lib, payload, host, { warmMs, runMs, pool = 32 }) {
  const schema = lib[PAYLOADS[payload].schema];
  // Single entries parse in ~1 µs, below the browser's clock resolution:
  // time them in batches and report per-op figures.
  const batch = PAYLOADS[payload].batch ?? 1;
  const inputs = [];
  for (let i = 0; i < pool; i++) inputs.push(PAYLOADS[payload].make());
  let i = 0;
  const t0 = host.now();
  while (host.now() - t0 < warmMs) lib.parse(schema, inputs[i++ % pool]);
  const samples = [];
  const t1 = host.now();
  while (host.now() - t1 < runMs) {
    const s = host.now();
    for (let b = 0; b < batch; b++) lib.parse(schema, inputs[i++ % pool]);
    samples.push((host.now() - s) / batch);
  }
  samples.sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  return {
    ops: samples.length * batch,
    opsPerSec: Math.round(samples.length / (total / 1000)),
    p50Ms: +quantile(samples, 0.5).toFixed(4),
    p99Ms: +quantile(samples, 0.99).toFixed(4),
  };
}

/**
 * (2) Allocation per parse: full GC, parse N distinct inputs keeping every
 * result alive, full GC, heap delta / N. Keeping results alive measures what a
 * parse *hands back* (the store will hold it); `gcEvents`, when the host can
 * observe GC, reports collections triggered while parsing with results
 * dropped (pure garbage pressure).
 */
export async function allocation(lib, payload, host, { n = 1000 }) {
  const schema = lib[PAYLOADS[payload].schema];
  const inputs = [];
  for (let i = 0; i < n; i++) inputs.push(PAYLOADS[payload].make());
  const keep = new Array(n);
  const before = await host.settle();
  for (let i = 0; i < n; i++) keep[i] = lib.parse(schema, inputs[i]);
  const after = await host.settle();
  const retainedPerOpKb = (after - before) / n / 1024;
  keep.length = 0;

  let gc = null;
  if (host.observeGc) {
    const obs = host.observeGc();
    for (let i = 0; i < n; i++) lib.parse(schema, inputs[i]);
    gc = await obs.stop();
  }
  return {
    heapPerOpKb: +retainedPerOpKb.toFixed(2),
    ...(gc
      ? {
          gcCount: gc.count,
          gcMs: +gc.ms.toFixed(1),
          minorGc: gc.minor,
          majorGc: gc.major,
        }
      : {}),
  };
}

/**
 * (3) Retained heap in a long-lived tab: parse `parses` times keeping the
 * results in a bounded LRU (`lruSize` most recent), then compare the settled
 * heap with a baseline that runs the identical loop with `structuredClone`
 * as the "parser" (a plain copy of the payload, which is what a parse that
 * returns a fresh object must at least cost). `retainedKb` is what the tab
 * holds after the loop (the LRU contents); `excessKb` is anything beyond
 * `lruSize` × the per-parse footprint measured in `allocation()`, i.e. the
 * leak indicator — it should stay near zero.
 */
export async function retention(
  lib,
  payload,
  host,
  { parses, lruSize = 50, pool = 64, heapPerOpKb = 0 },
) {
  const schema = lib[PAYLOADS[payload].schema];
  const inputs = [];
  for (let i = 0; i < pool; i++) inputs.push(PAYLOADS[payload].make());
  const run = async (parse) => {
    const lru = new Lru(lruSize);
    const before = await host.settle();
    for (let i = 0; i < parses; i++) lru.set(i, parse(schema, inputs[i % pool]));
    const after = await host.settle();
    host.keep(lru);
    return after - before;
  };
  const baseline = await run((_s, d) => structuredClone(d));
  const withLib = await run((s, d) => lib.parse(s, d));
  return {
    retainedKb: Math.round(withLib / 1024),
    cloneBaselineKb: Math.round(baseline / 1024),
    excessKb: Math.round(withLib / 1024 - lruSize * heapPerOpKb),
  };
}

export function sanity(lib) {
  const page = fx.knowledgePage(200);
  const session = fx.sessionDetail(2000);
  lib.parse(lib.knowledgePage, page);
  lib.parse(lib.sessionDetail, session);
  lib.parse(lib.projectList, fx.projectList(12));
  lib.parse(lib.account, fx.accountStatus);
  lib.parse(lib.sharing, fx.sharingStatus);
  const broken = structuredClone(page);
  broken.items[137].confidence = 1.5;
  if (lib.check(lib.knowledgePage, broken))
    throw new Error(`${lib.name} accepted confidence 1.5`);
  const missing = structuredClone(session);
  delete missing.messages[999].created_at;
  if (lib.check(lib.sessionDetail, missing))
    throw new Error(`${lib.name} accepted missing created_at`);
}
