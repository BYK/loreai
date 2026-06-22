import type { Root } from "mdast";
import { serialize, inline, h, ul, liph, strong, t, root } from "./markdown";

// All prompts are locked down — they are our core value offering.
// Do not make these configurable.

export const DISTILLATION_SYSTEM = `You are a memory observer. Your observations will be the ONLY information an AI assistant has about past interactions. Produce a dense, dated event log — not a summary.

CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS

When the user TELLS you something about themselves, mark it as an assertion (🔴):
- "I have two kids" → 🔴 (14:30) User stated has two kids
- "I work at Acme Corp" → 🔴 (14:31) User stated works at Acme Corp

When the user ASKS about something, mark it as a question (🟡):
- "Can you help me with X?" → 🟡 (15:00) User asked for help with X

User assertions are AUTHORITATIVE — the user is the source of truth about their own life.

TEMPORAL ANCHORING — CRITICAL FOR TEMPORAL REASONING:

Each observation has up to two timestamps:
1. BEGINNING: The time the statement was made — ALWAYS include this as (HH:MM)
2. END: The referenced date, if the content refers to a different time — add as "(meaning DATE)" or "(estimated DATE)"

ONLY add "(meaning DATE)" when you can derive an actual date:
- "last week", "yesterday", "next month" → compute and add the date
- "recently", "a while ago", "soon" → too vague, omit the end date

ALWAYS put the date annotation at the END of the observation line.

GOOD: (09:15) User will visit parents this weekend. (meaning Jun 17-18, 2025)
GOOD: (09:15) User's friend had a birthday party last month. (estimated May 2025)
GOOD: (09:15) User prefers hiking in the mountains.
BAD: (09:15) User prefers hiking. (meaning Jun 15, 2025)  ← no time reference, don't add date

If an observation contains MULTIPLE events, split into SEPARATE lines, each with its own date.

STATE CHANGES — make supersession explicit:
- "User will use X (replacing Y)" — not just "User will use X"
- "User moved to Berlin (no longer in London)"

DETAILS TO ALWAYS PRESERVE:
- Names, handles, usernames (@username, "Dr. Smith")
- Numbers, counts, quantities (4 items, 3 sessions, $120)
- Measurements, percentages (5kg, 20% improvement, 85% accuracy)
- Sequences and orderings (steps 1-5, lucky numbers: 7 14 23)
- Prices, dates, times, durations
- Locations and distinguishing attributes
- User's specific role (presenter, volunteer, organizer — not just "attended")
- Exact phrasing when unusual ("movement session" for exercise)

CODE & TECHNICAL ARTIFACTS — ALWAYS PRESERVE VERBATIM:

In coding sessions, the following must be recorded exactly as they appear:
- File paths: src/auth/password.ts, jest.config.ts, .github/workflows/ci.yml
- Function/class/variable names: requireRole(), CreatePostSchema, CODECOV_TOKEN
- Algorithm/library choices WITH rejection reasons: "bcrypt with 12 salt rounds (Argon2 rejected due to library support)"
- Configuration values: port numbers, thresholds (80% coverage), TTLs (300s), retry counts
- Migration/schema names: 20250506_initial_schema, User/Post/Comment/Tag models
- CLI commands and flags: codecov/codecov-action@v4, fail_ci_if_error: true
- Error codes and HTTP status mappings: P2025 → 404, P2002 → 409
- Directory contents when enumerated: "src/auth/ contains: jwt.ts, password.ts, middleware.ts, rate-limiter.ts, routes.ts"
- Test results: "47 tests passing, 3 failing in auth.test.ts"
- Environment variables: DATABASE_URL, NEXT_PUBLIC_API_URL, CODECOV_TOKEN

BAD: 🟡 Added password hashing to the auth module.
GOOD: 🟡 Added bcrypt password hashing (12 salt rounds) in src/auth/password.ts. Argon2 was considered but rejected — better bcrypt library support for Node 20.

BAD: 🟡 Set up CI with code coverage.
GOOD: 🟡 CI uses codecov/codecov-action@v4 with CODECOV_TOKEN secret. fail_ci_if_error: true. Coverage threshold: 80% branch coverage in jest.config.ts.

BAD: 🟡 Created database schema with several models.
GOOD: 🟡 Prisma schema defines 4 models: User, Post, Comment, Tag. Migration 20250506_initial_schema creates all tables + Role enum + _PostToTag join table. Cascade delete on User → Post → Comment.

EXACT NUMBERS — NEVER APPROXIMATE:

When the conversation states a specific count, record that EXACT number — do not round, estimate, or substitute a count you see later. If the same quantity appears with different values at different times, record each with its timestamp.

BAD: All existing entries bulk-updated to cross_project=1 (50 entries)  ← wrong: mixed up with a later count
GOOD: 43 knowledge entries bulk-updated to cross_project=1 via SQL UPDATE  ← exact number from the operation

BAD: ~130 test failures
GOOD: 131 test failures (1902 pass, 131 fail, 1 error across 100 files)  ← preserve exact counts

BUG FIXES AND CODE CHANGES — HIGH PRIORITY:

Every bug fix, code change, or technical decision is important regardless of where it appears in the conversation. Early-session fixes are just as valuable as later ones.

For each fix, record:
- The specific bug/problem (what went wrong)
- The root cause (why it went wrong)
- The fix applied (what changed, with file paths and line numbers)
- The outcome (tests pass, deployed, etc.)

BAD: 🟡 Fixed an FTS5 search bug
GOOD: 🟡 FTS5 was doing exact term matching instead of prefix matching in ltm.ts. Fix: added ftsQuery() function that appends * to each search term for prefix matching. Committed as [hash].

DECISIONS AND ALTERNATIVES — PRESERVE ALL OPTIONS CONSIDERED:

When the assistant evaluates multiple approaches, record EVERY alternative with its name and the reason it was chosen or rejected. The user WILL ask "what else was considered?" later.

For each decision point, record:
- ALL alternatives considered (with their distinguishing names/terms)
- Which was chosen and WHY
- Which were rejected and WHY

BAD: 🟡 Switched to flock for advisory locking.
GOOD: 🟡 Two approaches evaluated for cleanup locking: (1) flock advisory locking — chosen, OS auto-releases on exit including SIGKILL; (2) lock file with staleness check — rejected, race condition window when checking lock age.

BAD: 🟡 Using Redis for caching.
GOOD: 🟡 Caching approach decision: Redis (chosen — supports TTL, pub/sub invalidation) over Memcached (rejected — no persistence) and in-process LRU (rejected — not shared across instances).

DEBUGGING AND INVESTIGATION — PRESERVE HYPOTHESES:

When investigating a bug, record the sequence of hypotheses including wrong ones. The user WILL ask "what was the first theory?" later.

For each investigation, record:
- Initial hypothesis and why it seemed plausible
- Why each wrong hypothesis was ruled out (with specific evidence)
- The actual root cause when found

BAD: 🟡 Found the disk full issue was caused by stale locks.
GOOD: 🟡 Investigation: initial hypothesis was cron job misconfigured/disabled — ruled out because cron was running fine (every day at 3 AM, confirmed via crontab -l). Actual root cause: stale lock file at /var/run/upload-svc/cleanup.lock (PID 28451, from Feb 28 crash) preventing cleanup from running.

ASSISTANT-GENERATED CONTENT — THIS IS CRITICAL:

When the assistant produces lists, recommendations, explanations, recipes, schedules, creative content, or any structured output — record EVERY ITEM with its distinguishing details. The user WILL ask about specific items later.

BAD: 🟡 Assistant recommended 5 dessert spots in Orlando.
GOOD: 🟡 Assistant recommended dessert spots: Sugar Factory (Icon Park, giant milkshakes), Wondermade (Sanford, gourmet marshmallows), Gideon's Bakehouse (Disney Springs, cookies), Farris & Foster's (unique flavors), Kilwins (handmade fudge)

BAD: 🟡 Assistant listed work-from-home jobs for seniors.
GOOD: 🟡 Assistant listed 10 WFH jobs for seniors: 1. Virtual assistant, 2. Online tutor, 3. Freelance writer, 4. Social media manager, 5. Customer service rep, 6. Bookkeeper, 7. Transcriptionist, 8. Web designer, 9. Data entry, 10. Consultant

BAD: 🟡 Assistant explained refining processes.
GOOD: 🟡 Assistant explained Lake Charles refinery processes: atmospheric distillation, fluid catalytic cracking (FCC), alkylation, hydrotreating

Rules for assistant content:
- Record EACH item in a list with at least one distinguishing attribute
- For numbered lists, preserve the EXACT ordering (1st, 2nd, 3rd...)
- For recipes: preserve specific quantities, ratios, temperatures, times
- For recommendations: preserve names, locations, prices, key features
- For creative content (songs, stories, poems): preserve titles, key phrases, character names, structural details
- For technical explanations: preserve specific values, percentages, formulas, tool/library names
- Ordered lists must keep their numbering — users ask "what was the 7th item?"
- Use 🟡 priority but NEVER skip assistant-generated details to save space

ENUMERATABLE ENTITIES — always flag for cross-session aggregation:
When the user mentions attending events, buying things, meeting people, completing tasks — mark with entity type so these can be aggregated across sessions:
🔴 [event-attended] User attended Rachel+Mike's wedding (vineyard in Napa, Aug 12, 2023)
🔴 [item-purchased] User bought Sony WH-1000XM5 headphones ($280, replaced old Bose)
This makes it possible to answer "how many weddings did I attend?" by aggregating across sessions.

BEHAVIORAL ACTION TAGS — flag user actions for cross-session pattern detection:

Tag user behavioral actions with bracketed labels, similar to enumeratable entities.
These tags enable mechanical counting across sessions to detect implicit preferences.

Common action tags:
🔴 [requested-tests] User asked for tests after implementing the POST /users endpoint
🔴 [corrected-style] User corrected let to const for non-reassigned variable
🔴 [rejected-approach] User rejected ORM suggestion, prefers raw SQL
🔴 [requested-error-handling] User asked to add try/catch with proper status codes
🔴 [requested-review] User asked to review code before committing
🔴 [enforced-workflow] User insisted on creating a branch before making changes

Use the most specific tag that fits. Create new tags if none of the above apply —
the format is [verb-noun] in lowercase kebab-case. The same action in different
contexts should use the SAME tag (e.g., [requested-tests] whether testing REST
endpoints, React components, or CLI commands).

Also note when the user does the same thing repeatedly within a session:
GOOD: 🔴 [requested-tests] User consistently requests tests after each implementation (3 times in this session)
BAD: 🟡 (20:22) User asked to write tests for both endpoints.  ← no tag, pattern lost

PRIORITY LEVELS:
- 🔴 High: user assertions, stated facts, preferences, goals, enumeratable entities, behavioral patterns
- 🟡 Medium: questions asked, context, assistant-generated content with full detail
- 🟢 Low: minor conversational context, greetings, acknowledgments

OUTPUT FORMAT — output ONLY observations, no preamble:

<observations>
Date: Jan 15, 2026
* 🔴 (09:15) User stated has two kids: Emma (12) and Jake (9)
* 🔴 (09:16) User's anniversary is March 15
* 🟡 (09:20) User asked how to optimize database queries
* 🔴 [event-attended] (10:00) User attended company holiday party as a presenter (gave talk on microservices)
* 🔴 (11:30) User will visit parents this weekend. (meaning Jan 17-18, 2026)
* 🟡 (14:00) Agent debugging auth issue — found missing null check in auth.ts:45, applied fix, tests pass
* 🟡 (14:30) Assistant recommended 5 hotels: 1. Grand Plaza (near station, $180), 2. Seaside Inn (pet-friendly, $120), 3. Mountain Lodge (pool, free breakfast, $95), 4. Harbor View (historic, walkable, $150), 5. Zen Garden (quietest, spa, $200)
* 🔴 (15:00) User switched from Python to TypeScript for the project (no longer using Python)
</observations>`;

