/**
 * Dimension: Recall — Decision evolution + negative controls (DEC-1).
 *
 * #1403 / #961: tests whether memory surfaces the *current* state of a decision
 * that CHANGED across sessions, and — critically — does NOT resurrect the
 * superseded value. This is the negative-control axis the plan calls for:
 *
 *   - decision-recall questions carry `expectedFacts` = the FINAL decision.
 *   - negative-control questions carry `forbiddenFacts` = the SUPERSEDED value
 *     that must never resurface. A pure negative control passes iff nothing
 *     stale leaks (see recall-score.ts: strict, deterministic, no LLM judge).
 *
 * Two decisions evolve over three sessions:
 *   D1  datastore:   Postgres  →  (session 2) switched to SQLite (embedded/edge)
 *   D2  cache TTL:   30 seconds → (session 3) raised to 5 minutes (300s)
 *
 * Scored two ways, kept separate (no justifier): deterministic retrieval via
 * expectedFacts/forbiddenFacts, and the currency-weighted `preferenceEvolution`
 * rubric for end-task quality. Runs on the lore arms AND the `no-memory`
 * negative-control baseline so a "memory does nothing" arm is measured too.
 */

import type {
  ScenarioDefinition,
  SessionTranscript,
  EvalQuestion,
  ConversationTurn,
  BaselineMode,
} from "../types";
import { RUBRICS } from "../judge";

const APPLICABLE_BASELINES: BaselineMode[] = [
  "lore",
  "lore-context-only",
  "lore-memory-only",
  "tail-window",
  "compaction",
  "no-memory",
];

let toolId = 0;
function tid(): string {
  return `toolu_eval_dec_${String(++toolId).padStart(4, "0")}`;
}

function userText(t: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text: t }] };
}
function text(t: string): ConversationTurn {
  return { role: "assistant", content: [{ type: "text", text: t }] };
}
function toolCall(
  name: string,
  input: unknown,
  preamble?: string,
): { turn: ConversationTurn; id: string } {
  const id = tid();
  const parts: ConversationTurn["content"] = [];
  if (preamble) parts.push({ type: "text", text: preamble });
  parts.push({ type: "tool_use", id, name, input });
  return { turn: { role: "assistant", content: parts }, id };
}
function toolResult(toolUseId: string, output: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: output }],
  };
}

function stamp(
  turns: ConversationTurn[],
  base: number,
  gapMs = 90_000,
): ConversationTurn[] {
  return turns.map((t, i) => ({ ...t, timestamp: base + i * gapMs }));
}
function estimateTokens(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.map((t) => {
    const chars = t.content.reduce((s, p) => {
      if (p.type === "text") return s + p.text.length;
      if (p.type === "tool_result") return s + p.content.length;
      if (p.type === "tool_use") return s + JSON.stringify(p.input).length + 40;
      return s;
    }, 0);
    return { ...t, tokens: t.tokens ?? Math.max(50, Math.ceil(chars / 4)) };
  });
}

const PROJECT = "/tmp/eval-project-dec1";

// =========================================================================
// Session 1 — initial decisions: Postgres + 30s cache TTL
// =========================================================================

const DAY1 = Date.parse("2025-06-02T09:00:00Z");

const s1a = toolCall(
  "write",
  {
    path: "src/db/index.ts",
    content:
      "import { Pool } from 'pg';\n\n// Datastore: PostgreSQL. Chosen for its mature JSON support and the\n// team's existing ops familiarity.\nexport const pool = new Pool({ connectionString: process.env.DATABASE_URL });\n",
  },
  "Setting up the datastore. We'll use PostgreSQL for the backend.",
);
const s1b = toolCall(
  "write",
  {
    path: "src/cache/config.ts",
    content:
      "// Response cache TTL. Starting conservative at 30 seconds so stale data\n// windows stay small while we validate invalidation.\nexport const CACHE_TTL_SECONDS = 30;\n",
  },
  "And a small response cache with a conservative TTL.",
);

