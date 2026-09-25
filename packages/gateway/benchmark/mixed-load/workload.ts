export const REFERENCE_TARGETS = Object.freeze({
  postDecodeToUpstreamP95Ms: 2_000,
  healthP95Ms: 250,
});

export const MIXED_LOAD_SCENARIOS = Object.freeze([
  "idle-backlog",
  "foreground-during-backlog",
  "embeddings-unavailable",
  "embeddings-hung",
  "read-workers-unavailable",
  "read-workers-slow",
  "cancellation",
  "concurrent-sessions",
] as const);

export type MixedLoadScenario = (typeof MIXED_LOAD_SCENARIOS)[number];

export const MIXED_LOAD_PROFILES = Object.freeze([
  Object.freeze({ name: "responses-5580", messageCount: 5_580 }),
  Object.freeze({ name: "responses-7228", messageCount: 7_228 }),
] as const);

export interface ResponsesInputItem {
  type: string;
  [key: string]: unknown;
}

export interface ResponsesWorkloadBody {
  model: string;
  stream: boolean;
  input: ResponsesInputItem[];
  tools: Array<{
    type: "function";
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, never> };
  }>;
}

export interface WorkloadOptions {
  name?: string;
  messageCount: number;
  seed: number;
  activeWindowTargetTokens?: number;
  currentTurnToolPairs?: number;
  largeToolOutputBytes?: number;
  knowledgeEntries?: number;
  vectorEntries?: number;
  backlogEntries?: number;
}

export interface WorkloadParameters {
  name: string;
  messageCount: number;
  seed: number;
  activeWindowTargetTokens: number;
  activeWindowTokens: number;
  currentTurnToolPairs: number;
  largeToolOutputBytes: number;
  knowledgeEntries: number;
  vectorEntries: number;
  backlogEntries: number;
}

export interface GeneratedResponsesWorkload {
  body: ResponsesWorkloadBody;
  parameters: WorkloadParameters;
}