export function distillationUser(input: {
  priorObservations?: string;
  date: string;
  messages: string;
  /** Pre-scanned user assertions to pin in the prompt so the observer
   *  cannot accidentally drop them in large, code-dominated segments. */
  pinnedAssertions?: string;
  /** Pre-scanned tool failures observed in this segment, so the observer
   *  surfaces recurring obstacles instead of dropping them as noise. */
  toolFailures?: string;
}): string {
  const context = input.priorObservations
    ? `Previous observations (do NOT repeat these — your new observations will be appended):\n${input.priorObservations}\n\n---`
    : "This is the beginning of the session.";
  const pinned = input.pinnedAssertions
    ? `\n⚠️ HIGH-PRIORITY USER ASSERTIONS DETECTED IN THIS SEGMENT:\n${input.pinnedAssertions}\nThese statements MUST appear in your observations — they represent user preferences, decisions, or directives that override prior state.\n`
    : "";
  const failures = input.toolFailures
    ? `\n⚙️ TOOL FAILURES OBSERVED IN THIS SEGMENT:\n${input.toolFailures}\nWhen these reflect a recurring obstacle, environment issue, or a fix that had to be worked around, note them in your observations using the [tool-failure] tag.\n`
    : "";
  return `${context}

Session date: ${input.date}
${pinned}${failures}
Conversation to observe:

${input.messages}

Extract new observations. Output ONLY an <observations> block.`;
}

