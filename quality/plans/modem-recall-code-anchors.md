# Learning from Modem's "How coding agents read your code" → Lore

Source: https://modem.dev/blog/how-coding-agents-read-your-code (Ben Vinegar, Modem, Jul 20 2026)

## EXECUTION STATUS (branch `feat/recall-code-anchors`)

- ✅ **Direction 2 (code anchors in recall)** — IMPLEMENTED. Closes the half-built
  file:line-pointer loop: the reference-validity pass already resolved every cited ref
  but discarded the result; now it persists resolved-OK anchors and recall renders them.
  - `db.ts`: migration v74 + `recoverMissingObjects` self-heal — new `knowledge_ref_anchor`
    table (logical_id, kind, anchor, updated_at).
  - `ltm.ts` `validateProjectReferences`: persist resolved-OK file (with line) + symbol
    anchors, rewritten in full per resolved entry (removed refs drop out). `total===0`
    (all-unknown) entries keep prior anchors — "cannot verify ≠ broken" applies to anchors.
  - `ltm.ts` `knowledgeRefAnchors(logicalIds)` batch loader + `KnowledgeRefAnchor` type +
    `MAX_RECALL_ANCHORS_PER_ENTRY=3` (file anchors ordered before symbols).
  - `recall.ts`: `renderAnchors` helper; knowledge + cross-knowledge + id-detail branches
    append ` ↳ src/foo.ts:42, bar()`. Batch-loaded once per result set in `formatFusedResults`.
    NOT wired into `formatKnowledge` (system prompt) — avoids prompt-cache churn.
  - Tests: `ltm-reference-validity.test.ts` (anchor persistence, rewrite, cap, symbol,
    neutral-on-unknown) + new `recall-code-anchors.test.ts` (rendering). 34 passing.
- ✅ **Direction 1a (curator title guidance)** — IMPLEMENTED. `prompt.ts`: DISCOVERABLE
  TITLES section in `CURATOR_SYSTEM` + item 10 in `curatorUser` IMPORTANT list. Test in
  `prompt.test.ts`. **Shipped in PR #1414 (merged).**
- ✅ **Direction 1c (pattern-extract title cleanup)** — IMPLEMENTED. `pattern-extract.ts`:
  `isNoisyTitle()` gate rejects a minted title when it exceeds a word/char cap or carries
  clause-punctuation (`; : ( )` / `N)` enumerator) that only appears when prose leaked past
  the `,`/`.` capture boundary. Gate is on the FINAL title (not per-capture) so a trailing
  `because Y` clause doesn't drop a clean "Going with X"; `Convention:` prefix colon is
  exempted. Tests in `pattern-extract.test.ts` (noisy-title rejection + no-over-reject),
  mutation-verified.
- ✅ **Direction 1b (re-titleable update op)** — IMPLEMENTED. `ltm.update()` gains an optional
  `title`; a title (or content) change appends a new version, re-indexes FTS, and re-embeds.
  Collision guard `titleCollides()` mirrors create()'s scope logic and DROPS a re-title that
  would duplicate another live entry's title in the same scope (project + cross pool, or
  global/cross pool) — never creates a silent duplicate. Curator `update` op gains optional
  `title` (type-guarded, length-capped `MAX_ENTRY_TITLE_LENGTH`); prompt + consolidation
  guidance updated to re-title survivors whose scope broadened. Tests: `ltm-retitle.test.ts`
  (version append, FTS reindex, collision-drop, case-only self, content+title, idempotent) +
  `curator-retitle.test.ts` (apply-path threading, collision via curator, backward-compat).
  Collision guard mutation-verified.
- ⬜ Remaining (follow-ups): D2c (entry↔file association), D3 (blog post).

---

## The article's thesis (one line)

Coding agents navigate code by **literal text search** (grep/ripgrep), not by semantic
graphs. So **discoverability is a property of the words you write**: specific names grep to
one place (`createStripeClient` → 43 hits), generic names bury the answer in a haystack
(`create` → 1,585 hits). Better names/types/comments/file-organization measurably cut
tokens, turns, and confidently-wrong answers. Their experiments: 6–66% fewer tokens on
weak-author code, wrong answers went to zero, bug-hunt accuracy 23/32 → 32/32 after a
discoverability refactor.

## Why this is directly relevant to Lore

Lore is *also* a search-driven retrieval system over text. The exact same principle governs
Lore's own recall — and the evidence is in Lore's own code:

- Knowledge search is **FTS5 BM25 + vector, fused with RRF** (`recall.ts:642`,
  `search.ts:516`). The keyword half is literal-token prefix matching — grep with ranking.
