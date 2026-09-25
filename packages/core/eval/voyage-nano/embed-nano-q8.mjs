// Third-party ONNX INT8 candidate. Validate vectors against the official
// BF16 implementation before using these results to assess Nano for Lore.
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { pipeline } from "@huggingface/transformers";

const [casesPath, outputPath] = process.argv.slice(2);
if (!casesPath || !outputPath) {
  throw new Error("Usage: node embed-nano-q8.mjs cases.json output.json");
}

const model = "jsonMartin/voyage-4-nano-ONNX";
const revision = "590ab4268171293c497d97a4c8c396db2c214226";
const started = performance.now();
const beforeCPU = process.cpuUsage();
const pipe = await pipeline("feature-extraction", model, {
  revision,
  dtype: "q8",
  device: "cpu",
  ...(process.env.LORE_EVAL_ORT_THREADS
    ? { session_options: { intraOpNumThreads: Number(process.env.LORE_EVAL_ORT_THREADS) } }
    : {}),
});
const loadMs = performance.now() - started;
let peakRss = process.memoryUsage().rss;
const latency = { document: [], query: [] };
const cases = JSON.parse(readFileSync(casesPath, "utf8"));

async function encode(items, inputType) {
  const results = {};
  const prompt = inputType === "query"
    ? "Represent the query for retrieving supporting documents: "
    : "Represent the document for retrieval: ";
  for (const item of items) {
    const t = performance.now();
    const out = await pipe(prompt + item.text, {
      pooling: "mean",
      normalize: true,
      truncation: true,
    });
    if (out.data.length !== 1024) {
      throw new Error(`Expected 1024 dimensions; got ${out.data.length}`);
    }
    results[item.id] = Array.from(out.data);
    latency[inputType].push(performance.now() - t);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  return results;
}

const documents = await encode(cases.documents, "document");
const queries = await encode(cases.queries, "query");
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(beforeCPU);
writeFileSync(outputPath, JSON.stringify({
  model, revision, provider: "community-onnx-q8", dimensions: 1024,
  documents, queries,
  timings: {
    loadMs, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
    peakRssBytes: peakRss, latencyMs: latency,
  },
  host: {
    node: process.version, cpu: cpus()[0]?.model,
    cores: cpus().length, memoryBytes: totalmem(),
    ortThreads: process.env.LORE_EVAL_ORT_THREADS ?? "runtime default",
  },
}) + "\n");