// Meta-distillation prompt using a context-distillation objective: instead of
// reorganizing observations into another event log (which Eyuboglu et al. 2025
// showed is a memorization objective that fails to generalize), produce a
// structured working context optimized for diverse downstream queries.
// This mirrors the Self-Study approach from "Cartridges" (Eyuboglu et al.,
// 2025) where diverse seed prompt types ensure the compressed representation
// supports varied information needs, not just chronological recall.
// Reference: https://arxiv.org/abs/2501.17390
export const RECURSIVE_SYSTEM = `You are a memory reflector. You are given a set of observations from multiple conversation segments. Your job is to consolidate them into a structured working context that will become the agent's entire memory going forward.

IMPORTANT: Your reflections ARE the entirety of the assistant's memory. Any information you omit is permanently forgotten. Do not leave out anything important.

STRUCTURE your output into these sections — each section supports a different type of downstream query:

### Current State
What is in progress right now? Active branches, open files, current task, blockers.
This section answers: "What was I working on?"

### Key Decisions
What was decided and why? Include the alternatives considered and rationale.
This section answers: "Why did we choose approach X?" and "What alternatives were rejected?"

### Technical Changes
Bugs found, root causes, fixes applied, files modified, tests added/fixed.
Preserve exact file paths, line numbers, error messages, and commit references.
This section answers: "What bugs were fixed?" and "What files were changed?"

### Session Timeline
Condensed chronological events with timestamps. Older events compressed more aggressively; recent events retain detail. This section answers: "When did X happen?" and "What was the sequence of events?"

CONSOLIDATION RULES:
- Preserve ALL dates and timestamps — temporal context is critical
- Combine related items (e.g., "agent called view tool 5 times on file x" → single line)
- Merge duplicate facts, keeping the most specific version
- Drop observations superseded by later info (if value changed, keep only final value)
- When consolidating, USER ASSERTIONS take precedence over questions about the same topic
- Preserve all enumeratable entities [entity-type] — these are needed for aggregation questions
- For enumeratable entities spanning multiple segments, create an explicit aggregation:
  🔴 [event-attended] User attended 3 weddings total: Rachel+Mike (vineyard, Aug 2023), Emily+Sarah (garden, Sep 2023), Jen+Tom (Oct 8, 2023)

EXACT NUMBERS: When two segments report different numbers for what seems like the same thing, keep the number from the earlier/original observation — it's likely the correct one from the actual event. Later references may be from memory or approximation.

EARLY-SESSION CONTENT: Bug fixes, code changes, and decisions from the start of a session are just as important as later work. Never drop them just because the segment is short or old. If the first segment contains a specific bug fix with file paths and root cause, it MUST survive into the reflection.

ANCHORED UPDATES: If the prompt includes a <previous-meta-summary> block, treat it as the current consolidated state. Update it using the NEW observation segments — preserve still-true details, remove stale details, and merge in new facts. Keep the same section headings. Do NOT re-derive unchanged sections verbatim unless the new segments contradict them.

Output ONLY an <observations> block with the consolidated observations.`;

export function recursiveUser(
  distillations: Array<{ observations: string }>,
  previousMeta?: string,
): string {
  const entries = distillations.map(
    (d, i) => `Segment ${i + 1}:\n${d.observations}`,
  );
  if (previousMeta) {
    return `Update the anchored meta-summary below using the NEW observation segments. Preserve still-true details, remove stale details, and merge in new facts. Keep the same section headings.

<previous-meta-summary>
${previousMeta}
</previous-meta-summary>

---

New observation segments to merge (chronological order):

${entries.join("\n\n---\n\n")}`;
  }
  return `Observation segments to consolidate (chronological order):

${entries.join("\n\n---\n\n")}`;
}

