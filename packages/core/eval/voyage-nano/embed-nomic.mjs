// Reference implementation of Lore's current Nomic worker embedding recipe.
// Run from repo root after pnpm install. Output is local; no text is uploaded.
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { pipeline, layer_norm } from "@huggingface/transformers";

const [casesPath, outputPath] = process.argv.slice(2);
if (!casesPath || !outputPath) {
  throw new Error("Usage: node packages/core/eval/voyage-nano/embed-nomic.mjs cases.json output.json");
}
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const started = performance.now();
const beforeCPU = process.cpuUsage();
const pipe = await pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5", {
  dtype: "q8",
  device: "cpu",
  // Matches the explicit thread cap when Lore runs inside a CPU-constrained container.
  ...(process.env.LORE_EVAL_ORT_THREADS
    ? { session_options: { intraOpNumThreads: Number(process.env.LORE_EVAL_ORT_THREADS) } }
    : {}),
});
const loadMs = performance.now() - started;
let peakRss = process.memoryUsage().rss;
const latency = { document: [], query: [] };

async function encode(items, inputType) {
  const results = {};
  for (const item of items) {
    const t = performance.now();
    const prefix = inputType === "query" ? "search_query: " : "search_document: ";
    // Lore truncates by characters first, then its worker caps tokenizer length.
    const out = await pipe(prefix + item.text.slice(0, 8192 * 4), {
      pooling: "mean",
      truncation: true,
    });
    const fullDim = out.dims.at(-1);
    const tensor = layer_norm(out, [fullDim]).normalize(2, -1);
    results[item.id] = Array.from(tensor.data);
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
  model: "nomic-ai/nomic-embed-text-v1.5",
  provider: "local",
  dimensions: 768,
  documents,
  queries,
  timings: { loadMs, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
    peakRssBytes: peakRss, latencyMs: latency },
  host: { node: process.version, cpu: cpus()[0]?.model, cores: cpus().length,
    memoryBytes: totalmem(), ortThreads: process.env.LORE_EVAL_ORT_THREADS ?? "runtime default" },
}) + "\n");
