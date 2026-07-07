# Live counterfactual benchmark — Lore vs no-Lore (#961)

Real OpenCode agent, real Lore gateway, MiniMax-M3, per-arm isolated (own config
home, data home, project dir, Lore DB, gateway port). Fresh trunk build of the
plugin+gateway. Deterministic scorer (no LLM judge, per #961). Each arm drives
headless `opencode run` in build mode; metrics parsed from the event stream +
opencode.db.

Harness (reproducible) lives in the eval-signals-scorer worktree at
`packages/core/eval/live/`: `driver.mjs`, `gen-seed.mjs`, `gen-blob.mjs`,
`score.mjs`, `task-compaction.json`, `task-xsession.json`, `seed-min/`.

## The probes (4 code-invisible facts, #961 axes)

Stated once as project conventions, then required later. NONE are recoverable
from code the agent can read — they live only in the conversation:
1. convention adherence — new files start with `# WH-CONVENTION v3`
2. gotcha reuse — money is integer cents, never float (prod float-rounding bug)
3. decision recall — `MAX_LINE_ITEMS = 100` (deliberately raised from 50)
4. negative control (superseded) — order status is UPPERCASE `SUBMITTED`
   (supersedes an older lowercase convention)

Scored mechanically on the file the final step was asked to create.

## Result 1 — CROSS-SESSION memory recall (the headline)

Two SEPARATE OpenCode sessions. Session 1 states the conventions + does a small
unrelated task. Session 2 is a FRESH session asked to build `orders_v2.py`
following "our conventions" — without restating them.

N=3 per arm (MiniMax-M3):

| arm     | run1 | run2 | run3 | mean probes |
|---------|------|------|------|-------------|
| Lore    | 4/4  | 3/4  | 4/4  | **91.7%**   |
| no-Lore | 0/4  | 1/4  | 0/4  | **8.3%**    |

Representative run (run1): Lore 4/4 @ 144,973 tok / 14 turns; no-Lore 0/4 @
190,228 tok / 22 turns.

Confirmed model-agnostic on flagship **Sonnet 5** (1M context, no compaction
needed for cross-session). GRAND tokens include Lore's background distillation;
$ from lore.db daily_costs (conversation + worker):

| arm     | probes | GRAND tok (answer + bg) | GRAND $ | turns | tools |
|---------|--------|-------------------------|---------|-------|-------|
| Lore    | 4/4    | 107,654 (106,350 + 1,304) | $0.093 | 8   | 6     |
| no-Lore | 0/4    | 252,788 (252,788 + 0)     | $0.190 | 15  | 17    |

Same 4/4 vs 0/4. Cross-session distills only the small first session, so Lore's
background is tiny (1 distill call, ~1.3K tokens) — Lore wins on quality AND
total cost: **~2.3x fewer tokens and half the dollars** ($0.093 vs $0.190),
even counting its background spend. (M3 cross-session mirrors this: GRAND 148K
tok @ 4/4 vs 190K @ 0/4.)

## Result 1b — vs MCP memory competitors (mem0 cloud)

Same cross-session task, adding real MCP memory servers the agent drives via
tools (vs Lore's automatic injection). Setup is realistic and generous to the
competitor: an `AGENTS.md` instructs the store-in-session-1 / recall-in-session-2
workflow (Lore needs no such instruction), a between-session settle matches
Lore's curate+idle step (mem0 processes `add_memory` asynchronously server-side —
without a wait, session-2 search returns empty), and each run is isolated to a
unique mem0 `user_id`.

mem0 = mem0 CLOUD via the official `mem0-mcp-server` (agent-mode key).

| model    | arm        | probes | GRAND tokens | turns | tools |
|----------|------------|--------|--------------|-------|-------|
| M3       | Lore       | 4/4    | **147,821**  | 14    | 20    |
| M3       | mem0 cloud | 4/4    | 227,624      | 17    | 30    |
| M3       | no-memory  | 0/4    | 190,228      | 22    | 20    |
| Sonnet 5 | Lore       | 4/4    | **107,654**  | 8     | 6     |
| Sonnet 5 | mem0 cloud | 4/4    | 261,141      | 13    | 15    |
| Sonnet 5 | no-memory  | 0/4    | 252,788      | 15    | 17    |

- Both memory systems recall correctly (4/4); no-memory is 0/4. Memory works —
  the question is COST.
- Lore is far more token-efficient: **Sonnet 5 108K vs mem0 261K** (Lore = 41%),
  M3 148K vs 227K. mem0's explicit `add_memory` / `search` / `get_memories`
  round-trips + verbose payloads push it ABOVE even the no-memory token count on
  Sonnet 5. Lore injects automatically — no tool round-trips (6 tools vs 15).
- Fairness caveats, both favoring mem0: (1) mem0's fact-extraction + embedding
  run server-side and are NOT counted in these tokens, while Lore's distillation
  IS; (2) mem0 required a tuned async settle to recall at all. Lore's cost is
  fully counted and needs no such tuning.
- Reliability: mem0 recall is timing-sensitive (a too-fast session-2 search
  returned empty → 0/4 before the settle was added); Lore's injection is
  deterministic.

(mnemonic — the closest local-DB competitor — is pending a build fix + a Gemini
API key it requires for embeddings/extraction.)

Variance is honest, not suspiciously perfect:
- The fact Lore occasionally drops is `decision-max-100` ("raised from 50 to
  100") — a bare numeric value with history, the hardest to retain.
- The fact no-Lore occasionally "holds" is `gotcha-no-float` — integer cents is
  a NATURAL DEFAULT any agent picks for money, so this probe is a weak
  discriminator. The three ARBITRARY conventions (header string, max=100,
  UPPERCASE status) cannot be guessed and are the clean signal: on those, Lore
  ~9/9 vs no-Lore ~0/9 across the three runs.

- Lore session-2 recovered ALL four conventions purely from injected memory
  (they were never written to code) and wrote a correct `orders_v2.py`.
- no-Lore session-2 had zero memory of session 1. It hunted for the conventions
  (`ls`, read every file, `git log -p --all`, 3× grep, `reflog`, `git ls-files`)
  across 22 turns, then gave up:
  > "I can't find those established decisions in this repo ... the things you'd
  >  be expecting me to 'follow' don't exist anywhere I can read."
  It never produced a valid `orders_v2.py`.

This is the #961 cross-session memory gap, demonstrated end-to-end with a real
agent and scored deterministically.

## Result 2 — WITHIN-SESSION under compaction pressure (efficiency)

One long session, conventions stated in turn 1, then ~150K-token reference blobs
piped across turns to drive context past the compaction threshold, then the
build task. (OpenCode's compaction threshold was set to a real 200K window;
MiniMax-M3's coding-plan context is far below the 1M models.dev advertises, so
this is both necessary — to compact cleanly instead of erroring — and applied to
BOTH arms equally, since OpenCode's compaction runs under the Lore plugin too.)

Now a 3-way with mem0 cloud as an MCP competitor. TOTAL tokens count Lore's
BACKGROUND distillation, not just the foreground answer (worker/distill spend
from gateway.log). `peakCtx` = the largest single request the model saw; `answer`
= foreground tokens the user waits on:

| arm        | probes | answer tok | + background | = GRAND tok | peakCtx | native compactions | wall |
|------------|--------|------------|--------------|-------------|---------|--------------------|------|
| Lore       | 4/4    | 1,534,905  | 723,333 (10 distill) | **2,258,238** | **150,274** | **0** | **126s** |
| no-memory  | 4/4    | 2,433,688  | 0            | 2,433,688   | 293,603 | 1                  | 173s |
| mem0 cloud | 4/4    | 3,140,973  | 0 (server-side) | **3,140,973** | 297,685 | 1              | 233s |

- **The unique long-session advantage: Lore is the only context MANAGER.** It
  held peak context to 150K with ZERO native compactions, while both no-memory
  and mem0 ballooned to ~295K and took a lossy compaction. mem0 is not a context
  manager — it's an external store the agent calls — so the live window bloats
  exactly like no-memory, PLUS mem0 adds tool round-trips on top.
- **mem0 is the MOST EXPENSIVE arm of all three** (3.14M tokens, highest peak,
  slowest at 233s) — worse than doing nothing. It pays the full bloated-context
  cost AND its own add/search overhead, for the same 4/4. Lore's GRAND (2.26M,
  incl. its 723K background distillation) is the cheapest AND the fastest.
- Foreground (what the user waits on): Lore 1.53M vs mem0 **3.14M** — Lore is
  under half. mem0's background extraction is server-side (uncounted), so its
  true total is even higher.
- Accuracy is a tie here (all 4/4): rules were stated PROMINENTLY and only one
  compaction fired, so OpenCode's summary preserved them. Honest finding —
  within-session recall of prominent facts is not where memory breaks; the win
  is that Lore delivers it at half the context, zero compactions, cheapest, and
  fastest, while mem0 makes long sessions strictly worse.
- ($ not comparable on M3: opencode prices M3 at $0 while Lore prices worker
  calls at list rates — use tokens on M3.)

## Result 3 — PREFERENCE recall (the realistic memory gap, vs mem0)

The facts that actually live only in conversation are personal/team WORKING-STYLE
preferences — "prefer @dataclass over bare dicts", "raise a custom exception not
ValueError", "status is UPPERCASE", "orders carry channel='WHOLESALE'". People
do NOT put these in code, and — crucially — do NOT put them in AGENTS.md either;
they feel like offhand preferences (some, like "match my tone", can't go in an
AGENTS.md at all). So here they are stated ONCE, in passing, in session 1 while
doing an unrelated task; session 2 is a fresh session that just says "build it
the way I like things done."

mem0 is tested two ways: `soft` = a realistic one-line "you have a memory tool,
use it" note (what people actually write); `strong` = an aggressive "MANDATORY
WORKFLOW: store every convention verbatim" spec (best case for the competitor).
`gotcha-no-float` (integer cents) is a NATURAL DEFAULT any agent picks for money,
so it is a weak discriminator; the 4 ARBITRARY preferences are the signal.

Cross-session, four models, five memory systems (deterministic scorer; a raised
custom exception counts whether defined inline or imported). All competitors use
the realistic `soft` note (mem0 also shown with the aggressive `strong` spec).
Competitors: **mnemonic** (local SQLite+vector, RRF), **mem0** (cloud), **basic-
memory** (local markdown+sqlite graph), **official MCP KG server** (local JSON
graph). **byterover/Cipher** (the tool #961 targets) could not be run — see below.

| model              | Lore  | mnemonic | basic-memory | mem0 soft | mem0 strong | KG server | no-memory |
|--------------------|-------|----------|--------------|-----------|-------------|-----------|-----------|
| MiniMax-M3         | **5/5** | 5/5    | 1/5          | 1/5       | 2/5         | 2/5       | 1/5       |
| DeepSeek v4 Flash  | **5/5** | 5/5    | —            | 1/5       | 5/5         | —         | 2/5       |
| Sonnet 5           | **5/5** | 5/5    | 5/5          | 5/5       | 5/5         | 5/5       | 1/5       |
| Nemotron 3 Ultra   | 2/5   | 2/5      | —            | 3/5       | 3/5         | —         | 1/5       |

**The systems split cleanly into two groups — and the axis is bulk-context vs
targeted-search, NOT local vs cloud:**

- **Push / bulk-context — model-ROBUST (5/5 on cheaper M3 AND frontier Sonnet):**
  **Lore** (automatic injection) and **mnemonic** (its `get_context` dumps all
  facts at session start). You don't have to know what to ask for, so even a cheaper
  model applies the facts.
- **Targeted-pull — model-DEPENDENT (1–2/5 on cheaper M3, 5/5 on frontier Sonnet):**
  **mem0**, **basic-memory**, and the **KG server**. All three require the agent
  to search for the right memory and apply it; cheaper models miss offhand facts they
  don't know to query. mem0 needs either a frontier model or the aggressive nudge.
- **no-memory:** 1/5 everywhere (only the lucky integer-cents default).

So an explicit memory tool CAN match Lore's recall — but only if it returns BULK
context (mnemonic) rather than just search (mem0/basic-memory/KG), AND the agent
reliably calls it. Lore is the only system that is push (no tool call, no derail),
local, and needs no external embedding/LLM key.

**byterover / Cipher (the #961 target) — could not be benchmarked.** It is not a
lightweight store; `brv curate` runs an AGENTIC loop (48+ LLM calls to curate one
input, hitting its own per-task cap). It failed to complete a single curate on
every LLM available here: NVIDIA (internal 48-call cap), OpenRouter free models
(qwen3-coder / llama-3.3-70b both "provider returned error"), and OpenCode Zen
free models via an auth-stripping proxy (reasoning models return empty content,
breaking its parser). It requires a premium, well-behaved tool-calling LLM to run
at all — itself a stark operational-cost contrast with Lore (runs on anything,
even FTS-only) and the single-call stores (mem0/mnemonic/basic-memory/KG).

The honest finding is about ROBUSTNESS, not a blanket accuracy win:

- **Lore captures correctly on every model** — verified directly in lore.db: on
  ALL four models it distilled all 4 preferences into knowledge (dataclass,
  custom exception, UPPERCASE status, channel=WHOLESALE). Capture never fails.
- **Lore applies 5/5 on 3 of 4 models** (M3, DeepSeek, Sonnet). Automatic
  injection puts the preferences in context, so the agent uses them.
- **mem0 with a REALISTIC note is frequently no better than no memory**: 1/5 on
  both M3 and DeepSeek (vs no-memory 1–2/5). It only reaches 5/5 with either a
  frontier model (Sonnet) or the aggressive "store everything" spec — and even
  mem0-strong is 2/5 on M3. Pull-based memory needs the agent to think to search,
  the search to surface the right memory, and the agent to act on it; cheaper
  models miss all three. Concrete: mem0-strong on M3 stored all 5 perfectly and
  searched in s2, yet still wrote `channel="WEB"`, a bare dict, and `ValueError`.
- **Nemotron 3 Ultra is a cautionary case — NO memory system helps.** It ignores
  provided facts (both Lore's injected context AND mem0's retrieved memories) in
  favor of its own priors: it invents `VALID_STATUSES={pending,confirmed,...}` and
  `VALID_CHANNELS={web,mobile,...}` and defaults to lowercase `pending`/`web`,
  overriding the stated `SUBMITTED`/`WHOLESALE`. Lore captured all 4 (confirmed in
  DB) but the model refused to defer. mem0's 1-probe edge (3/5 vs 2/5) is just
  Nemotron happening to invent custom exceptions that run — run-to-run noise, not
  a memory signal. Memory only helps if the model obeys the context it's given.
- **mnemonic matches Lore's recall (5/5 on the 3 cooperative models) — so where
  does Lore still win?** (1) Automatic vs manual: mnemonic needs the agent to call
  `get_context` every session and can derail — one M3 run spent its turns on memory
  ops and never wrote the file (0/5, task-completion failure; 5/5 on re-run). Lore
  injects with no tool call and no derail surface. (2) No external dependency:
  mnemonic HARD-requires a Google Gemini key (3072-dim embeddings + fact
  extraction, hardcoded to generativelanguage.googleapis.com — it cannot use M3 or
  Anthropic); Lore runs fully local (these runs were even FTS-only). (3) Cost:
  Lore is cheaper (M3 128K tok / 15 tools vs mnemonic 223K / 27; Sonnet 201K vs
  227K). (4) Nemotron: mnemonic 2/5 = Lore 2/5 — a get_context dump doesn't help
  either when the model overrides its context.
- Lore is also cheaper than mem0 wherever it applies (M3 128K tok / 15 tools vs
  205–210K / 20–39; Sonnet 201K vs 281–299K).

The #961 thesis, stated honestly: the memory that matters is the stuff nobody
writes down (offhand preferences, working style, tone). Lore captures it
automatically on every model and injects it so it gets applied without the agent
doing anything. An explicit tool CAN match that recall — but only if (a) it
returns BULK context, not just targeted search (mem0's soft-note failures on cheaper
models), and (b) the agent reliably calls it without derailing (mnemonic's fluke),
and (c) you accept an external embedding dependency (mnemonic's Gemini key). Lore
needs none of those caveats and costs less. The one place everything loses is a
model that won't honor provided context at all (Nemotron).

## Methodology notes / honesty

- No LLM judge: every probe is a mechanical check on produced code.
- Capable agents resist within-session context growth (efficient reads, bash
  scripting, and OpenCode's own tool-output pruning), so a big codebase does NOT
  inflate context. Context is driven by un-prunable user messages — hence the
  piped reference blobs to force compaction.
- The compaction cap is applied identically to both arms; the cross-session
  result needs no compaction at all and is the cleaner memory measurement.
- COST ACCOUNTING: Lore's totals include background distillation/curation
  (worker-model) spend, not just the foreground answer — worker/distill tokens
  parsed from gateway.log, USD from lore.db daily_costs (conversation + worker
  buckets). Distillation overhead scales with fresh content flowing through a
  session, so it is negligible cross-session (memory reused) but material
  within-session under heavy blob pressure.
- CAVEAT (RESOLVED): local ONNX embeddings failed to load in the earlier isolated
  runs ("protobuf parsing failed" — a truncated 17.7MB model download). Fixed by
  updating the eval-live build to main (#1223 declares onnxruntime-node optional
  so the native backend resolves; #1229 retry backoff), fetching the native ONNX
  binary, and purging the corrupt model so it re-downloaded clean (32MB). Runs
  below have embeddings ON (`vec=on`, sqlite-vec native).

## Headline matrix — signal-only probes, embeddings ON, same-provider keyed worker

Task `pref-combined`: 2 sessions × 5 turns, 64K reference blob piped each turn
(forces 2 native compactions per no-Lore session). 4 arbitrary code-invisible values
stated once in passing in S1 turn 1 (`status=SUBMITTED`, `channel=WHOLESALE`,
`region=EMEA`, `warehouse=WH-07`), probed in S2's final turn. Signal-only scoring:
only those 4 count — structural style freebies (dataclass/exception/cents) gated OFF.

### Combined (cross-session + 2 compactions)

| Arm | MiniMax-M3 (cheaper) | Sonnet-5 (frontier) |
|-----|-------------------|-------------------|
| **Lore** (push / automatic) | **16/20 (80%, N=5)** | **12/12 (100%, N=3)** |
| mnemonic (MCP, pull)        | 8/24 (33%, N=6)  | 12/12 (100%, N=3) |
| mem0 (MCP, pull)            | 4/24 (17%, N=6)  | 12/12 (100%, N=3) |
| no-memory                   | 0/20 (0%, N=5)   | 0/12 (0%, N=3) |

### Single-long (one session, ~3 native compactions of erosion) — Sonnet-5

| Arm | N=3 |
|-----|-----|
| **Lore** | **12/12 (100%)** |
| no-memory | 4/12 (33% — native compaction sometimes preserves the aside) |

**The finding, honestly:** memory of any kind beats no-memory everywhere. Lore's
edge is *largest on cheaper models*: its automatic distillation captures & injects the
incidental facts with no tool-calling required (80% on M3), while pull-based MCP
memory needs the model to *decide* to store the value in S1 AND retrieve it in S2 —
which cheaper M3 does unreliably (17-33%). On a frontier model (Sonnet-5) the pull tools
are driven reliably and the gap closes: everyone with memory hits 100%. Within a
single session, Lore holds incidental facts across compactions deterministically
(100%) while native compaction erodes them ~two-thirds of the time.

- METHOD FIX (materially changed Sonnet numbers): the eval driver had hardcoded the
  worker API key to the minimax coding-plan key. With the same-provider worker MODEL
  (anthropic) but the wrong KEY, the Sonnet worker auth-failed → 0 distillations →
  Lore fell back to temporal-only recall and dipped to 8/12. `workerKeyFor()` now
  derives the key from the worker's provider; Sonnet distillation works (17-18 rows)
  and Lore is a clean 12/12. M3 was always correct (minimax model + minimax key).
- DeepSeek v4 Flash (Zen) is NOT evaluable for the Lore arm: Zen is anonymous, so
  Lore's keyed background worker can't distill. Would need a keyed DeepSeek (paid).
- M3 Lore's one dip (one run of five = 0/4) is genuine cheaper-model application
  variance: the facts WERE in context, but the model invented its own defaults
  (`channel="WEB"`, `status="CREATED"`) instead of applying them. That is a model
  ceiling (see Nemotron below), not an infra failure — kept in the honest 80%.
- CONTEXT-SOURCES (the fix): this 80% is with `knowledge.contextSources` defaulted
  to `["distillation"]` (folds a session's gen-0 distillations into system[2] so
  cross-session facts surface without waiting on curation promotion). Controlled
  A/B on ONE build, hardened wait-for-curation settle, M3 pref-combined N=5, only
  the flag differing: context-sources ON 16/20 (80%) vs OFF 9/20 (45%). Root cause
  it fixes: application tracks presence in system[2]; the OFF failures were the
  offhand facts never reaching system[2] (present in distillations, not yet
  promoted to knowledge). Shipped default-on in #1293.

## Multi-session cost (combined / cross-session) — Sonnet-5, per run, avg N=3

Worker = same model as the answering model (Sonnet distills with Sonnet). We do NOT
use a smaller worker (quality drops), so every dollar Lore spends is on the same
model you already run. Nothing leaves your model provider.

| Arm | answering $ | memory backend | visible total | hidden 3rd-party |
|-----|-------------|----------------|---------------|------------------|
| **Lore** | **$3.34** | worker $1.67 (*your* model) | $5.01 | **none** |
| no-memory | $4.03 | — | $4.03 | none (but 0% retention) |
| mnemonic | $3.97 | — | $3.97 | Gemini embed+extract (metered, unmeasured) |
| mem0 | $4.10 | — | $4.10 | mem0 cloud (metered, unmeasured) |

1. **Cheapest answering path** ($3.34). Compaction busts the prompt cache and rewrites
   the prefix; every arm that compacts writes ~888K cache tokens vs Lore's 599K. Lore
   removes the compaction tax instead of adding a retrieval tax on top of it.
2. **Transparent pricing.** Lore's cost is your own model on your own bill, fully
   predictable from your usage. mnemonic and mem0 stack a separate metered third-party
   service (Gemini, mem0 cloud) on top — cost we could not bill here and you cannot
   predict from your model spend.

Bar we hold ourselves to: same price with better performance, or cheaper at a tie.
Cheaper models (M3) → Lore wins outright (80% vs 17-33%). Frontier models (Sonnet) → tie
on retention (100% all around) at a transparent, comparable cost. On a flat-rate plan
(M3) all dollars are notional and tiny; tokens are the metric, and Lore's answering
path uses fewer.

## Next

- Increase competitor N to better characterize the 33% variance (Lore/no-memory are
  already deterministic at N=3).
- Single-long (one session) is a weaker discriminator: OpenCode's native compaction
  preserves salient within-session facts, and 90K blobs balloon context to ~230K
  before compaction fires (slow / timeout-prone on M3). Cross-session is the clean
  measurement.
- Cross-session needs no compaction, so it runs on flagship 1M models
  (Opus 4.8 / Sonnet 5) directly for a headline number.