export const CURATOR_SYSTEM = `You are a long-term memory curator. Your job is to extract durable knowledge from a conversation that should persist across sessions.

Focus ONLY on knowledge that helps a coding agent work effectively on THIS codebase:
- Architectural decisions and their rationale (why something was built a certain way)
- Non-obvious implementation patterns and conventions specific to the project
- Recurring gotchas, constraints, or traps in the codebase — always include WHY the
  wrong approach seems right, not just the trap and fix. Without this, a future session
  will re-propose the broken approach because it looks like a reasonable improvement.
- Environment/tooling setup details that affect development
- Important relationships between components that aren't obvious from reading the code
- User preferences and working style specific to how they use this project.
  Preferences come in three forms — extract ALL:
  (a) Directive: "always", "never", "make sure to", "don't forget to"
  (b) Declarative: "I use X", "I prefer X", "we do X", "our convention is X",
      "I like X", "I don't like X" — these state what the user does/wants without
      imperative language but are equally important preference signals.
  (c) Behavioral: the user repeatedly does the same thing (asks for tests after
      every implementation, corrects the same style issue 3 times, always rejects
      a certain approach). Look for multiple similar events in the observations —
      repetition IS a preference signal even without explicit statements.
  If you see any of these forms, prioritize extracting it as a "preference" entry.
  These represent how the user wants to work and should persist across sessions.

Do NOT extract:
- Task-specific details (file currently being edited, current bug being fixed)
- Temporary state (current branch, in-progress work)
- Information that will change frequently
- Ecosystem descriptions, product announcements, or marketing content
- Business strategy, roadmap, or organizational information
- Information that's readily available in public documentation or READMEs
- Knowledge about unrelated projects or repositories unless explicitly cross-project
- Restatements of what the code obviously does (e.g. "the auth module handles authentication")

INCLUDE THE "WHY" — decisions and gotchas without rationale get undone:
- Every "decision" MUST include the rejected alternative and why it was rejected.
  Format: "Chose X over Y because Z." Without the rejected option, a future session
  will re-propose Y because it looks like a reasonable improvement.
- Every "gotcha" MUST explain why the wrong approach seems correct, not just the trap
  and its fix. Format: "Trap: X looks right because [reason]. Fix: Y, because [reason]."
- Any standard or rule without its rationale is vulnerable to being optimized away by
  a session that doesn't know what problem it was solving.

BREVITY IS CRITICAL — each entry must be concise:
- content MUST be under 150 words (~600 characters). Capture ONE specific actionable
  insight in 2-3 sentences. Prefer terse technical language.
- Each "gotcha": one specific trap + WHY it looks right + its fix in 2-3 sentences
- Each "architecture": one design decision and its key constraint
- Focus on the actionable insight, not the full story behind it
- If a pattern requires more detail, split into multiple focused entries (each under 150 words)
- Omit code examples unless a single short snippet is essential
- Never include full file contents, large diffs, or complete command outputs

PREFER UPDATES OVER CREATES:
- Before creating a new entry, always check if an existing entry covers the same system
  or component. Update the existing entry rather than creating a new one.
- When updating, REPLACE the full content with a concise rewrite — do not append to
  the existing content or repeat what was already there.
- If multiple existing entries cover the same system from different angles (e.g. different
  bugs in the same module), consolidate them: update one with merged insights, delete the
  rest. Fewer, denser entries are better than many scattered ones.

PREFERENCE EVOLUTION — users change their minds:
- When the user indicates a changed preference ("I switched from X to Y", "I no longer
  use X", "I moved to Y", "actually I prefer Y now"), find the existing preference entry
  about X and UPDATE it to reflect Y. Include the reason for the switch if given.
- Do NOT leave contradictory preference entries. If "Uses Mocha for testing" exists and
  the user says "I switched to Vitest", update the Mocha entry to say "Uses Vitest for
  testing (switched from Mocha because ...)" — do not create a second entry.
- Look for evolution signals: "switched to/from", "moved to", "no longer use", "replaced
  X with Y", "actually I prefer", "changed my mind", "used to use X but now".

CROSS-REFERENCES between entries:
- When an entry relates to another entry, reference it with [[entry-uuid]] using the entry's ID
  from the existing entries list. This creates navigable links between entries.
- Only reference entries you can see in the existing entries list — don't guess IDs.
- Example: "Uses the gradient system [[019c904b-791e-772a-ab2b-93ac892a960c]] for context management."

crossProject flag:
- Default is FALSE — knowledge is project-scoped unless you have a concrete reason to share it.
- Set crossProject to true ONLY for genuinely universal *user* preferences that hold regardless of which repo you are in (e.g. tooling/style/workflow habits like "prefers pnpm over npm", "wants conventional-commit messages", "never add emojis").
- Keep crossProject false for anything tied to THIS project: architecture, file paths, naming conventions, migrations, gotchas, decisions, and engineering directives specific to this codebase. These must never leak into other projects.

Confidence values (0.0–1.0) — determines injection priority when budget is tight:
- 1.0: Unconditional directive — user used "NEVER", "ALWAYS", "from now on", or similarly
  absolute language. These must always be respected regardless of context.
- 0.9: Strong preference — explicit user preference ("I prefer", "I want", "make sure to",
  "don't forget to"). Clear intent but not absolute.
- 0.8: Moderate preference — inferred from repeated user behavior or gentle correction across
  sessions. Not explicitly stated as a rule.
- 0.6: Mild/contextual preference — may not apply universally. Observed once or context-dependent.
- For non-preference categories (gotcha, pattern, architecture, decision), confidence reflects
  how well-established the knowledge is: 1.0 = verified/confirmed, 0.8 = high confidence,
  0.6 = probable but unverified.
- Default to 1.0 for preferences with strong directive language, 0.8 for other preferences.
- Always set confidence on create ops — it determines injection priority.

Produce a JSON array of operations:
[
  {
    "op": "create",
    "category": "decision" | "pattern" | "preference" | "architecture" | "gotcha",
    "title": "Short descriptive title",
    "content": "Concise knowledge entry — under 150 words",
    "scope": "project" | "global",
    "crossProject": false,
    "confidence": 1.0
  },
  {
    "op": "update",
    "id": "existing-entry-id",
    "content": "Updated content — under 150 words",
    "confidence": 0.0-1.0
  },
  {
    "op": "delete",
    "id": "existing-entry-id",
    "reason": "Why this is no longer relevant"
  }
]

ENTITY GROUNDING — resolve ambiguous references to canonical names:
- When creating or updating knowledge entries, replace pronouns and nicknames with
  canonical names from the entity context provided: "He approved the PR" → "Bob (backend lead) approved the PR".
  "Deploy to the usual place" → "Deploy to Vercel". This makes entries self-contained.
- If you detect a person, service, tool, organization, repo, or infrastructure component
  NOT in the known entities list, include it in a top-level "entities" field in your response:
  {
    "ops": [ ... ],
    "entities": [
      {
        "type": "person" | "org" | "service" | "tool" | "repo" | "infra",
        "canonical_name": "Full Canonical Name",
        "aliases": [
          { "type": "name" | "email" | "github" | "slack" | "nickname" | "url" | "domain", "value": "..." }
        ],
        "metadata": {
          "description": "brief factual description (e.g. 'CI/CD platform', 'Twitch streamer')",
          "role": "relationship/role relative to user (e.g. 'backend lead', 'my manager', 'contractor')"
        }
      }
    ],
    "relations": [
      {
        "entity_a": "Canonical Name A",
        "entity_b": "Canonical Name B",
        "relation": "friend" | "colleague" | "manager" | "report" | "collaborator" | "client" | "mentor" | "partner",
        "metadata": { "context": "optional note about the relationship" }
      }
    ]
  }
- Include metadata only when the conversation provides clear context about an entity's
  role or description. Omit metadata fields you're unsure about — don't guess.
- For EXISTING entities: if the conversation reveals new metadata (role, description)
  for a known entity, include that entity in "entities" with only the new metadata fields.
  Use the exact canonical_name so the system can merge the metadata.
- Only propose new entities when you are confident they are real, recurring references —
  not one-off mentions of generic concepts. People, services, and tools referenced by name
  are good candidates. Generic phrases like "the database" or "the CI" are not unless they
  map to a specific known service.
- If the entity list is provided and a mention matches a known entity, use its canonical name
  in knowledge entries — do not propose a new entity.
- Only create relations when the conversation explicitly states a relationship.
  "Melkey and I are friends" → relation. "I talked to Melkey" → no relation (just a mention).
  Use the user's canonical name (marked "you (the user)" in the entity list) for self-references.

If nothing warrants extraction, return: { "ops": [], "entities": [], "relations": [] }
The response may also be a plain JSON array of ops (backward compatible): []

Output ONLY valid JSON. No markdown fences, no explanation, no preamble.`;

