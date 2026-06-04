/**
 * Mega-session eval scenario: Real 2.3M-token getsentry/cli refactoring session.
 *
 * Extracted from Lore DB session ses_33198e726ffeDyEZ4ZoowIUDJO.
 * 5-day session (Mar 8-12, 2026) with 95 user turns, 3959 assistant turns.
 * Multiple PRs, architectural decisions, multi-phase migration, code reviews.
 *
 * No inflation needed — this IS the 2.3M token scenario.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import type {
  ScenarioDefinition,
  ConversationTurn,
  EvalQuestion,
  Dimension,
} from "../types";

// Load the extracted session turns from compressed JSON fixture
const fixtureDir = join(import.meta.dir, ".");
const compressed = readFileSync(
  join(fixtureDir, "cli-refactor-session.json.gz"),
);
const turns: ConversationTurn[] = JSON.parse(gunzipSync(compressed).toString());

const dimension: Dimension = "context";
const scenarioId = "mega-cli-refactor";

const base = {
  dimension,
  scenario: scenarioId,
  sessionRef: "cli-refactor",
  rubric: {
    criteria: [
      {
        name: "accuracy",
        description: "Does the answer correctly match the reference?",
        scale: {
          1: "Wrong or fabricated answer" as const,
          3: "Partially correct — has the right topic but wrong specifics" as const,
          5: "Exactly matches the reference with correct specifics" as const,
        },
      },
    ],
    weights: { accuracy: 1.0 },
  },
};

// ---------------------------------------------------------------------------
// Questions targeting various depths of the 2.3M-token session
// ---------------------------------------------------------------------------

const questions: EvalQuestion[] = [
  // =========================================================================
  // EASY — late session (turns 70-95, last ~300K tokens)
  // Recent work that should be in the raw tail window
  // =========================================================================
  {
    ...base,
    id: "mega-e1",
    question:
      "What was the final phase being worked on at the end of the session?",
    referenceAnswer:
      "Phase 6 (and 6b) — removing direct stdout/stderr usage from remaining commands " +
      "and switching them to the return-based output system. The user also mentioned " +
      "'auth login' as a command that uses the same architecture but is fundamentally " +
      "different from list commands.",
    metadata: { difficulty: "easy", tags: ["late-session", "phase"] },
  },
  {
    ...base,
    id: "mega-e2",
    question:
      "What PR was being reviewed for Bugbot comments near the end of the session?",
    referenceAnswer:
      "PR #394 — the user referenced https://github.com/getsentry/cli/pull/394#discussion_r2920036806 " +
      "with review feedback about streaming output and logger.info() calls.",
    metadata: { difficulty: "easy", tags: ["late-session", "pr"] },
  },
  {
    ...base,
    id: "mega-e3",
    question:
      "What was the user's instruction about Phase 6 and 7 being marked as 'future'?",
    referenceAnswer:
      "The user said Phase 6 and 7 should NOT be 'future' — they should be done " +
      "once Phase 5 is merged. The user pushed back on deferring these phases.",
    metadata: { difficulty: "easy", tags: ["late-session", "directive"] },
  },
  {
    ...base,
    id: "mega-e4",
    question:
      "What command did the user repeatedly tell the assistant to run for checking CI failures?",
    referenceAnswer:
      "gh run view --log-failed --job $(gh pr checks $PR_NO --json state,link " +
      '-q \'.[] | select(.state == "FAILURE").link | split("/")[-1]\') — ' +
      "used repeatedly throughout the session after each push.",
    metadata: { difficulty: "easy", tags: ["pattern", "ci"] },
  },
  {
    ...base,
    id: "mega-e5",
    question: "What did the user say about the AGENTS.md file in the PR?",
    referenceAnswer:
      "The user said 'The change in AGENTS.md is completely irrelevant. Clean up this " +
      "file to remove all irrelevant entries.' The AGENTS.md changes were auto-managed " +
      "and not part of the intended PR.",
    metadata: { difficulty: "easy", tags: ["mid-session", "directive"] },
  },

  // =========================================================================
  // MEDIUM — mid session (turns 30-60, ~500K-1.5M token range)
  // Architectural decisions and design debates
  // =========================================================================
  {
    ...base,
    id: "mega-m1",
    question:
      "What was the architectural vision for the template-based output system?",
    referenceAnswer:
      "Commands become 'data producers' — the framework selects a template " +
      "(JSON, plain text, rendered markdown) based on flags. Commands describe " +
      "*what* to output; the framework decides *how*. This was a four-phase " +
      "convergence plan.",
    metadata: { difficulty: "medium", tags: ["architecture", "design"] },
  },
  {
    ...base,
    id: "mega-m2",
    question:
      "What was the user's position on tuples vs objects for command return values?",
    referenceAnswer:
      "The user asked 'are tuples really cheaper than using a simple object?' and " +
      "the assistant confirmed. The user accepted tuples but wanted the simplest " +
      "approach — they said they were fine with {data, footer} or [data, footer], " +
      "whichever is cheaper and more maintainable. They objected to defining footer " +
      "as a separate function during declaration as 'too rigid'.",
    metadata: { difficulty: "medium", tags: ["design-debate", "decision"] },
  },
  {
    ...base,
    id: "mega-m3",
    question: "What did the user say about consola's spinner functionality?",
    referenceAnswer:
      "The user asked 'Does consola have a spinner helper?' and then 'can we make " +
      "the spinner use process.stderr or process.stdout internally?' followed by " +
      "'wait, would that cause issues with our tests?' — showing concern about " +
      "test compatibility with spinner output.",
    metadata: { difficulty: "medium", tags: ["mid-session", "consola"] },
  },
  {
    ...base,
    id: "mega-m4",
    question:
      "Why did the user want to remove the --include flag from the api command?",
    referenceAnswer:
      "The user asked to check Sentry traces (org: 'sentry', project: 'cli') to " +
      "see if the -i or --include flag was ever used with api calls. The traces " +
      "showed it was never used, so the user approved removal.",
    metadata: { difficulty: "medium", tags: ["decision", "sentry-traces"] },
  },
  {
    ...base,
    id: "mega-m5",
    question: "What was PR #373 about?",
    referenceAnswer:
      "PR #373 was about the --fields flag for context-window-friendly JSON output. " +
      "The problem was that every --json command dumped the full object, wasting agent " +
      "tokens. The --fields flag lets agents request only the specific fields they need.",
    metadata: { difficulty: "medium", tags: ["pr", "feature"] },
  },
  {
    ...base,
    id: "mega-m6",
    question:
      "What was the user's core frustration with the assistant's approach to stdout/stderr in commands?",
    referenceAnswer:
      "The user was frustrated that the assistant kept using direct stdout/stderr " +
      "writes and manual output in commands instead of the return-based system. " +
      "The user explicitly said: 'which part of \"do not use stderr or stdout or " +
      "manual writes there directly, always use return-based output\" you don't " +
      "understand?' (referring to src/commands/api.ts).",
    metadata: { difficulty: "medium", tags: ["frustration", "directive"] },
  },
  {
    ...base,
    id: "mega-m7",
    question: "What was the user's argument about JSON output consistency?",
    referenceAnswer:
      "The user argued: (1) JSON output should be consistent as it's machine-consumed, " +
      "conditionals make things harder especially with tools like jq. (2) The user " +
      "suggested the api command output should NOT be conditional on --dry-run (json " +
      "vs human readable) — it should be consistent. They considered adding --no-json " +
      "or --json=false for users who want human-readable output from api.",
    metadata: { difficulty: "medium", tags: ["design", "consistency"] },
  },

  // =========================================================================
  // HARD — early session (turns 1-25, first ~500K tokens)
  // First issue, implementation details, specific code
  // =========================================================================
  {
    ...base,
    id: "mega-h1",
    question:
      "What was the very first issue selected from the open issues list, and why?",
    referenceAnswer:
      "Issue #350 — Input hardening against agent hallucinations. It was chosen " +
      "because of security impact (defense-in-depth against URL injection via " +
      "org/project slugs interpolated into API paths).",
    metadata: {
      difficulty: "hard",
      tags: ["early-session", "issue-selection"],
    },
  },
  {
    ...base,
    id: "mega-h2",
    question: "What branch name was used for the first issue's implementation?",
    referenceAnswer: "feat/input-hardening",
    metadata: { difficulty: "hard", tags: ["early-session", "branch"] },
  },
  {
    ...base,
    id: "mega-h3",
    question: "What function was created for input validation in the first PR?",
    referenceAnswer:
      "validateResourceId — a function to validate all slug/ID components as they're " +
      "parsed in arg-parsing.ts. It was part of the input hardening against agent " +
      "hallucinations (Issue #350).",
    metadata: { difficulty: "hard", tags: ["early-session", "code"] },
  },
  {
    ...base,
    id: "mega-h4",
    question: "What was the second issue worked on after merging PR #370?",
    referenceAnswer:
      "Magic @ selectors (@latest, @most_frequent) for issue commands — " +
      "PR #371 on branch feat/magic-selectors.",
    metadata: { difficulty: "hard", tags: ["early-session", "issue-sequence"] },
  },
  {
    ...base,
    id: "mega-h5",
    question:
      "How many tests were passing in the full test suite during the first PR?",
    referenceAnswer:
      "359 tests passed in the full test suite, plus 19 property tests for " +
      "the input hardening work specifically.",
    metadata: { difficulty: "hard", tags: ["early-session", "test-counts"] },
  },
  {
    ...base,
    id: "mega-h6",
    question:
      "What user feedback prompted adding magic selector info to help text?",
    referenceAnswer:
      "The user said: 'could we add the magic selector info to sentry issue/sentry " +
      "issue --help? this could help agents' — and then asked 'any other commands " +
      "you think we can add this to?'",
    metadata: { difficulty: "hard", tags: ["early-session", "user-feedback"] },
  },
  {
    ...base,
    id: "mega-h7",
    question: "What was the coverage requirement the user enforced across PRs?",
    referenceAnswer:
      "Patch coverage above 80%. The user referenced Codecov reports on PRs #370 " +
      "and #371 specifically, asking to bump the coverage above 80% each time.",
    metadata: { difficulty: "hard", tags: ["cross-session", "coverage"] },
  },
  {
    ...base,
    id: "mega-h8",
    question:
      "What was the user's reasoning for wanting to remove writeResponseBody() from the codebase?",
    referenceAnswer:
      "The user insisted on removing writeResponseBody() and switching to the " +
      "return-based system. When the assistant suggested leaving it as 'harmless' " +
      "since it was 'still exported and tested, just not called internally', the " +
      "user explicitly said 'No remove this.' The principle was: no backward-compat " +
      "stubs — remove dead code entirely.",
    metadata: { difficulty: "hard", tags: ["mid-session", "code-cleanup"] },
  },
];

// ---------------------------------------------------------------------------
// Scenario definition
// ---------------------------------------------------------------------------

const scenario: ScenarioDefinition = {
  id: scenarioId,
  dimension,
  label: "Mega CLI Refactor (2.3M tokens)",
  description:
    "Real 5-day getsentry/cli refactoring session — 2.3M tokens, 95 user turns, " +
    "multiple PRs, architectural decisions, multi-phase migration. Tests recall " +
    "of specific details across extreme context depths.",
  sessions: [
    {
      id: "cli-refactor",
      label: "CLI Refactoring Session",
      projectPath: "/workspace/getsentry-cli",
      turns,
      metadata: {
        totalTokens: 2374811,
        description:
          "5-day CLI refactoring: Issue #350 → PRs #370-394+, buildCommand migration",
      },
    },
  ],
  questions,
  applicableBaselines: ["lore", "compaction"],
};

export default scenario;
