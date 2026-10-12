#!/usr/bin/env bun
/** Runs normalized Oolong JSONL through an OpenAI-compatible endpoint. */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildOolongReplayTurns,
  normalizeOolongExample,
  scoreOolong,
  type OolongDataset,
  type OolongExample,
  type OolongReplayTurn,
} from "./oolong";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string", default: "" },
    endpoint: { type: "string", default: "" },
    key: { type: "string", default: "" },
    model: { type: "string", default: "" },
    arm: { type: "string", default: "" },
    dataset: { type: "string", default: "" },
    "run-id": { type: "string", default: "" },
    "chunk-chars": { type: "string", default: "12000" },
    limit: { type: "string", default: "0" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.input || !values.arm || !values.model) {
  throw new Error("--input, --arm, and --model are required");
}
const chunkChars = Number(values["chunk-chars"]);
const limit = Number(values.limit);
if (!Number.isSafeInteger(chunkChars) || chunkChars < 1) {
  throw new Error("--chunk-chars must be a positive integer");
}
if (!Number.isSafeInteger(limit) || limit < 0) {
  throw new Error("--limit must be a non-negative integer");
}
const input = resolve(values.input);
const output = values.output ? resolve(values.output) : "";
const runID = values["run-id"];
const fallbackDataset = values.dataset
  ? (values.dataset as OolongDataset)
  : undefined;
if (
  fallbackDataset &&
  fallbackDataset !== "synth" &&
  fallbackDataset !== "dnd"
) {
  throw new Error("--dataset must be synth or dnd");
}
const examples = readFileSync(input, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line, index) => {
    try {
      return normalizeOolongExample(JSON.parse(line), fallbackDataset);
    } catch (error) {
      throw new Error(
        `invalid Oolong record on line ${index + 1}: ${String(error)}`,
      );
    }
  })
  .slice(0, limit || undefined);

const plan = examples.map((example) => ({
  id: example.id,
  dataset: example.dataset,
  chunks: (buildOolongReplayTurns(example, chunkChars).length - 1) / 2,
}));
if (values["dry-run"]) {
  console.log(
    JSON.stringify(
      { protocol: "lore-adapted-oolong-v1", arm: values.arm, chunkChars, plan },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (!values.endpoint || !output || !runID)
  throw new Error(
    "--endpoint, --output, and --run-id are required outside --dry-run",
  );
if (existsSync(output))
  throw new Error(`refusing to overwrite existing output: ${output}`);

const endpoint = values.endpoint.replace(/\/$/, "");
const auth =
  values.key || process.env.OOLONG_API_KEY || process.env.OPENAI_API_KEY || "";
const system =
  "You are participating in a factual aggregation benchmark. Follow the user instructions exactly.";

function exampleSessionID(example: OolongExample): string {
  const digest = createHash("sha256")
    .update(
      `${runID}\0${values.arm}\0${example.dataset}\0${example.context_window_id}\0${example.id}`,
    )
    .digest("hex");
  return `oolong-${digest.slice(0, 32)}`;
}

async function chat(messages: OolongReplayTurn[], sessionID: string) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lore-session-id": sessionID,
      // The gateway is a stateless full-history proxy. This preserves one
      // benchmark conversation across repeated replay prefixes.
      // Keep this run out of the evaluator's real project bucket and prevent
      // facts recalled for one Oolong example from contaminating another.
      "x-lore-project": `/tmp/lore-eval/oolong/${runID}/${values.arm}/${sessionID}`,
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({
      model: values.model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0,
      max_tokens: 4096,
      stream: false,
    }),
  });
  if (!response.ok)
    throw new Error(
      `Oolong endpoint failed ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

writeFileSync(output, "");
for (const example of examples) {
  const transcript = buildOolongReplayTurns(example, chunkChars);
  const sessionID = exampleSessionID(example);
  let inputTokens = 0;
  let outputTokens = 0;
  // Submit every growing prefix. Assistant acknowledgements stay fixed by
  // protocol, preventing model-specific text from contaminating later turns.
  for (let index = 0; index < transcript.length - 1; index += 2) {
    const response = await chat(transcript.slice(0, index + 1), sessionID);
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
  }
  const response = await chat(transcript, sessionID);
  inputTokens += response.inputTokens;
  outputTokens += response.outputTokens;
  const scored = scoreOolong(example, response.text);
  appendFileSync(
    output,
    `${JSON.stringify({
      protocol: "lore-adapted-oolong-v1",
      id: example.id,
      context_window_id: example.context_window_id,
      dataset: example.dataset,
      arm: values.arm,
      runID,
      sessionID,
      model: values.model,
      chunkChars,
      chunks: (transcript.length - 1) / 2,
      score: scored.score,
      attemptedParse: scored.attemptedParse,
      parseConfidence: scored.parseConfidence,
      answer: scored.answer,
      inputTokens,
      outputTokens,
    })}\n`,
  );
}
