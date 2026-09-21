#!/usr/bin/env tsx
/**
 * Duration-aware Vitest sharding for CI.
 *
 * Vitest's built-in `--shard` partitions by file-path hash, which for this
 * suite yields shards that differ ~4x in wall time (a handful of e2e /
 * installer files dominate). This script instead packs test files onto
 * shards by their last measured duration (greedy longest-processing-time),
 * so every shard finishes at roughly the same time.
 *
 * Usage:
 *   tsx scripts/test-shards.ts plan --shard 2/4
 *       Print the repo-relative test files for shard 2 of 4, one per line
 *       (feed to `vitest run`). Files missing from the manifest get the
 *       manifest median so a new file never lands unfairly.
 *
 *   tsx scripts/test-shards.ts record .vitest-reports/durations-*.json
 *       Rebuild scripts/test-durations.json from Vitest JSON reporter output
 *       (`--reporter=json --outputFile.json=...`). Run in CI after the
 *       shards finish; commit the result to rebalance.
 *
 *   tsx scripts/test-shards.ts summary [--shards 4]
 *       Print the estimated per-shard totals for the current manifest.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(rootDir, "scripts", "test-durations.json");

type Manifest = Record<string, number>;

function readManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function median(values: number[]): number {
  if (!values.length) return 1000;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** All test files the root vitest config would run, repo-relative, sorted. */
function listTestFiles(): string[] {
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "list", "--filesOnly", "--json"],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`vitest list failed:\n${result.stderr}`);
  }
  const files = JSON.parse(result.stdout) as Array<{ file: string }>;
  return files
    .map((f) => relative(rootDir, f.file))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Greedy LPT: sort by weight desc, always place the next file on the
 * currently lightest shard. Deterministic for a given (files, manifest).
 */
function pack(
  files: string[],
  manifest: Manifest,
  shards: number,
): { assignment: string[][]; totals: number[]; unknown: string[] } {
  const fallback = median(Object.values(manifest));
  const unknown: string[] = [];
  const weighted = files.map((file) => {
    const ms = manifest[file];
    if (ms === undefined) unknown.push(file);
    return { file, ms: ms ?? fallback };
  });
  weighted.sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));

  const assignment: string[][] = Array.from({ length: shards }, () => []);
  const totals: number[] = Array.from({ length: shards }, () => 0);
  for (const { file, ms } of weighted) {
    let target = 0;
    for (let i = 1; i < shards; i++) {
      if (totals[i] < totals[target]) target = i;
    }
    assignment[target].push(file);
    totals[target] += ms;
  }
  return { assignment, totals, unknown };
}

function parseShard(spec: string | undefined): {
  index: number;
  count: number;
} {
  const m = /^(\d+)\/(\d+)$/.exec(spec ?? "");
  if (!m) throw new Error(`--shard expects N/M, got ${spec ?? "(missing)"}`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (index < 1 || index > count) {
    throw new Error(`shard index ${index} out of range 1..${count}`);
  }
  return { index, count };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

type JsonReport = {
  testResults: Array<{ name: string; startTime: number; endTime: number }>;
};

function record(reportPaths: string[]): void {
  if (!reportPaths.length) throw new Error("record: no report files given");
  const manifest: Manifest = {};
  for (const p of reportPaths) {
    const report = JSON.parse(readFileSync(p, "utf8")) as JsonReport;
    for (const r of report.testResults) {
      const file = relative(rootDir, r.name);
      manifest[file] = Math.max(1, Math.round(r.endTime - r.startTime));
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(
    `wrote ${Object.keys(sorted).length} entries to ${relative(rootDir, manifestPath)}`,
  );
}

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function main(argv: string[]): void {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "plan": {
      const { index, count } = parseShard(flag(args, "--shard"));
      const { assignment, totals, unknown } = pack(
        listTestFiles(),
        readManifest(),
        count,
      );
      if (unknown.length) {
        console.error(
          `test-shards: ${unknown.length} file(s) not in manifest, using median:\n  ${unknown.join("\n  ")}`,
        );
      }
      console.error(
        `test-shards: shard ${index}/${count} ≈ ${fmt(totals[index - 1])} (${assignment[index - 1].length} files; all shards: ${totals.map(fmt).join(" ")})`,
      );
      console.log(assignment[index - 1].join("\n"));
      return;
    }
    case "record":
      record(args);
      return;
    case "summary": {
      const count = Number(flag(args, "--shards") ?? 4);
      const { totals, unknown } = pack(listTestFiles(), readManifest(), count);
      totals.forEach((t, i) =>
        console.log(`shard ${i + 1}/${count}: ${fmt(t)}`),
      );
      if (unknown.length)
        console.log(`${unknown.length} file(s) not in manifest`);
      return;
    }
    default:
      console.error(
        "usage: test-shards.ts plan --shard N/M | record <json...> | summary [--shards N]",
      );
      process.exit(2);
  }
}

main(process.argv.slice(2));
