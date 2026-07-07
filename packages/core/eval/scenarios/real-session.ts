/**
 * Real long-session A/B scenario: lore vs progressive compaction on a real
 * multi-hundred-K/1M-token coding session exported from the Lore DB.
 *
 * Private session content is NOT committed. Point these env vars at locally
 * generated fixtures (see script/extract-real-session.ts + gen-questions):
 *   REAL_SESSION_FIXTURE    gzipped ConversationTurn[] JSON
 *   REAL_SESSION_QUESTIONS  JSON array of depth-tagged probe questions
 *   REAL_SESSION_LABEL      optional human label
 *
 * When the envs are unset/missing the scenario list is empty, so this module
 * stays committable without shipping anyone's real conversation data.
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type {
  ConversationTurn,
  Dimension,
  EvalQuestion,
  ScenarioDefinition,
} from "../types";

const dimension: Dimension = "context";
const scenarioId = "real-long-session";

interface RawQuestion {
  id: string;
  question: string;
  referenceAnswer: string;
  expectedFacts?: string[];
  forbiddenFacts?: string[];
  /** Depth on the rot axis: distance (tokens) from the end of the session. */
  cumulativeTokens?: number;
  difficulty: "easy" | "medium" | "hard";
  bucket?: string;
}

const rubric = {
  criteria: [
    {
      name: "accuracy",
      description: "Does the answer correctly match the reference?",
      scale: {
        1: "Wrong or fabricated answer" as const,
        3: "Partially correct — right topic but wrong specifics" as const,
        5: "Exactly matches the reference with correct specifics" as const,
      },
    },
  ],
  weights: { accuracy: 1.0 },
};

function load(): ScenarioDefinition[] {
  const fixturePath = process.env.REAL_SESSION_FIXTURE;
  const questionsPath = process.env.REAL_SESSION_QUESTIONS;
  if (
    !fixturePath ||
    !questionsPath ||
    !existsSync(fixturePath) ||
    !existsSync(questionsPath)
  ) {
    return [];
  }

  const turns: ConversationTurn[] = JSON.parse(
    gunzipSync(readFileSync(fixturePath)).toString(),
  );
  const raw: RawQuestion[] = JSON.parse(readFileSync(questionsPath, "utf8"));
  const totalTokens = turns.reduce((s, t) => s + (t.tokens ?? 0), 0);

  const questions: EvalQuestion[] = raw.map((q) => ({
    id: q.id,
    dimension,
    scenario: scenarioId,
    sessionRef: "real-session",
    question: q.question,
    referenceAnswer: q.referenceAnswer,
    rubric,
    expectedFacts: q.expectedFacts,
    forbiddenFacts: q.forbiddenFacts,
    metadata: {
      cumulativeTokens: q.cumulativeTokens,
      difficulty: q.difficulty,
      tags: [q.bucket, "real-session"].filter((x): x is string => !!x),
    },
  }));

  return [
    {
      id: scenarioId,
      dimension,
      label:
        process.env.REAL_SESSION_LABEL ??
        `Real long session (${Math.round(totalTokens / 1000)}K tokens)`,
      description:
        "Real coding session exported from the Lore DB. Tests recall of facts " +
        "across depth as the lore arm and a progressive-compaction arm both " +
        "face the same multi-hundred-K/1M-token history.",
      sessions: [
        {
          id: "real-session",
          label: "Real session",
          projectPath: "/eval/real-long-session",
          turns,
          metadata: {
            totalTokens,
            description: `Real exported session, ${turns.length} turns`,
          },
        },
      ],
      questions,
      // Lore's real alternative is progressive compaction (iterative auto-
      // summary) — what real coding agents actually do. A naive tail window is
      // not a real approach, so it is intentionally excluded.
      applicableBaselines: ["lore", "compaction"],
    },
  ];
}

export const scenarios = load();