export function curatorUser(input: {
  messages: string;
  existing: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>;
  entityContext?: string;
}): string {
  const count = input.existing.length;
  const existing = count
    ? `Existing knowledge entries (${count} total — you may update or delete these):\n${input.existing.map((e) => `- [${e.id}] (${e.category}) ${e.title}: ${e.content}`).join("\n")}`
    : "No existing knowledge entries.";
  const entitySection = input.entityContext
    ? `\n\n---\n${input.entityContext}`
    : "";
  return `${existing}${entitySection}

---
Recent conversation to extract knowledge from:

${input.messages}

---
IMPORTANT:
1. Prefer updating existing entries over creating new ones. If a new insight refines or
   extends an existing entry on the same topic, update that entry — don't create a new one.
2. When updating, REPLACE the content with a complete rewrite — never append.
3. If entries cover the same system from different angles, merge them: update one, delete the rest.
4. Only create a new entry for genuinely distinct knowledge with no existing home.
5. Keep all entries under 150 words. If an existing entry is too long, use an update op to trim it.
6. Extract ALL user preferences — both directive ("always do X", "never do Y") AND declarative
   ("I use X", "I prefer X", "our convention is X", "I don't like X"). Both forms are equally
   important. Confidence: 1.0 for absolute directives, 0.9 for explicit preferences.
7. If a user CHANGED a preference ("switched from X to Y", "no longer use X", "moved to Y"),
   find the existing entry about X and UPDATE it — do not leave contradictory entries.
8. Resolve ambiguous references (pronouns, nicknames, abbreviations) to canonical names from
   the entity list. If you detect new recurring entities, include them in the "entities" field.
9. If the conversation reveals relationships between entities (friend, colleague, manager, etc.),
   include them in the "relations" field. Only explicit statements — not inferred from context.`;
}

/**
 * System prompt for the offline entity-extraction pass (entity re-derivation).
 *
 * Unlike the curator, this extracts ONLY entities and relations — no knowledge
 * ops. Used to rebuild the entity registry from historical distillations after
 * data loss. Output is parsed by `curator.parseResponse` (it reads `entities`
 * and `relations`; `ops` is left empty).
 */
export const ENTITY_EXTRACT_SYSTEM = `You are an entity-extraction assistant. Your job is to identify recurring real-world entities — people, organizations, services, tools, repositories, and infrastructure — mentioned in summaries of a user's coding sessions.

For every distinct entity you are confident is a real, recurring reference (not a one-off mention of a generic concept), include it in the "entities" array. When the text explicitly states a relationship between two people (friend, colleague, manager, etc.), include it in "relations".

Output shape (JSON only):
{
  "entities": [
    {
      "type": "person" | "org" | "service" | "tool" | "repo" | "infra",
      "canonical_name": "Full Canonical Name",
      "aliases": [
        { "type": "name" | "email" | "github" | "slack" | "nickname" | "url" | "domain", "value": "..." }
      ],
      "metadata": {
        "description": "brief factual description (e.g. 'CI/CD platform', 'backend engineer')",
        "role": "relationship/role relative to the user (e.g. 'my manager', 'contractor')"
      }
    }
  ],
  "relations": [
    {
      "entity_a": "Canonical Name A",
      "entity_b": "Canonical Name B",
      "relation": "friend" | "colleague" | "manager" | "report" | "collaborator" | "client" | "mentor" | "partner",
      "metadata": { "context": "optional note" }
    }
  ]
}

Rules:
- Only emit entities you are confident are real, recurring named references. People, named services, and named tools are good candidates. Generic phrases like "the database" or "the CI" are NOT entities unless they map to a specific named service.
- If a known entity is provided in the context, reuse its EXACT canonical_name so duplicates merge.
- Include metadata only when the text gives clear context — omit fields you are unsure about, never guess.
- Only emit a relation when the text explicitly states the relationship. "Talked to Alice" is a mention, not a relation.
- Use the user's canonical name (marked "you (the user)" in the entity context, if present) for self-references.
- If nothing warrants extraction, return: { "entities": [], "relations": [] }

Output ONLY valid JSON. No markdown fences, no explanation, no preamble.`;

export function entityExtractUser(input: {
  observations: string;
  entityContext?: string;
}): string {
  const entitySection = input.entityContext
    ? `Known entities (reuse exact canonical names; do not duplicate):\n${input.entityContext}\n\n---\n`
    : "";
  return `${entitySection}Session summaries to extract entities and relations from:

${input.observations}`;
}

/**
 * System prompt for the consolidation pass.
 * Unlike the normal curator (which extracts from conversation), consolidation
 * reviews the FULL entry corpus and aggressively merges/trims/deletes to reduce
 * entry count while preserving the most actionable knowledge.
 */
export const CONSOLIDATION_SYSTEM = `You are a long-term memory curator performing a consolidation pass. The knowledge base has grown too large and needs to be trimmed.

Your goal: reduce the entry count to AT MOST the target maximum while preserving the most valuable knowledge. You MUST produce enough ops to reach the target — returning an empty array is not acceptable.

CONSOLIDATION STRATEGY (apply in order):
1. MERGE related entries — if multiple entries describe the same system, module, or concept
   from different angles (e.g. several bug fixes in the same component), merge them into
   ONE concise entry. Use an "update" op for the surviving entry and "delete" ops for the rest.
2. TRIM verbose entries — any entry over 150 words must be trimmed to its essential insight.
   Use an "update" op with the rewritten content.
3. DELETE low-value entries:
   - Stale entries about bugs that have been fixed and no longer need gotcha warnings
   - Entries whose knowledge is fully subsumed by another entry
   - Entries about one-off incidents with no recurring applicability
   - General advice available in any documentation
4. FORCED EVICTION — if steps 1–3 are insufficient to reach the target, you MUST delete
   the least valuable remaining entries until the count reaches the target. Rank entries by
   recurring impact: entries about rare edge cases or narrow contexts are lower value than
   entries about broadly applicable patterns or frequently encountered gotchas. Each entry is
   annotated "(category[, conf <0-1>][, verifier pass <n>, fail <n>])": prefer evicting entries
   with LOW confidence and/or a poor verifier record (more fail than pass) first, and keep
   entries that have proven reliable (high confidence, more verifier passes). A missing verifier
   annotation means "no signal yet" (neutral) — do not treat it as a poor record.

PRESERVE (highest priority — delete these last):
- Entries describing non-obvious design decisions specific to this codebase
- Entries about recurring traps that a developer would hit again
- Entries that capture a hard-won gotcha with a concrete fix

OUTPUT: A JSON array of "update" and "delete" ops only. No "create" ops — you are not
extracting new knowledge, only consolidating existing knowledge.

- "update": Replace content with a concise rewrite (under 150 words). Use to merge survivors or trim verbose entries.
- "delete": Remove entries that are merged, stale, or low-value.

Output ONLY valid JSON. No markdown fences, no explanation, no preamble.`;

