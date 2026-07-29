# Lore

> **Lore. The memory that compounds.**

> **Experimental.** Under active development. APIs, storage format, and behavior may change.

**Stop re-explaining your project to your AI.** Your tools change. Your memory doesn't. **Your team's lore, in every session.**

Your AI forgets decisions, loses file paths, and undoes its own work. Lore gives it shared context across projects, tools, and providers. No context files to maintain, no workflow changes. Every new session starts with the relevant facts and gets a fresh injection after the first turn.

Lore is a transparent LLM proxy that gives any AI agent shared context across tools, projects, and teams. The memory that compounds. Context management and long-term memory aren't separate problems: they're one continuous pipeline. Distillation feeds the gradient context manager, which feeds the knowledge curator, which feeds `.lore.md`, and with Folk Lore *(coming soon)*, your team.

Built on [Sanity's Nuum](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) memory architecture and [Mastra's Observational Memory](https://mastra.ai/research/observational-memory) research. The core idea: coding agents need **distillation, not summarization**, preserving file paths, error messages, and exact decisions rather than narrative summaries that lose the details agents need to keep working.

Published as [`@loreai/gateway`](https://www.npmjs.com/package/@loreai/gateway) (standalone proxy), [`@loreai/opencode`](https://www.npmjs.com/package/@loreai/opencode) (OpenCode plugin), [`@loreai/pi`](https://www.npmjs.com/package/@loreai/pi) (Pi extension), and [`@loreai/core`](https://www.npmjs.com/package/@loreai/core) (shared engine).

Full documentation lives at **[withlore.ai/docs](https://withlore.ai/docs/)**.

## Own your memory, not just your code

The AI tooling ecosystem is in a war for execution, and harnesses are
incentivized to lock you in. When a closed platform builds "agent memory,"
it stores your team's decisions inside a proprietary vector database.
Switch IDEs, switch models, and the team gets amnesia. Lore is the escape
hatch: a vendor-neutral proxy that sits between your harness and your
model, and distills your team's context into an open standard —
[`.lore.md`](https://withlore.ai/docs/team-memory/) — that lives in Git,
moves between tools, and never leaves your infrastructure unless you want
it to. The harness is replaceable. Your team's "why" is not.

## Why

Coding agents forget. Once a conversation exceeds the context window, earlier decisions, bug fixes, and architectural choices vanish. The default approach — summarize-and-compact — loses exactly the operational details agents need. After a few compaction passes, the agent knows you "discussed authentication" but can't actually continue the work.

The manual alternative is writing context files by hand — key technical learnings, decision rationales, session handoff notes. It works ([O'Reilly Radar](https://www.oreilly.com/radar/why-doesnt-anyone-teach-developers-about-context-management/) has a thorough guide), but it's a second full-time job. One project tracked 49 technical learnings manually, each with "What, Why, When, Where" — and every one had to be maintained or the AI would refactor deliberate decisions away.

Other tools try to solve this in halves. Memory-only tools store past conversations but don't manage the context window — your AI still gets compacted mid-session. Context-only tools compress history but nothing is learned from the compression — start a new session and you're back to zero.

Built-in memory features go a step further — they store facts about your codebase. But storing facts isn't memory architecture: without compression, context management, active recall, or portability, it's a clipboard that expires. Facts accumulate. Knowledge compounds. Only one scales.

Recent research on AI self-improvement identifies two fundamental levers: **harness updates** (changing what context the model sees) and **weight updates** (retraining the model). [Meta-Harness](https://arxiv.org/abs/2603.28052) (Lee et al., 2026) proved that *what information you store, retrieve, and present to a model* matters as much as the model itself — and that richer access to prior experience enables automated improvement. [SIA](https://arxiv.org/abs/2605.27276) (Hebbar et al., 2026) showed harness updates and weight updates occupy distinct change spaces, with harness improvements concentrating on the infrastructure that shapes how the model searches and acts. Lore is this infrastructure for coding agents — a system that continuously improves the context your agent sees, session after session.

Lore treats context management and memory as the same problem. Distillation, knowledge curation, cross-session recall, and `.lore.md` export — all in one pipeline. You keep coding. Lore keeps the context.

## Quick start

```bash
curl -fsSL https://withlore.ai/install | bash
lore run
```

`lore run` starts the gateway and auto-detects your AI agent (Claude Code, OpenCode, Pi, Codex, Hermes), configuring everything automatically. Per-harness setup, manual configs, and remote-gateway instructions live at [withlore.ai/docs/install](https://withlore.ai/docs/install/) and the [guides section](https://withlore.ai/docs/guides/).

## How it works

Lore is a transparent HTTP proxy that sits between an AI harness and its upstream LLM provider. Every supported harness already speaks a standard LLM HTTP API (Anthropic's `/v1/messages`, OpenAI's `/v1/chat/completions`, Codex's `/v1/codex/responses`); Lore redirects those requests to its own gateway, where the conversation is parsed, persisted, and transformed before being forwarded to the real upstream.

A three-tier memory architecture (temporal storage → distillation → long-term knowledge) and a layered gradient context manager compose every request: stable knowledge caches at the top, distilled context in the middle, raw conversation at the bottom. The full architecture (cost-aware cache layer, recall pipeline, LTM pin invariant) is at [withlore.ai/docs/architecture](https://withlore.ai/docs/architecture/).

## Configuration

All Lore behavior is tunable through `.lore.json` (in your project root) and `LORE_*` environment variables. The full schema (every field, default, and override) is at [withlore.ai/docs/configuration](https://withlore.ai/docs/configuration/) and [withlore.ai/docs/environment](https://withlore.ai/docs/environment/). The docs are auto-generated from `packages/core/src/config.ts` and stay in sync with the code.

To turn long-term knowledge off entirely (keeping conversation storage, distillation, and recall), set `"knowledge": { "enabled": false }`. See the [`knowledge` reference](https://withlore.ai/docs/configuration/#knowledge).

## Team memory

Lore's long-term knowledge is local-first, but project knowledge is most valuable when the whole team shares it. Lore exports curated facts to a `.lore.md` file at your project root: plain Markdown, committed to your repo, designed to be reviewed in pull requests.

- **Diffable & merge-friendly**: entries are sorted alphabetically by title within each category and carry stable `<!-- lore:UUID -->` markers, so a new fact is a minimal diff, not a reshuffle.
- **Reviewable**: `git diff` shows what the agent learned; a reviewer can reject a wrong fact before it becomes shared truth. Knowledge history is your git history.
- **Hand-editable**: fix, delete, or add facts by hand; they're imported on the next run.

This is the team path that works today with your existing git workflow. **Folk Lore** (coming soon) adds live, continuous team sync on top. See [withlore.ai/different/#waitlist](https://withlore.ai/different/#waitlist). Full review workflow and configuration at [withlore.ai/docs/team-memory](https://withlore.ai/docs/team-memory/).

## CLI

Lore ships a CLI for inspecting and managing stored data. These commands work **without the gateway running**; they access the SQLite database directly.

```bash
# Inspect
lore data list projects
lore data list knowledge
lore data list sessions
lore data list distillations --project /path/to/project

# Show full detail for an entry (supports partial ID prefix)
lore data show knowledge abc12345
lore data show session abc12345-6789
lore data show distillation abc12345

# Clear data (prompts for confirmation; --yes to skip in scripts)
lore data clear --project .
lore data clear --project . --knowledge
lore data clear --project . --temporal
lore data clear --project . --distillations
lore data clear --all

# Delete a single entry
lore data delete knowledge abc12345

# Search from the terminal
lore recall "error handling patterns"
lore recall "auth decision" --scope knowledge --limit 5
lore recall "migration error" --project /path/to/project --json

# Import conversation history from existing agents
lore import
```

All destructive commands prompt for confirmation. Use `--yes` to skip (for scripts). Use `--json` on any `list`/`show` command for machine-readable output.

> **Starting fresh in a project?** Run `lore data clear --project .` to wipe all stored memories for the current directory. This regenerates `.lore.md`. Commit the change to prevent old knowledge from being re-imported from git history.

### Web dashboard

When the gateway is running, visit **http://localhost:3207/ui** for a web-based dashboard that lets you browse all projects, knowledge entries, sessions, and distillations; view full detail for any entry; search across all data sources (using the same recall engine); and delete entries or clear project data. Server-rendered HTML — no external dependencies.

## lat.md compatibility

If your project uses [lat.md](https://github.com/1st1/lat.md) to maintain a knowledge graph, Lore automatically indexes the `lat.md/` directory and includes its sections in recall results. No configuration needed — if the directory exists, Lore parses the markdown files, extracts sections, and ranks them alongside its own knowledge entries using BM25 + RRF fusion. Lore re-scans the directory on session idle, so changes by the agent or by hand are picked up automatically.

## Benchmarks

> Scores below are on Claude Sonnet 4 (claude-sonnet-4-6). Results may vary with other models.

### Coding session recall

20 questions across 2 real coding sessions (113K and 353K tokens), targeting specific facts at varying depths. Default mode simulates OpenCode's actual behavior: compaction of early messages + 80K-token tail window. Lore mode uses on-the-fly distillation + the `recall` tool for searching raw message history.

**Accuracy:**

| Mode    | Score     | Accuracy   |
|---------|-----------|------------|
| Default | 10/20     | 50.0%      |
| Lore    | **17/20** | **85.0%**  |

**By question depth** (where in the session the answer lives):

| Depth        | Default  | Lore        | Gap     |
|--------------|----------|-------------|---------|
| Early detail | 1/7      | **6/7**     | +71pp   |
| Mid detail   | 3/5      | **5/5**     | +40pp   |
| Late detail  | 6/7      | 6/7         | tied    |

Early and mid details — specific numbers, file paths, design decisions, error messages — are what compaction loses and distillation preserves. Late details are in both modes' context windows, so they tie.

**Cost:**

| Metric             | Default    | Lore       | Factor       |
|--------------------|------------|------------|--------------|
| Avg input/question | 126K tok   | 50K tok    | 2.5x less    |
| Total cost         | $8.14      | $1.87      | 4.4x cheaper |
| Cost/correct       | $0.81      | **$0.11**  | 7.4x cheaper |

Lore's distilled context is smaller and more cacheable than raw tail windows, making it both more accurate and cheaper per correct answer.

**Distillation compression:**

| Session            | Messages | Tokens | Distilled to     | Compression |
|--------------------|----------|--------|------------------|-------------|
| cli-sentry-issue   | 318      | 113K   | ~6K tokens       | 19x         |
| cli-nightly        | 898      | 353K   | ~19K tokens      | 19x         |

The eval is self-contained and reproducible: session transcripts are stored as JSON files with no database dependency.

## Eval results

### The mega-session test: 2.3 million tokens

Real-world coding sessions can span days and accumulate millions of tokens. We extracted a real 5-day, 2.3M-token session (getsentry/cli refactoring — 95 user turns, multiple PRs, architectural decisions, code reviews) and tested whether each approach can answer questions about details from throughout the session:

| What's tested | Lore | Compaction | Lore vs Compaction |
|---|---|---|---|
| Easy (late-session details) | **4.0**/5 | 2.4/5 | +67% |
| Medium (mid-session details) | **3.9**/5 | 3.0/5 | +29% |
| Hard (early-session details) | **4.1**/5 | 1.8/5 | +136% |
| **Average** | **4.0**/5 | 2.4/5 | **+70%** |
| **Perfect scores (5.0)** | **13/20** | 5/20 | 2.6x more |

*At 2.3M tokens, compaction compresses the entire conversation into ~11K tokens of summary — a 200x compression that destroys most details. Lore preserves them through distillation (21 observations totaling ~10K tokens) + 64K raw tail window + searchable temporal archive via recall. The hard questions — details from the first day of a 5-day session — are where compaction fails (1.8/5) and Lore excels (4.1/5).*

### At 400K tokens

At more typical session lengths, Lore still outperforms:

| What's tested | Lore | Compaction | Lore vs Compaction |
|---|---|---|---|
| Easy (late-session details) | 4.7/5 | **4.8**/5 | −2% |
| Medium (mid-session details) | **4.8**/5 | 4.0/5 | +19% |
| Hard (early-session details) | **4.9**/5 | 4.7/5 | +5% |
| **Average** | **4.8**/5 | 4.5/5 | **+7%** |
| **Perfect scores (5.0)** | **12/15** | 9/15 | — |

*Compaction baseline: multi-pass LLM summarization matching Claude Code's auto-compact behavior (~140K threshold). At 400K tokens, compaction only loses a few details — the advantage grows dramatically at larger scales.*

### Preference recall (400K tokens)

| What's tested | Lore | Compaction | Delta |
|---|---|---|---|
| Explicit preferences ("always use const") | **4.96**/5 | 3.40/5 | +46% |
| Implicit behavioral patterns | **4.83**/5 | 2.97/5 | +63% |
| Preference evolution (user switches tools) | **5.00**/5 | 3.67/5 | +36% |
| **Average across preferences** | **4.92**/5 | 3.34/5 | **+47%** |

*Preference recall baselines are from a prior eval run with tail-window (80K). Compaction preference baselines pending re-run.*

**What this means:** the longer the session, the bigger Lore's advantage. At 400K tokens, Lore is +7% over compaction. At 2.3M tokens, Lore is +70% — compaction retains less than half the information (2.4/5) while Lore retains 80% (4.0/5). Early-session details that compaction destroys completely (1.8/5) are preserved by Lore's three-tier architecture (4.1/5).

The eval suite is open source in `packages/core/eval/`. Run it yourself:

```bash
# 400K inflated scenario
npx tsx packages/core/eval/run.ts --mode live --inflate 400000

# 2.3M mega-session (real session, no inflation needed)
npx tsx packages/core/eval/run.ts --mode live --scenarios mega-cli-refactor
```

**Cost:** Lore's memory layer runs at minimal additional cost — background distillation and curation use batch APIs (50% off on supported providers) and cheaper models. Local on-device embeddings (Nomic Embed v1.5) mean zero API cost for vector search. Predictive cache warming reduces expensive cache rebuilds.

## How we got here

**v1 — structured distillation.** The initial version used [Nuum's](https://www.sanity.io/blog/the-cms-industrys-missing-primitive) `{ narrative, facts }` JSON format. It worked well for single-session preference recall but *regressed* on multi-session and temporal reasoning — the structured format was too rigid and lost temporal context.

**v2 — observation logs.** Switching to Mastra's observer/reflector architecture with plain-text timestamped observation logs was the breakthrough. Dated event logs preserve temporal relationships that structured JSON destroys.

**v3 — gradient context + proper eval.** Per-session gradient state, current-turn protection, cache calibration, prefix caching, LTM relevance scoring, and a self-contained eval harness. The eval extracts full session transcripts into portable JSON, distills on the fly, and compares against tail-window and compaction baselines.

**v4 — research-informed compression.** Three changes from the KV cache compression literature ([Zweiger et al. 2025](https://arxiv.org/abs/2602.16284), [Eyuboglu et al. 2025](https://arxiv.org/abs/2501.17390)): (1) *Loss-annotated tool stripping* with metadata instead of static placeholders. (2) *Context-distillation meta-distillation* producing working context documents instead of flat event logs. (3) *Multi-resolution composable distillations* — archived gen-0 observations for recall alongside compressed gen-1 for in-context summary.

**v5 — behavioral pattern detection + 400K eval.** Vector similarity-based pattern echo detection, action tagging in distillation, cross-session pattern clustering, assertion pinning for long sessions, and a scenario inflator for realistic 400K-token evaluation. This is what closed the preference gap from +15% to +47% over tail-window.

**v6 — recall quality + distillation transparency.** Uniform citation format `(d:xxx, t:xxx)` with compression metadata, session-affinity boosting, knowledge downweighting when session content exists, scripted eval replay (zero API calls during replay), amnesia mode, multi-pass compaction baseline. 2.3M-token mega-session eval on a real 5-day coding session: Lore 4.0/5 vs compaction 2.4/5 (+70%), with 13/20 perfect scores vs 5/20.

## Development setup

To use a local clone instead of the published packages:

- **OpenCode**: `{ "plugin": ["file:///absolute/path/to/lore"] }`
- **Pi**: symlink the built package into `~/.pi/agent/extensions/`, or add a local path to `~/.pi/settings.json` `packages`

Contributors editing prompts in `packages/core/src/prompt.ts` or the user-facing system prompt injection in `packages/opencode/src/index.ts` / `packages/pi/src/index.ts` should follow the review bar in [`docs/PROMPT_CHANGES.md`](docs/PROMPT_CHANGES.md).

## Standing on the shoulders of

### Memory architecture
- [How we solved the agent memory problem](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) — Simen Svale at Sanity on the Nuum memory architecture: three-tier storage, distillation not summarization, recursive compression. The foundation this project is built on.
- [Mastra Observational Memory](https://mastra.ai/research/observational-memory) — the observer/reflector architecture and the switch from structured JSON to timestamped observation logs that made v2 work.
- [Mastra Memory source](https://github.com/mastra-ai/mastra/tree/main/packages/memory) — reference implementation.

### Context compression
- [Fast KV Compaction via Attention Matching](https://arxiv.org/abs/2602.16284) — Adam Zweiger, Xinghong Fu, Han Guo, Yoon Kim on preserving attention mass when compressing KV caches. Inspired the loss-annotated tool stripping approach.
- [Cartridges: Compact Representations of Context for LLMs](https://arxiv.org/abs/2501.17390) — Simran Arora, Sabri Eyuboglu, Michael Zhang et al. on offline compressed context representations. Key ideas adopted: context-distillation objective for meta-distillation, and composable multi-resolution distillations.

### Harness self-improvement
- [Meta-Harness: End-to-End Optimization of Model Harnesses](https://arxiv.org/abs/2603.28052) — Yoonho Lee et al. at Stanford on automated harness optimization. Defines a harness as "the code that determines what information to store, retrieve, and present to the model" — precisely what Lore optimizes for coding agents. Key finding: raw execution traces are the most important ingredient for harness improvement; compressed summaries lose critical signal.
- [SIA: Self Improving AI with Harness & Weight Updates](https://arxiv.org/abs/2605.27276) — Hebbar et al. on combining harness updates with weight updates. Establishes that harness improvements and weight updates occupy distinct change spaces — harness shapes *how* the agent searches and acts; weights change *what* the model knows. Lore implements the harness update side of this framework.
- [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435) — Shengran Hu, Cong Lu, Jeff Clune on Meta Agent Search for automatically discovering better agent designs. Demonstrates that agents invented by meta-search maintain superior performance even when transferred across domains and models.

### Industry context
- [Why Doesn't Anyone Teach Developers About Context Management?](https://www.oreilly.com/radar/why-doesnt-anyone-teach-developers-about-context-management/) — Andrew Stellman at O'Reilly Radar on why context management is the most important undiscussed skill in AI development. The manual practices described are what Lore automates.
- [OpenCode](https://opencode.ai) — one of the AI coding agents Lore integrates with natively.

## License

FSL-1.1-Apache-2.0