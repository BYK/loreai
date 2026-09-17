#!/usr/bin/env tsx
/**
 * Run the deterministic semantic-lint replay corpus.
 *
 * This is deliberately separate from the live memory eval: it replays
 * integrity-checked judge/verifier traces for fixed revisions, so a CI run has
 * no model spend and produces comparable precision/recall, abstention,
 * coverage, cost, and latency measurements without fetching or executing the
 * revisions.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  renderSemanticLintReplayMarkdown,
  runSemanticLintReplay,
} from "./runner";

const { values: args } = parseArgs({
  options: {
    repetitions: { type: "string", default: "3" },
    output: { type: "string", default: "" },
    "markdown-output": { type: "string", default: "" },
    help: { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Semantic-lint replay evaluation

Usage:
  pnpm tsx packages/core/eval/semantic-lint/run.ts [options]

Options:
  --repetitions <n>          Repeat every fixed case/strategy (default: 3)
  --output <path>            Write the JSON report to this path
  --markdown-output <path>   Write the Markdown summary to this path
  --help                     Show this help
`);
  process.exit(0);
}

const repetitions = Number(args.repetitions ?? 3);
const report = runSemanticLintReplay({ repetitions });
const markdown = renderSemanticLintReplayMarkdown(report);

if (args.output) {
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`JSON report written to ${output}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}

if (args["markdown-output"]) {
  const output = resolve(args["markdown-output"]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${markdown}\n`, "utf8");
  console.log(`Markdown report written to ${output}`);
}

console.error(markdown);
if (report.guardrails.status === "fail") process.exitCode = 1;