/**
 * Merge-oriented consolidation prompt for the category-focused path. Unlike the
 * trim-to-target CONSOLIDATION_SYSTEM, this instructs the model to merge only
 * genuine semantic DUPLICATES (paraphrases of the same rule) within one
 * category — with NO numeric eviction target — so it never force-deletes
 * distinct entries. Returning an empty array IS acceptable here (means nothing
 * was a true duplicate).
 */
export const CONSOLIDATION_MERGE_SYSTEM = `You are a long-term memory curator. You are given all knowledge entries of a SINGLE category that has grown bloated with near-duplicates. Your ONLY job is to merge genuine duplicates.

Each entry is listed as "- [id] (category[, conf <0-1>][, verifier pass <n>, fail <n>]) title: content". The "conf" and "verifier pass/fail" annotations are an optional VALUE signal: higher confidence and a better verifier record (more pass, fewer fail) mean the entry has proven more reliable in practice. The verifier annotation is present only for entries that have been in a verified session — its ABSENCE means "no signal yet", which is neutral (NOT low-value).

RULES:
1. Find groups of entries that express the SAME underlying rule/fact, just phrased differently (paraphrases). For each such group, pick ONE survivor and "update" it to the clearest concise wording (under 150 words), then "delete" the others. When the paraphrases differ in value, keep the higher-value entry as the survivor (higher confidence, and/or more verifier passes with fewer fails) — fold any unique detail from the others into its wording before deleting them.
2. Do NOT merge entries that are merely related or about the same area but make DISTINCT points. Two different rules are NOT duplicates even if they share words. Opposing rules (e.g. "always use tabs" vs "always use spaces") are NEVER duplicates — never merge them.
3. There is NO target count. If nothing is a true duplicate, return an empty array — that is correct and acceptable.
4. Never invent new knowledge; only "update" survivors and "delete" true duplicates.

OUTPUT: A JSON array of "update" and "delete" ops only (may be empty). No "create" ops.
- "update": { "op": "update", "id": "...", "content": "concise merged wording" }
- "delete": { "op": "delete", "id": "...", "reason": "duplicate of <survivor id>" }

Output ONLY valid JSON. No markdown fences, no explanation, no preamble.`;

/**
 * Compact value annotation for a consolidation entry, shown inside the category
 * parens so the curator can prefer keeping proven-valuable entries (#497). The
 * `[id]` bracket is left untouched so the model still echoes a clean id in ops.
 * Outcome (pass/fail co-occurrence) is appended only when there is a signal.
 */
function consolidationValueTag(e: {
  confidence?: number;
  outcome?: { passes: number; fails: number };
}): string {
  const parts: string[] = [];
  if (typeof e.confidence === "number") {
    parts.push(`conf ${e.confidence.toFixed(2)}`);
  }
  if (e.outcome && (e.outcome.passes > 0 || e.outcome.fails > 0)) {
    parts.push(`verifier pass ${e.outcome.passes}, fail ${e.outcome.fails}`);
  }
  return parts.length ? `, ${parts.join(", ")}` : "";
}

export function consolidationUser(input: {
  entries: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
    /** Current confidence (0–1) — already folds in outcome reward/penalty. */
    confidence?: number;
    /** Within-session verifier co-occurrence record (#497). */
    outcome?: { passes: number; fails: number };
  }>;
  targetMax: number;
  /** "trim" (default): reduce to targetMax via merge+evict. "merge-duplicates":
   *  merge true paraphrases only, no eviction target (focus-category path). */
  mode?: "trim" | "merge-duplicates";
}): string {
  const count = input.entries.length;
  const listed = input.entries
    .map(
      (e) =>
        `- [${e.id}] (${e.category}${consolidationValueTag(e)}) ${e.title}: ${e.content}`,
    )
    .join("\n");

  if (input.mode === "merge-duplicates") {
    return `Knowledge entries in the "${input.entries[0]?.category ?? "?"}" category (${count} total). Merge only genuine duplicates (paraphrases of the same rule); leave distinct entries untouched:

${listed}

Produce update/delete ops to merge true duplicates. If none are duplicates, return [].`;
  }

  const excess = count - input.targetMax;
  return `Current knowledge entries (${count} total, target max: ${input.targetMax}, must remove at least ${excess}):

${listed}

Produce update/delete ops to reduce entry count to at most ${input.targetMax}. Prioritize merging related entries and trimming verbose ones, but if that is insufficient, delete the least valuable entries. You MUST remove at least ${excess} entries.`;
}

// Format distillations for injection into the message context.
// Observations are plain event-log text — inject them directly under a header.
// Optional metadata (id, r_compression, source_ids) adds drill-down hints so
// the model knows how lossy each distillation is and can use recall to fetch
// the full original messages.
export function formatDistillations(
  distillations: Array<{
    observations: string;
    generation: number;
    id?: string;
    r_compression?: number | null;
    source_ids?: string[];
  }>,
): string {
  if (!distillations.length) return "";

  const meta = distillations.filter((d) => d.generation > 0);
  const recent = distillations.filter((d) => d.generation === 0);
  const sections: string[] = ["## Session History"];

  if (meta.length) {
    sections.push("### Earlier Work (summarized)");
    for (const d of meta) {
      sections.push(formatOneDistillation(d));
    }
  }

  if (recent.length) {
    sections.push("### Recent Work (distilled)");
    for (const d of recent) {
      sections.push(formatOneDistillation(d));
    }
  }

  return sections.join("\n\n");
}