const s1Turns = estimateTokens(
  stamp(
    [
      userText(
        "Let's stand up the backend. Pick a datastore and add a basic response cache.",
      ),
      s1a.turn,
      toolResult(s1a.id, "Wrote src/db/index.ts (PostgreSQL pool)."),
      text(
        "Datastore decision: **PostgreSQL** — mature JSON support and the team already runs it in ops. This is the datastore of record for now.",
      ),
      s1b.turn,
      toolResult(s1b.id, "Wrote src/cache/config.ts (CACHE_TTL_SECONDS = 30)."),
      text(
        "Response cache added with a **30-second TTL** (`CACHE_TTL_SECONDS = 30`) — conservative to keep stale windows small during validation.",
      ),
    ],
    DAY1,
  ),
);

const session1: SessionTranscript = {
  id: "dec1-session-1",
  label: "Initial backend: Postgres + 30s cache",
  projectPath: PROJECT,
  turns: s1Turns,
  metadata: {
    totalTokens: s1Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description:
      "Initial decisions: datastore = PostgreSQL; cache TTL = 30 seconds. " +
      "Both are SUPERSEDED in later sessions (negative-control anchors).",
  },
};

// =========================================================================
// Session 2 — D1 supersede: Postgres -> SQLite (embedded/edge requirement)
// =========================================================================

const DAY2 = Date.parse("2025-06-05T10:00:00Z");

const s2a = toolCall(
  "write",
  {
    path: "src/db/index.ts",
    content:
      "import Database from 'better-sqlite3';\n\n// Datastore: SQLite (better-sqlite3). SWITCHED from PostgreSQL: the product\n// now ships as a single self-contained edge binary with no external DB\n// process, so an embedded store is required.\nexport const db = new Database(process.env.DB_PATH ?? 'app.db');\n",
  },
  "New requirement: we ship as a single edge binary now, so we must drop the external Postgres process and move to an embedded store.",
);

const s2Turns = estimateTokens(
  stamp(
    [
      userText(
        "Product change: this now ships as one self-contained edge binary — no separate database server. Update the datastore accordingly.",
      ),
      s2a.turn,
      toolResult(s2a.id, "Rewrote src/db/index.ts (better-sqlite3)."),
      text(
        "Datastore decision **changed**: we are **switching from PostgreSQL to SQLite** (`better-sqlite3`). The edge-binary requirement rules out an external DB process, so SQLite is now the datastore of record. Postgres is no longer used.",
      ),
    ],
    DAY2,
  ),
);

const session2: SessionTranscript = {
  id: "dec1-session-2",
  label: "Datastore switched to SQLite",
  projectPath: PROJECT,
  turns: s2Turns,
  metadata: {
    totalTokens: s2Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description:
      "D1 superseded: datastore Postgres → SQLite (edge-binary requirement). " +
      "Postgres is now the stale/forbidden value.",
  },
};

// =========================================================================
// Session 3 — D2 supersede: cache TTL 30s -> 300s (5 minutes)
// =========================================================================

const DAY3 = Date.parse("2025-06-09T11:00:00Z");

const s3a = toolCall(
  "write",
  {
    path: "src/cache/config.ts",
    content:
      "// Response cache TTL. RAISED from 30s to 5 minutes: profiling showed the\n// 30-second window caused a thundering-herd of upstream refetches under load;\n// the data tolerates 5-minute staleness.\nexport const CACHE_TTL_SECONDS = 300;\n",
  },
  "Profiling shows the 30s TTL causes a refetch stampede under load. The data tolerates more staleness, so I'll raise the TTL.",
);

const s3Turns = estimateTokens(
  stamp(
    [
      userText(
        "We're seeing a refetch stampede under load. The cached data can tolerate a few minutes of staleness — adjust the cache.",
      ),
      s3a.turn,
      toolResult(
        s3a.id,
        "Updated src/cache/config.ts (CACHE_TTL_SECONDS = 300).",
      ),
      text(
        "Cache TTL decision **changed**: **raised from 30 seconds to 5 minutes** (`CACHE_TTL_SECONDS = 300`) to stop the thundering-herd refetch stampede. 5 minutes is the current TTL of record; the old 30-second value no longer applies.",
      ),
    ],
    DAY3,
  ),
);

