/**
 * Real MULTI-session A/B scenario: lore vs a no-memory agent.
 *
 * Several real sessions from ONE project (exported from the Lore DB, in
 * chronological order) are replayed in sequence. Lore accumulates cross-session
 * memory automatically (distillation + knowledge + entities, injected on later
 * turns and via recall). The probe questions ask about facts from the EARLIEST
 * sessions — so answering them at the end requires remembering across session
 * boundaries. The `no-memory` arm gets no prior-session context at all (the
 * realistic vanilla-agent experience), serving as a negative control: any
 * correct prior-session fact there is guessing.
 *
 * Private content is NOT committed. Point these envs at local fixtures:
 *   REAL_MULTI_FIXTURES   comma-separated gzipped ConversationTurn[] paths, in
 *                         chronological session order
 *   REAL_MULTI_QUESTIONS  JSON array of depth-tagged probe questions
 *   REAL_MULTI_LABEL      optional human label
 * Skipped (empty) when unset, so the module stays committable.
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type {
  ConversationTurn,
  Dimension,
  EvalQuestion,
  ScenarioDefinition,
  SessionTranscript,
} from "../types";

const dimension: Dimension = "recall";
const scenarioId = "real-multisession";

interface RawQuestion {
  id: string;
  question: string;
  referenceAnswer: string;
  expectedFacts?: string[];
  forbiddenFacts?: string[];
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
  const fixturesEnv = process.env.REAL_MULTI_FIXTURES;
  const questionsPath = process.env.REAL_MULTI_QUESTIONS;
  if (!fixturesEnv || !questionsPath || !existsSync(questionsPath)) return [];
  const paths = fixturesEnv
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length === 0 || !paths.every((p) => existsSync(p))) return [];

  const sessions: SessionTranscript[] = paths.map((p, i) => {
    const turns: ConversationTurn[] = JSON.parse(
      gunzipSync(readFileSync(p)).toString(),
    );
    return {
      id: `real-ms-${i + 1}`,
      label: `Real session ${i + 1}`,
      // Same project across all sessions so Lore accumulates one project's
      // cross-session memory (that is what gets auto-injected later).
      projectPath: "/eval/real-multisession",
      turns,
      metadata: {
        totalTokens: turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
        description: `Real session ${i + 1}, ${turns.length} turns`,
      },
    };
  });

  const raw: RawQuestion[] = JSON.parse(readFileSync(questionsPath, "utf8"));
  const questions: EvalQuestion[] = raw.map((q) => ({
    id: q.id,
    dimension,
    scenario: scenarioId,
    sessionRef: "real-multisession",
    question: q.question,
    referenceAnswer: q.referenceAnswer,
    rubric,
    expectedFacts: q.expectedFacts,
    forbiddenFacts: q.forbiddenFacts,
    metadata: {
      cumulativeTokens: q.cumulativeTokens,
      difficulty: q.difficulty,
      tags: [q.bucket, "real-multisession"].filter((x): x is string => !!x),
    },
  }));

  const totalTokens = sessions.reduce((s, x) => s + x.metadata.totalTokens, 0);

  return [
    {
      id: scenarioId,
      dimension,
      label:
        process.env.REAL_MULTI_LABEL ??
        `Real multi-session (${sessions.length} sessions, ${Math.round(totalTokens / 1000)}K tokens)`,
      description:
        "Several real sessions from one project replayed in order. Tests " +
        "whether Lore's automatic cross-session memory recalls facts from the " +
        "earliest sessions vs a vanilla agent with no prior-session memory.",
      sessions,
      questions,
      // Lore's automatic cross-session memory vs the realistic no-memory agent.
      applicableBaselines: ["lore", "no-memory"],
    },
  ];
}

export const scenarios = load();