/** Render a single distillation with optional metadata header. */
function formatOneDistillation(d: {
  observations: string;
  id?: string;
  r_compression?: number | null;
  source_ids?: string[];
}): string {
  if (!d.id) return d.observations.trim();

  const lossy = d.r_compression != null && d.r_compression < 1.0;
  const sourceCount = d.source_ids?.length ?? 0;
  const meta = [
    `d:${d.id}`,
    lossy ? "lossy" : null,
    sourceCount > 0
      ? `${sourceCount} source${sourceCount > 1 ? "s" : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" | ");
  return `(${meta})\n${d.observations.trim()}`;
}

// TODO: COMPACT_SUMMARY_TEMPLATE and buildCompactPrompt are dead code since
// compaction switched to offline assembly from distillations (PR #672). The
// template + prompt were used by the now-removed `lore-compact` LLM call.
// Remove in a follow-up cleanup PR.
//
// Strict Markdown skeleton for the /compact session summary. Task-oriented
// sections so the next agent starting from the compacted context has a clear
// "where am I, what's next, what's blocked" briefing. Derived from upstream
// OpenCode's SUMMARY_TEMPLATE (session/compaction.ts in #23870) with a "(none)"
// directive added for explicit empty sections and a closing "I'm ready to
// continue." sentinel to preserve Lore's post-compact UX.
export const COMPACT_SUMMARY_TEMPLATE = `Output exactly this Markdown structure. Keep every section in this order, even when empty (use "(none)").

---
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
---

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

// Build the user-facing prompt passed to the compaction agent during /compact.
// Lore injects pre-computed distillations as context separately; this prompt
// just tells the model how to render its summary.
//
// `hasDistillations` is a boolean rather than the full array because this
// function only cares about presence — the distillation bodies are pushed into
// `output.context` separately by the caller. Passing the array shape would be
// misleading dead weight.
//
// `previousSummary` is the prior `/compact` output text (typically from the
// most recent assistant message with `info.summary === true`). When present,
// the prompt asks the model to UPDATE the anchored summary in place rather
// than re-derive from scratch — matching upstream OpenCode's behavior at
// `compaction.ts:121-132` (`buildPrompt`). When absent, the prompt is
// byte-identical to today's non-anchored output.
//
// F1b (this parameter) is OpenCode-specific: the retrieval path uses
// `client.session.messages` to find the prior summary by `info.summary === true`.
// See `findPreviousCompactSummary` in `packages/opencode/src/index.ts`.
export function buildCompactPrompt(input: {
  hasDistillations: boolean;
  knowledge?: string;
  previousSummary?: string;
}): string {
  const distillSection = input.hasDistillations
    ? "Lore has pre-computed chunked summaries of the session history (injected above as context). Use them as the authoritative source — do NOT re-read raw conversation messages that conflict with them.\n\n"
    : "";

  const anchorBlock = input.previousSummary
    ? `A prior compacted summary exists for this session. Update it using the conversation history above: preserve still-true details, remove stale details, and merge in new facts. Keep every section in place.\n\n<previous-summary>\n${input.previousSummary}\n</previous-summary>\n\n`
    : "";

  const knowledgeBlock = input.knowledge ? `\n${input.knowledge}\n` : "";

  return `You are producing a compacted session summary for an AI coding agent. This summary will be the ONLY context available in the next part of the conversation.

${distillSection}${anchorBlock}${COMPACT_SUMMARY_TEMPLATE}
${knowledgeBlock}`;
}

// ~3 chars per token — validated as best heuristic against real API data.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function formatKnowledge(
  entries: Array<{
    id?: string;
    category: string;
    title: string;
    content: string;
  }>,
  maxTokens?: number,
  /**
   * Optional out-param: when provided, it is populated with the `id`s of the
   * entries that were actually rendered (after budget packing). Callers that
   * pin the rendered text (system[2] diff-pin) use this to compute a key set
   * that exactly matches the rendered output, so re-ranking the same set never
   * busts the cache while a genuine selection change always re-pins.
   */
  outIncludedIds?: string[],
): string {
  if (!entries.length) return "";

  // Apply token budget: greedily include entries (already sorted by confidence
  // DESC from the DB query) until the budget is exhausted. Overhead accounts for
  // the section heading and per-entry markdown scaffolding (~50 chars each).
  let included = entries;
  if (maxTokens !== undefined) {
    const HEADER_OVERHEAD = 50; // "## Long-term Knowledge\n### Category\n"
    let used = HEADER_OVERHEAD;
    const fitting: typeof entries = [];
    for (const e of entries) {
      const cost =
        estimateTokens(e.title + e.content) +
        (e.id ? ID_PREFIX_OVERHEAD : 0) +
        10; // per-entry bullet overhead
      if (used + cost > maxTokens) continue; // skip; keep trying smaller entries
      fitting.push(e);
      used += cost;
    }
    included = fitting;
    if (!included.length) return "";
  }

  const grouped: Record<
    string,
    Array<{ title: string; content: string; id?: string }>
  > = {};

  if (outIncludedIds) {
    for (const e of included) {
      if (e.id !== undefined) outIncludedIds.push(e.id);
    }
  }

  for (const e of included) {
    let group = grouped[e.category];
    if (!group) {
      group = [];
      grouped[e.category] = group;
    }
    group.push(e);
  }

  // Canonical layout: relevance ranking decides *selection* (which entries fit
  // the budget above); the rendered *order* is fixed — categories alphabetically,
  // entries alphabetically by title within each category. This makes the output
  // byte-stable for a stable selected set, so re-ranking the same entries does
  // not churn system[2] text and bust the prompt cache.
  const children: Root["children"] = [h(2, "Long-term Knowledge")];
  const categories = Object.keys(grouped).sort();
  for (const category of categories) {
    const items = grouped[category];
    // Sort by title, then content as a deterministic tiebreak so two entries
    // with identical titles don't render in input-dependent (churning) order.
    items.sort((a, b) => {
      if (a.title !== b.title) return a.title < b.title ? -1 : 1;
      return a.content < b.content ? -1 : a.content > b.content ? 1 : 0;
    });
    children.push(h(3, category.charAt(0).toUpperCase() + category.slice(1)));
    children.push(
      ul(
        items.map((i) => {
          const titleText = i.id
            ? `${inline(`[${shortId(i.id)}] `)}${inline(i.title)}`
            : inline(i.title);
          return liph(strong(titleText), t(`: ${inline(i.content)}`));
        }),
      ),
    );
  }

  return serialize(root(...children));
}

/**
 * Per-entry char-cost overhead for the `[xxxxxxxx] ` ID prefix that
 * `formatKnowledge` emits when an entry has an `id`. Used by the budget
 * packer (above) to keep the token estimate honest.
 */
const ID_PREFIX_OVERHEAD = 12;

/** First 8 chars of a UUID — the short, stable handle the delta channel references. */
export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

/** Cap for durable knowledge prompt deltas: max entries per injected message. */
export const DELTA_MAX_ENTRIES = 20;
/** Cap for durable knowledge prompt deltas: max tokens per injected message. */
export const DELTA_TOKEN_BUDGET = 2000;

export type DeltaOp = "new" | "changed" | "removed";

export type DeltaEntry = {
  op: DeltaOp;
  id: string;
  category: string;
  title: string;
  /**
   * New (post-op) content for "new" and "changed"; for "removed" entries this
   * is the *previous* content so the agent can see what was deleted.
   */
  content: string;
};

/**
 * Render a durable knowledge prompt-delta message. The output is byte-deterministic
 * for a given input array (same order, same op prefixes, same punctuation)
 * so that, once injected, the message content is FROZEN — future changes
 * produce a new message, not a modification of this one.
 *
 * Returns "" when `entries` is empty so the caller can skip injection.
 *
 * Greedy packing in `new → changed → removed` order, capped at
 * `DELTA_MAX_ENTRIES` entries and `DELTA_TOKEN_BUDGET` tokens. If the cap
 * truncates, a summary line is appended.
 */
export function formatKnowledgeDelta(entries: DeltaEntry[]): string {
  if (!entries.length) return "";

  const opRank: Record<DeltaOp, number> = { new: 0, changed: 1, removed: 2 };
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) => opRank[a.entry.op] - opRank[b.entry.op] || a.index - b.index,
    )
    .map(({ entry }) => entry);

  // Greedy pack: process entries in deterministic new → changed → removed
  // order, preserving caller order within each group.
  const included: DeltaEntry[] = [];
  const HEADER_OVERHEAD =
    "[System Notification - Knowledge Update]\n" +
    "The following entries supersede any conflicting entries in the system prompt's " +
    "Long-term Knowledge section AND any earlier delta messages with the same short ID.\n\n";
  const EPILOGUE = "\n\nUse the recall tool for full content of any entry.";
  let used = estimateTokens(HEADER_OVERHEAD + EPILOGUE);

  for (const e of sorted) {
    if (included.length >= DELTA_MAX_ENTRIES) break;
    const symbol =
      e.op === "new" ? "+ NEW" : e.op === "changed" ? "~ CHANGED" : "- REMOVED";
    const body = e.op === "removed" ? "" : `\n  ${e.content}`;
    const line = `${symbol} [${shortId(e.id)}] ${e.category}: ${e.title}${body}`;
    const cost = estimateTokens(line);
    if (used + cost > DELTA_TOKEN_BUDGET) break;
    included.push(e);
    used += cost;
  }

  const omitted = sorted.length - included.length;
  let body = included
    .map((e) => {
      const symbol =
        e.op === "new"
          ? "+ NEW"
          : e.op === "changed"
            ? "~ CHANGED"
            : "- REMOVED";
      if (e.op === "removed") {
        return `${symbol} [${shortId(e.id)}] ${e.category}: ${e.title}`;
      }
      return `${symbol} [${shortId(e.id)}] ${e.category}: ${e.title}\n  ${e.content}`;
    })
    .join("\n");

  if (omitted > 0) {
    body += `\n\n(+${omitted} more changes; use the recall tool to inspect.)`;
  }

  return HEADER_OVERHEAD + body + EPILOGUE;
}

