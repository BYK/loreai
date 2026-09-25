import { estimateMessages } from "@loreai/core";
import { gatewayMessagesToLore } from "../../src/temporal-adapter";
import { parseOpenAIResponsesRequest } from "../../src/translate/openai-responses";

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
  enforceActiveWindow?: boolean;
}

export interface WorkloadParameters {
  name: string;
  messageCount: number;
  seed: number;
  activeWindowTargetTokens: number;
  sourceInputItems: number;
  sourceNormalizedMessages: number;
  sourceEstimatedTokens: number;
  activeWindowLowerBoundTokens: number;
  activeWindowUpperBoundTokens: number;
  currentTurnToolPairs: number;
  largeToolOutputBytes: number;
  knowledgeEntries: number;
  vectorEntries: number;
  backlogEntries: number;
  enforceActiveWindow: boolean;
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

  if (options.messageCount < 5)
    throw new Error("messageCount must leave room for history and a tool pair");
  if (currentTurnToolPairs < 1)
    throw new Error("currentTurnToolPairs must be positive");

  const next = xorshift32(options.seed);
  const input: ResponsesInputItem[] = [];
  // A completed Responses turn normalizes to four gateway messages: user,
  // assistant tool call (with reasoning provenance), user tool result, then a
  // plain assistant boundary. The boundary prevents old tool chains from being
  // classified as part of the protected current turn.
  // Consecutive current-turn calls and results normalize to two messages.
  const historyMessages = options.messageCount - 2;
  const completedTurns = Math.floor(historyMessages / 4);
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
    input.push(output, {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: `Completed synthetic inspection ${turn}.`,
        },
      ],
    });
  }

  const remainder = historyMessages - completedTurns * 4;
  if (remainder >= 1)
    input.push({
      type: "message",
      role: "user",
      content: `Deterministic remainder ${options.seed}.`,
    });
  if (remainder >= 2)
    input.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Remainder acknowledged." }],
    });
  if (remainder >= 3)
    input.push({
      type: "message",
      role: "user",
      content: `Deterministic second remainder ${options.seed}.`,
    });

  // Preserve the real Responses shape for a parallel current turn: every call
  // first, followed by every matching result in the same order.
  for (let pair = 0; pair < currentTurnToolPairs; pair++) {
    const callId = `current-${options.seed}-${pair}`;
    input.push({
      type: "function_call",
      call_id: callId,
      name: "read_file",
      arguments: JSON.stringify({ path: `current-${pair}.ts` }),
    });
  }
  for (let pair = 0; pair < currentTurnToolPairs; pair++) {
    const callId = `current-${options.seed}-${pair}`;
    input.push({
      type: "function_call_output",
      call_id: callId,
      output: `current-output-${pair}\n${deterministicText(next, 512)}`,
    });
  }

  const body: ResponsesWorkloadBody = {
    model: "benchmark-mixed-load-190k",
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

  if (activeWindowTargetTokens !== DEFAULT_ACTIVE_WINDOW_TARGET)
    throw new Error(
      `active window target has ${activeWindowTargetTokens} tokens; expected ${DEFAULT_ACTIVE_WINDOW_TARGET}`,
    );

  assertResponsesWorkloadParity(body, currentTurnToolPairs);
  const normalized = parseOpenAIResponsesRequest(body, {}).messages;
  if (normalized.length !== options.messageCount)
    throw new Error(
      `workload normalized to ${normalized.length} messages; expected ${options.messageCount}`,
    );
  const sourceEstimatedTokens = estimateMessages(
    gatewayMessagesToLore(normalized, `benchmark-source-${options.seed}`),
  );
  return {
    body,
    parameters: {
      name: options.name ?? `responses-${options.messageCount}`,
      messageCount: options.messageCount,
      seed: options.seed,
      activeWindowTargetTokens,
      sourceInputItems: input.length,
      sourceNormalizedMessages: normalized.length,
      sourceEstimatedTokens,
      activeWindowLowerBoundTokens: Math.floor(
        activeWindowTargetTokens * (18 / 19),
      ),
      activeWindowUpperBoundTokens: Math.ceil(
        activeWindowTargetTokens * (21 / 19),
      ),
      currentTurnToolPairs,
      largeToolOutputBytes,
      knowledgeEntries,
      vectorEntries,
      backlogEntries,
      enforceActiveWindow: options.enforceActiveWindow ?? true,
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
  const tailCalls = tail.slice(0, currentTurnToolPairs);
  const tailOutputs = tail.slice(currentTurnToolPairs);
  for (let index = 0; index < currentTurnToolPairs; index++) {
    const call = tailCalls[index];
    const output = tailOutputs[index];
    if (
      call?.type !== "function_call" ||
      output?.type !== "function_call_output" ||
      call.call_id !== output.call_id
    )
      throw new Error("current-turn tool pair order mismatch");
  }
}

/** Return a full-history body with one genuine, deterministic suffix. */
export function appendResponsesContinuation(
  source: ResponsesWorkloadBody,
  seed: number,
  ordinal: number,
): ResponsesWorkloadBody {
  requireNonNegativeInteger("continuation ordinal", ordinal);
  const callId = `append-${seed}-${ordinal}`;
  return {
    ...source,
    input: [
      ...source.input,
      {
        type: "message",
        role: "user",
        content: `Inspect deterministic appended fixture ${ordinal}.`,
      },
      {
        type: "reasoning",
        id: `append-reason-${seed}-${ordinal}`,
        encrypted_content: `deterministic-appended-provenance-${ordinal}`,
        summary: [],
      },
      {
        type: "function_call",
        call_id: callId,
        name: "read_file",
        arguments: JSON.stringify({ path: `appended-${ordinal}.ts` }),
      },
      {
        type: "function_call_output",
        call_id: callId,
        output: `deterministic appended output ${ordinal}`,
      },
    ],
  };
}

export interface BenchmarkSample {
  decodeMs: number;
  postDecodeToUpstreamMs: number;
  healthMs: number;
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
  };
}