- **A knowledge entry's `title` is weighted 3× its content**: `bm25(knowledge_fts, 6.0,
  2.0, 3.0)` over columns `(title, content, category)` (`config.ts:750`, `db.ts:207`).
  Title is *also* the exact-match dedup identity key (`ltm.ts:317`) and the lead token the
  agent sees in every recall hit (`recall.ts:562`).
- The relaxed query cascade drops the **least-discriminative** term first by IDF
  (`search.ts:190,309`) and boosts exact matches (`search.ts:555`) — Lore already rewards
  discriminative terms exactly the way grep rewards specific names.

**So a knowledge entry's title is to Lore's recall what a function name is to a grep-first
agent.** A specific title ("createStripeClient auth header injection") retrieves in one hop;
a generic title ("Client creation bug") drops the agent into the multi-hit haystack.

**The gap:** Lore's retrieval mechanically *rewards* discoverable titles, but nothing that
*writes* titles is told to make them discoverable. The curator prompt's entire title
instruction is `"title": "Short descriptive title"` (`prompt.ts:460`). Every quality bullet
(the "why" requirement `:350`, brevity `:397`, entity grounding `:479`) targets **content**.

Lore also already tells the agent the right thing about *user code* — the recall tool
description says memory is "a POINTER, not the source of truth… find WHERE something is (the
file path / file:line / symbol), then READ that file" (`recall.ts:1594`). But it can't
deliver on that promise structurally: the `references.ts` machinery extracts file:line/symbol
refs **only for staleness validation**, then discards them (only broken/total counts survive
in `knowledge_ref_validity`, `db.ts:1501`). Refs are **never rendered** into recall output
(`recall.ts:558`) or the injected knowledge block (`formatKnowledge`, `prompt.ts:990`).

---

## Direction 1 — Make Lore's OWN knowledge discoverable (highest leverage, lowest risk)

### 1a. Add a "DISCOVERABLE TITLES" section to the curator prompt  ⭐ primary win

Insert a new section in `CURATOR_SYSTEM` (`prompt.ts`, after the "WHY" block ~L357 or before
`BREVITY IS CRITICAL` ~L397), matching the existing ALL-CAPS-header + dashed-bullet +
`BAD:`/`GOOD:` house style already used in `DISTILLATION_SYSTEM` (`prompt.ts:70-85`).

Guidance to encode (this is the article's lesson, translated to titles):
- Put the **specific, discriminative terms a future session will search** into the title:
  the symbol name, file, error code, tool, or proper noun — not a generic noun.
- Aim for **2–3 content words**, at least one a domain term (mirrors Modem's uniqueness
  data: 1 word ~61% unique, 2 words ~88%, 3 words ~96%).
- The title is the highest-weighted search key AND the dedup identity — a vague title both
  hides the entry and risks colliding/merging with unrelated entries.

Example contrast to include:
```
BAD:  "Client creation bug"
GOOD: "createStripeClient drops Authorization header on retry"
BAD:  "Migration gotcha"
GOOD: "v55 knowledge_meta migration boot-loops if DROP COLUMN precedes backfill"
```

Also update the `curatorUser` numbered `IMPORTANT` list (`prompt.ts:554-569`) with a one-line
reminder, since it currently covers updates/brevity/entities/relations but never titles.

**Risk:** low — prompt-only. **Verify:** existing curator tests still pass; optionally a
prompt-content assertion. Real signal is qualitative (future entry titles get specific).

### 1b. Allow the `update` op to rewrite a stale title

The curator `update` op schema has **no `title` field** (`prompt.ts:467-471`), and
consolidation keeps the survivor's original title even after merging broadens its content
(`CONSOLIDATION_SYSTEM:637`, `CONSOLIDATION_MERGE_SYSTEM:682`). So a merged/expanded entry
carries a title that no longer describes it — a discoverability regression baked into the
data model.

- Add optional `title` to the `update` op schema + curator apply path (`curator.applyOps`).
- Confirm `ltm.update()` can change title without breaking append-only versioning, the
  `LOWER(title)` dedup key (`ltm.ts:317`), and FTS re-index. **This needs a code check** —
  title is an identity key, so re-titling must not orphan refs or collide.
- Add a consolidation instruction: when merging, rewrite the survivor's title to cover the
  merged scope.

**Risk:** medium — touches identity/dedup/versioning. Needs adversarial review. Could ship
1a first (pure win) and 1b as a follow-up.

### 1c. Improve non-LLM pattern-extraction titles

`pattern-extract.ts` builds titles as `prefix + raw capture group` bounded by
`(.+?)(?:\.|,|$)` (`:44-139`, applied `:176`) — captures can be long, noisy prose ("Always
the same: the agent never called the save step in the first"; several such entries already
exist in this repo's `.lore.md`). Code-only fix (no LLM here):
- Cap/normalize captured text (length cap, trim trailing prose), prefer the first
  tech token.
- Consider gating: if a capture is too generic/long, skip minting rather than create a
  low-discoverability entry (pattern-extract is already best-effort).

**Risk:** low-medium. **Verify:** `pattern-extract` tests + add cases for noisy captures.

---

## Direction 2 — Help the agent navigate the USER's code (medium leverage, more design)

Lore's recall tool *promises* to be a file:line/symbol locator but structurally can't
deliver — the refs it extracts are thrown away after validation. Close that loop so recall
hits point the agent straight at code, cutting its grep/read loops (the article's core cost).

### 2a. Persist extracted references instead of discarding them
Today `extractReferences()` (`references.ts`) parses `file:line`/command/symbol refs at
validation time; only broken/total **counts** persist (`knowledge_ref_validity`, `db.ts:1501`).
Persist the resolved `Reference[]` (path, line, symbol, last-resolved status) in a new
`knowledge_ref` table so they're available to render. (Aligns with the closed-#1231 decision:
pointer + Read beats memorized value — but the pointer must actually reach the agent.)

### 2b. Render resolved refs in recall output + knowledge block
- `renderResultLine` knowledge branch (`recall.ts:559`): append resolved anchors, e.g.
  `↳ src/auth/stripe-client.ts:42`, so the agent can jump instead of grepping.
- Optionally in `formatKnowledge` (`prompt.ts:990`) for system-prompt entries — but weigh
  prompt-cache stability (that block is byte-stable-sorted; adding volatile refs could churn
  the cache). Likely recall-output-only to start.
- Only render refs currently resolvable (respect "cannot verify ≠ broken",
  `references.ts:12`) — never show a stale/broken pointer as a jump target.

**Risk:** medium — new table + migration + rendering + cache-stability consideration.
Sequence after Direction 1. Adversarial review required (cross-project leak risk in any new
query path — cf. `vectorSearchDistillations` not being project-scoped, k:019f43a4).

### 2c. (Optional, larger) associate entries with the files they concern
No stored knowledge↔file association exists today (`tool_calls` has no path column,
`db.ts:856`; no `source_files`). Issue #627 scoped this. Out of scope here — note as a
dependency if 2b's ref coverage proves too sparse.

---

## Direction 3 — Blog post: Lore's take on "Writing for Agents"

Angle: Modem argues **discoverability is a property of the words in your source, because
agents search, not parse.** Lore's insight: **the same is true of an agent's *memory*.** A
memory system is a search index over your project's history; if its entries aren't written as
good search terms, recall degrades exactly like a grep over generic names.

Post structure:
- Lead with the shared root: retrieval (code or memory) is search-first; the words decide.
- Show Lore's mechanics as in-house proof: BM25 title weight 6.0, IDF relaxed cascade,
  exact-match boost — Lore independently arrived at "reward discriminative terms."
- The reflexive move: Lore *reads* discoverable titles well, so Lore should *write* them
  well (Direction 1) — dogfooding the article's thesis on its own knowledge base.
- Complementary framing (per house style, cf. Warden analysis prefs): credit Modem's work;
  position as "the memory-layer corollary," not a competitor. Acknowledge Modem's genuine
  utility before extending the idea.
- Tie to Lore's existing "pointer not source of truth" stance (closed #1231) — memory
  should point at code, which is the same discipline the article preaches for names/types.
- Avoid the "not X, but Y" counterargument-first pattern (AI tell, blog pref). Generous close.

**Deliverable:** draft in the website package (Astro) or as a standalone markdown for review.
Depends on nothing; can be drafted in parallel, but is strongest if it can reference 1a shipped.

---

## Recommended sequencing

1. **1a** (curator title guidance) — ship first. Pure prompt win, low risk, immediately
   improves every new entry's discoverability. Highest leverage-to-risk ratio.
2. **1c** (pattern-extract title cleanup) — small code fix, independent.
3. **1b** (re-titleable updates + consolidation) — needs a versioning/dedup code check +
   adversarial review.
4. **2a→2b** (persist + render refs) — new table/migration/rendering; sequence after D1;
   adversarial review for cross-project leaks + cache stability.
5. **3** (blog post) — draft anytime; publish after 1a lands so it can cite dogfooding.

## Open questions for the user

- Scope of this execution session: just **1a** (fast, safe), or 1a+1c, or the whole D1?
- Direction 2: is closing the file:line-pointer loop worth a migration now, or park it as a
  tracked issue until D1 shows whether title discoverability alone is enough?
- Blog post: internal draft for review, or website-ready Astro page? Part of the Modem
  "Writing for Agents" response, or standalone?

## Key evidence (file:line)

- Title weight 3× content: `config.ts:750` (`ftsWeights {title:6.0,content:2.0,category:3.0}`),
  `db.ts:207` (fts5 column order `title,content,category`).
- Curator title guidance (the gap): `prompt.ts:460` (`"Short descriptive title"`),
  `update` op has no title `prompt.ts:467-471`, `curatorUser` list `prompt.ts:554-569`.
- Distillation house style to mirror: `prompt.ts:70-85` (verbatim artifacts + BAD/GOOD).
- Consolidation keeps stale titles: `prompt.ts:637,682`.
- Pattern-extract titles: `pattern-extract.ts:44-139`, applied `:176`; `tagToTitle` `:246`.
- Recall renders title first, no refs: `recall.ts:559-567`; recall tool "pointer not source"
  description `recall.ts:1594`.
- Refs extracted then discarded: `references.ts` `extractReferences`; only counts persist
  `knowledge_ref_validity` `db.ts:1501`; read only by CLI `data.ts:275`.
- `formatKnowledge` has no refs field: `prompt.ts:912-995`.
- Query discriminativeness: IDF cascade `search.ts:190,309`; exact-match boost `search.ts:555`;
  RRF `search.ts:516`.