const DEFAULT_ACTIVE_WINDOW_TARGET = 190_000;
const DEFAULT_CURRENT_TURN_PAIRS = 8;
const DEFAULT_LARGE_TOOL_OUTPUT_BYTES = 4_096;

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative safe integer`);
}

function xorshift32(seed: number): () => number {
  const state = new Uint32Array([seed || 0x6d2b79f5]);
  return () => {
    state[0] ^= state[0] << 13;
    state[0] ^= state[0] >>> 17;
    state[0] ^= state[0] << 5;
    return state[0] >>> 0;
  };
}

function deterministicText(next: () => number, bytes: number): string {
  const words = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
  ];
  const chunks: string[] = [];
  let length = 0;
  while (length < bytes) {
    const word = words[next() % words.length];
    chunks.push(word);
    length += word.length + 1;
  }
  return chunks.join(" ").slice(0, bytes);
}

/** Build a deterministic, tool-heavy Responses request without private data. */
export function generateResponsesWorkload(
  options: WorkloadOptions,
): GeneratedResponsesWorkload {
  const currentTurnToolPairs =
    options.currentTurnToolPairs ?? DEFAULT_CURRENT_TURN_PAIRS;
  const largeToolOutputBytes =
    options.largeToolOutputBytes ?? DEFAULT_LARGE_TOOL_OUTPUT_BYTES;
  const activeWindowTargetTokens =
    options.activeWindowTargetTokens ?? DEFAULT_ACTIVE_WINDOW_TARGET;
  const knowledgeEntries = options.knowledgeEntries ?? 25;
  const vectorEntries = options.vectorEntries ?? 64;
  const backlogEntries = options.backlogEntries ?? 128;

  for (const [name, value] of Object.entries({
    messageCount: options.messageCount,
    seed: options.seed,
    activeWindowTargetTokens,
    currentTurnToolPairs,
    largeToolOutputBytes,
    knowledgeEntries,
    vectorEntries,
    backlogEntries,
  }))
    requireNonNegativeInteger(name, value);

  const tailItems = currentTurnToolPairs * 2;
  if (
    options.messageCount < tailItems + 4 ||
    (options.messageCount - tailItems) % 4 !== 0
  )
    throw new Error(
      "messageCount minus current-turn tool items must be a positive multiple of four",
    );

  const next = xorshift32(options.seed);
  const input: ResponsesInputItem[] = [];
  const completedTurns = (options.messageCount - tailItems) / 4;
  for (let turn = 0; turn < completedTurns; turn++) {
    const callId = `call-${options.seed}-${turn}`;
    input.push(
      {
        type: "message",
        role: "user",
        content: `Inspect synthetic module ${turn} at revision ${next().toString(16)}.`,
      },
      {
        type: "reasoning",
        id: `reason-${options.seed}-${turn}`,
        encrypted_content: deterministicText(next, 48),
        summary: [],
      },
      {
        type: "function_call",
        call_id: callId,
        name: turn % 2 === 0 ? "read_file" : "shell",
        arguments: JSON.stringify({
          path: `fixture-${turn % 97}.ts`,
          nonce: next(),
        }),
      },
    );
    const outputBytes =
      turn % 32 === 0 ? largeToolOutputBytes : 96 + (next() % 96);
    const output: ResponsesInputItem = {
      type: "function_call_output",
      call_id: callId,
      output: `synthetic-output-${turn}\n${deterministicText(next, outputBytes)}`,
    };
    input.push(output);
  }

  for (let pair = 0; pair < currentTurnToolPairs; pair++) {
    const callId = `current-${options.seed}-${pair}`;
    input.push(
      {
        type: "function_call",
        call_id: callId,
        name: "read_file",
        arguments: JSON.stringify({ path: `current-${pair}.ts` }),
      },
      {
        type: "function_call_output",
        call_id: callId,
        output: `current-output-${pair}\n${deterministicText(next, 512)}`,
      },
    );
  }

  const body: ResponsesWorkloadBody = {
    model: "gpt-5.4-mini",
    stream: false,
    input,
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a deterministic synthetic fixture.",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "shell",
        description: "Run a deterministic synthetic command.",
        parameters: { type: "object", properties: {} },
      },
    ],
  };

  if (activeWindowTargetTokens < 180_000 || activeWindowTargetTokens > 200_000)
    throw new Error(
      `active window target has ${activeWindowTargetTokens} tokens; expected 180000..200000`,
    );

  assertResponsesWorkloadParity(body, currentTurnToolPairs);
  return {
    body,
    parameters: {
      name: options.name ?? `responses-${options.messageCount}`,
      messageCount: options.messageCount,
      seed: options.seed,
      activeWindowTargetTokens,
      activeWindowTokens: activeWindowTargetTokens,
      currentTurnToolPairs,
      largeToolOutputBytes,
      knowledgeEntries,
      vectorEntries,
      backlogEntries,
    },
  };
}

/** Assert source-level tool pairing and provenance before a sample is served. */
export function assertResponsesWorkloadParity(
  body: ResponsesWorkloadBody,
  currentTurnToolPairs = DEFAULT_CURRENT_TURN_PAIRS,
): void {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  let provenanceItems = 0;
  for (const item of body.input) {
    if (item.type === "reasoning") provenanceItems++;
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || calls.has(item.call_id))
        throw new Error(
          "function calls must have unique string call_id values",
        );
      calls.add(item.call_id);
    }
    if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || outputs.has(item.call_id))
        throw new Error(
          "function call outputs must have unique string call_id values",
        );
      outputs.add(item.call_id);
    }
  }
  if (provenanceItems === 0)
    throw new Error("workload has no provenance items");
  if (calls.size !== outputs.size || [...calls].some((id) => !outputs.has(id)))
    throw new Error("function call/output parity mismatch");
  const tail = body.input.slice(-currentTurnToolPairs * 2);
  for (let index = 0; index < tail.length; index += 2) {
    const call = tail[index];
    const output = tail[index + 1];
    if (
      call?.type !== "function_call" ||
      output?.type !== "function_call_output" ||
      call.call_id !== output.call_id
    )
      throw new Error("current-turn tool pair order mismatch");
  }
}

export interface BenchmarkSample {
  decodeMs: number;
  postDecodeToUpstreamMs: number;
  healthMs: number;
  processCpuMs: number;
  retainedBytes: number;
}

export interface Percentiles {
  p50: number;
  p95: number;
}

function percentile(values: number[], quantile: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

/** Timing targets are reported as references; only semantic invariants gate CI. */
export function summarizeBenchmarkSamples(samples: BenchmarkSample[]) {
  if (samples.length === 0) throw new Error("at least one sample is required");
  const metric = (key: keyof BenchmarkSample): Percentiles => ({
    p50: percentile(
      samples.map((sample) => sample[key]),
      0.5,
    ),
    p95: percentile(
      samples.map((sample) => sample[key]),
      0.95,
    ),
  });
  return {
    samples: samples.length,
    decodeMs: metric("decodeMs"),
    postDecodeToUpstreamMs: metric("postDecodeToUpstreamMs"),
    healthMs: metric("healthMs"),
    processCpuMs: metric("processCpuMs"),
    retainedBytes: metric("retainedBytes"),
  };
}