const session3: SessionTranscript = {
  id: "dec1-session-3",
  label: "Cache TTL raised to 5 minutes",
  projectPath: PROJECT,
  turns: s3Turns,
  metadata: {
    totalTokens: s3Turns.reduce((s, t) => s + (t.tokens ?? 0), 0),
    description:
      "D2 superseded: cache TTL 30s → 300s (5 min). 30s is now stale/forbidden.",
  },
};

// =========================================================================
// Questions — decision-recall (current value) + negative controls (stale)
// =========================================================================

const questions: EvalQuestion[] = [
  // --- D1: datastore ------------------------------------------------------
  {
    id: "dec1-q1-current-datastore",
    dimension: "recall",
    scenario: "dec-1-decision-evolution",
    sessionRef: "dec1-session-2",
    question: "What datastore does this project currently use, and why?",
    referenceAnswer:
      "SQLite (better-sqlite3). It was switched from PostgreSQL because the product now ships as a single self-contained edge binary with no external database process, so an embedded store is required.",
    rubric: RUBRICS.preferenceEvolution,
    // "why" invites the switch rationale, so mentioning Postgres historically is
    // correct — only the CURRENT datastore is anchored here. The strict stale-
    // value negative control is q2.
    expectedFacts: ["SQLite"],
    metadata: {
      difficulty: "medium",
      tags: ["decision-recall", "datastore"],
    },
  },
  {
    id: "dec1-q2-datastore-negctl",
    dimension: "recall",
    scenario: "dec-1-decision-evolution",
    sessionRef: "dec1-session-2",
    question:
      "Name the datastore currently in use. Answer with only the datastore in effect now — no history.",
    referenceAnswer: "SQLite.",
    rubric: RUBRICS.preferenceEvolution,
    // Strict negative control: asked for the current datastore only, so
    // surfacing the superseded Postgres is a stale-value leak.
    expectedFacts: ["SQLite"],
    forbiddenFacts: ["PostgreSQL", "Postgres"],
    metadata: {
      difficulty: "hard",
      tags: ["negative-control", "supersession", "datastore"],
    },
  },
  // --- D2: cache TTL ------------------------------------------------------
  {
    id: "dec1-q3-current-ttl",
    dimension: "recall",
    scenario: "dec-1-decision-evolution",
    sessionRef: "dec1-session-3",
    question:
      "What is the current response-cache TTL, and why was it set that way?",
    referenceAnswer:
      "5 minutes (CACHE_TTL_SECONDS = 300). It was raised from 30 seconds because the 30-second window caused a thundering-herd of upstream refetches under load, and the data tolerates 5-minute staleness.",
    rubric: RUBRICS.preferenceEvolution,
    // This question explicitly asks for the rationale ("why"), so a correct
    // answer legitimately recounts the 30s→5min history. Only the CURRENT value
    // is anchored here; the stale-value negative control lives in the strict
    // "give the current number" question (q4) so we never penalize a correct
    // evolution narrative for mentioning the past.
    expectedFacts: ["5 minutes"],
    metadata: {
      difficulty: "medium",
      tags: ["decision-recall", "cache-ttl"],
    },
  },
  {
    id: "dec1-q4-ttl-value-negctl",
    dimension: "recall",
    scenario: "dec-1-decision-evolution",
    sessionRef: "dec1-session-3",
    question:
      "In one line, what number is CACHE_TTL_SECONDS set to right now? Answer with only the current value, no history.",
    referenceAnswer: "300.",
    rubric: RUBRICS.preferenceEvolution,
    expectedFacts: ["300"],
    // Strict negative control: asked for the current value only, so surfacing
    // the superseded "30" (as a standalone token) is a stale-value leak. Word-
    // boundary matching (recall-score.ts) ensures "300" does not match "30".
    forbiddenFacts: ["30"],
    metadata: {
      difficulty: "hard",
      tags: ["negative-control", "supersession", "cache-ttl"],
    },
  },
];

export const scenarios: ScenarioDefinition[] = [
  {
    id: "dec-1-decision-evolution",
    name: "DEC-1: Decision Evolution + Negative Controls",
    dimension: "recall",
    applicableBaselines: APPLICABLE_BASELINES,
    sessions: [session1, session2, session3],
    questions,
  },
];