// ---------------------------------------------------------------------------
// Query expansion (Phase 4)
// ---------------------------------------------------------------------------

export const QUERY_EXPANSION_SYSTEM = `You are a search query expander for a code knowledge base. Given a search query, generate 2–3 alternative queries that would help find relevant results. Focus on:
- Synonyms and related technical terms
- Different phrasings of the same concept
- Broader or narrower scopes

Return ONLY a JSON array of strings. No explanation, no markdown.

Example:
Input: "SQLite FTS5 ranking"
Output: ["full text search scoring SQLite", "BM25 relevance ranking database", "FTS5 match order by rank"]`;

// ---------------------------------------------------------------------------
// Pattern echo extraction prompt
// ---------------------------------------------------------------------------

export const PATTERN_ECHO_SYSTEM = `You are identifying an implicit user behavioral pattern from repeated observations across multiple coding sessions.

You will receive:
1. The CURRENT distillation observation (what just happened)
2. SIMILAR observations from PRIOR sessions (what happened before in similar situations)

Your task: identify the COMMON BEHAVIORAL PATTERN — what the user consistently does, prefers, or expects. Focus on the USER's behavior, not the assistant's.

Examples of patterns:
- User always asks for tests after implementing a feature
- User always wants error handling wrapped in try/catch with specific status codes
- User corrects variable declarations to use const instead of let
- User requests commit messages in conventional commit format

Respond with a single JSON object:
{
  "title": "Short imperative description (e.g., 'Always add tests after implementing features')",
  "content": "Detailed description of the pattern including when it applies and how to follow it. Under 150 words."
}

Rules:
- The title MUST start with an action word (Always, Never, Prefer, Use, Check, etc.)
- The content should be actionable — an AI assistant reading it should know what to do
- Focus on the USER's preference, not on what the code does
- If you cannot identify a clear behavioral pattern, respond with exactly: null
- Do NOT invent patterns — only extract what is clearly demonstrated across the instances

Output ONLY valid JSON (or null). No markdown fences, no explanation.`;

export function patternEchoUser(input: {
  currentObservations: string;
  echoObservations: string[];
  echoCount: number;
}): string {
  const echoParts = input.echoObservations
    .map((obs, i) => `--- Prior instance ${i + 1} ---\n${obs}`)
    .join("\n\n");

  return `CURRENT SESSION OBSERVATION:
${input.currentObservations}

SIMILAR OBSERVATIONS FROM ${input.echoCount} PRIOR SESSION(S):
${echoParts}

Identify the common behavioral pattern the user is demonstrating across these ${input.echoCount + 1} instances.`;
}
