/**
 * Lore-adapted Oolong protocol primitives.
 *
 * Oolong's public runner sends a full context in one request. The live runner
 * replays `context` in these deterministic chunks before asking `question` so
 * paired Lore and no-Lore arms share exactly the same workload.
 */

export interface OolongExample {
  id: string;
  context_window_id: string;
  dataset: "synth" | "dnd";
  context: string;
  question: string;
  answer: string;
  answer_type?: "ANSWER_TYPE.NUMERIC" | "ANSWER_TYPE.DATE" | string;
}

export type OolongDataset = OolongExample["dataset"];

interface NativeOolongExample extends Partial<OolongExample> {
  context_window_text?: unknown;
}

export interface OolongScore {
  attemptedParse: string | number | string[];
  parseConfidence: "low" | "med" | "high" | "vhigh";
  score: number;
  answer: string | number | string[];
}

export interface OolongReplayTurn {
  role: "user" | "assistant";
  content: string;
}

/** Normalizes public Oolong records without rewriting downloaded datasets. */
export function normalizeOolongExample(
  record: unknown,
  fallbackDataset?: OolongDataset,
): OolongExample {
  if (!record || typeof record !== "object") {
    throw new Error("Oolong record must be an object");
  }
  const native = record as NativeOolongExample;
  const dataset = native.dataset ?? fallbackDataset;
  const context = native.context ?? native.context_window_text;
  if (
    (dataset !== "synth" && dataset !== "dnd") ||
    typeof native.id !== "string" ||
    typeof native.context_window_id !== "string" ||
    typeof context !== "string" ||
    typeof native.question !== "string" ||
    typeof native.answer !== "string"
  ) {
    throw new Error("invalid Oolong record");
  }
  return {
    id: native.id,
    context_window_id: native.context_window_id,
    dataset,
    context,
    question: native.question,
    answer: native.answer,
    answer_type: native.answer_type,
  };
}

export function splitOolongContext(
  context: string,
  maxChars: number,
): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("maxChars must be a positive integer");
  }
  if (!context) return [];

  const chunks: string[] = [];
  for (let start = 0; start < context.length; start += maxChars) {
    chunks.push(context.slice(start, start + maxChars));
  }
  return chunks;
}

/**
 * Builds the exact history that both paired arms must receive on every replay
 * request. `ACK` is intentionally fixed so an arm cannot gain or lose context
 * merely by replying differently while reference material is streamed in.
 */
export function buildOolongReplayTurns(
  example: OolongExample,
  maxChars: number,
): OolongReplayTurn[] {
  const chunks = splitOolongContext(example.context, maxChars);
  return [
    ...chunks.flatMap((chunk, index) => [
      {
        role: "user" as const,
        content: `Reference segment ${index + 1}/${chunks.length}. Read and retain it for a later question. Reply only ACK.\n\n${chunk}`,
      },
      { role: "assistant" as const, content: "ACK" },
    ]),
    { role: "user", content: example.question },
  ];
}

function synthAttemptAnswerParse(answer: string): {
  answer: string;
  confidence: OolongScore["parseConfidence"];
} {
  if (!answer.includes(":")) {
    return {
      answer: answer.length < 20 ? answer : (answer.split(/\s+/).at(-1) ?? ""),
      confidence: "low",
    };
  }

  let candidate = answer.split(":").at(-1)?.trim() ?? "";
  candidate = candidate
    .replaceAll("*", "")
    .replaceAll("[", "")
    .replaceAll("]", "");
  let confidence: OolongScore["parseConfidence"] = "med";
  if (/User:|Answer:|Date:|Label/.test(answer)) confidence = "high";
  if (candidate.length < 20) confidence = "vhigh";
  else if (candidate.includes("more common")) candidate = "more common";
  else if (candidate.includes("less common")) candidate = "less common";
  else if (candidate.includes("same frequency")) candidate = "same frequency";
  return { answer: candidate, confidence };
}

function parseSynthGold(example: OolongExample): string {
  const date = example.answer.match(
    /^\[datetime\.date\((\d{4}), (\d{1,2}), (\d{1,2})\)\]$/,
  );
  if (date) {
    return `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`;
  }
  const match = example.answer.match(/^\[(['"])(.*)\1\]$/s);
  if (match) return match[2];
  return example.answer;
}

function parseOolongDate(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return;
  return parsed.toISOString();
}

function parseDndAnswer(answer: string): string | number | string[] {
  const trimmed = answer.trim();
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (trimmed.includes(","))
    return trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  return trimmed;
}

export function scoreOolongSynth(
  example: OolongExample,
  output: string,
): OolongScore {
  const gold = parseSynthGold(example);
  const parsed = synthAttemptAnswerParse(output);
  let score = 0;
  if (parsed.answer === gold) score = 1;
  else if (
    ["more common", "less common", "same frequency"].includes(parsed.answer) &&
    gold.includes(parsed.answer)
  )
    score = 1;
  else if (example.answer_type === "ANSWER_TYPE.NUMERIC") {
    const guessed = Number.parseInt(parsed.answer, 10);
    const expected = Number.parseInt(gold, 10);
    if (Number.isFinite(guessed) && Number.isFinite(expected))
      score = 0.75 ** Math.abs(expected - guessed);
  } else if (example.answer_type === "ANSWER_TYPE.DATE") {
    const guessed = parseOolongDate(parsed.answer);
    const expected = parseOolongDate(gold);
    if (guessed && expected) score = Number(guessed === expected);
  }
  return {
    attemptedParse: parsed.answer,
    parseConfidence: parsed.confidence,
    score,
    answer: gold,
  };
}

export function scoreOolongDnd(
  example: OolongExample,
  output: string,
): OolongScore {
  const gold = parseDndAnswer(example.answer);
  const match = output.match(
    /\\boxed\{\\text\{([^}]*)\}\}|\\boxed[\{]+([^}]*)[\}]+/,
  );
  const parsed = parseDndAnswer(match ? (match[1] ?? match[2]) : output);
  let score = 0;
  if (typeof gold === "number" && typeof parsed === "number")
    score = 0.75 ** Math.abs(gold - parsed);
  else if (typeof gold === "string" && typeof parsed === "string")
    score = Number(gold.toLowerCase() === parsed.toLowerCase());
  else if (Array.isArray(gold) && Array.isArray(parsed))
    score = gold.length
      ? new Set(parsed.filter((item) => gold.includes(item))).size /
        new Set(gold).size
      : 0;
  return {
    attemptedParse: parsed,
    parseConfidence: match ? "high" : "low",
    score,
    answer: gold,
  };
}

export function scoreOolong(
  example: OolongExample,
  output: string,
): OolongScore {
  return example.dataset === "synth"
    ? scoreOolongSynth(example, output)
    : scoreOolongDnd(example, output);
}
