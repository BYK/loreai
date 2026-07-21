---
title: Import conversations
description: Use `lore import` to bootstrap project memory from your existing Claude Code, Codex, OpenCode, Pi, Aider, Cline, and Continue conversations.
sidebar:
  order: 6
---

`lore import` scans your machine for prior AI coding conversations, extracts long-term knowledge from them via the curator, and writes it into your project's memory — so Lore starts with context from day one instead of a blank slate.

It is **idempotent**: already-imported sessions are skipped, so it is safe to run multiple times.

## When to use `lore import`

- **Onboarding an existing project** — you have months of Claude Code / Codex / OpenCode history for a repo and want Lore to learn from it immediately.
- **Adding a new agent** — you switched (or added) a coding agent and want its history folded into the same project memory.
- **After working in a git worktree** — conversations you had in a worktree are picked up alongside the main checkout (see [Worktrees & monorepos](#worktrees--monorepos)).

If you start your agent through `lore run`, you will also be offered a one-time auto-import for each newly detected agent — `lore import` is the explicit, re-runnable version of that.

## Usage

```bash
lore import                      # Detect agents, pick which to import (all by default)
lore import --agent claude-code  # Import from one agent only (non-interactive)
lore import --dry-run            # Show what would be imported — no LLM calls
lore import --no-worktrees       # Only scan the current directory
lore import --project <path>     # Import for a specific project (default: cwd)
lore import --yes                # Skip prompts and import everything
```

To migrate from a dedicated memory tool (Engram, mem0) instead of conversation history, use `--source` — see [Migrating from another memory system](#migrating-from-another-memory-system).

## Supported agents

| Agent | Where history is read from |
| --- | --- |
| Claude Code | `~/.claude/projects/<project>/*.jsonl` |
| Codex | `~/.codex/sessions/**` and `~/.codex/archived_sessions/**` |
| OpenCode | OpenCode's SQLite database |
| Pi | `~/.pi/agent/sessions/<project>/*.jsonl` |
| Aider | `<project>/.aider.chat.history.md` |
| Cline | VS Code globalStorage (Cline extension) |
| Continue | `~/.continue/sessions/**` |

## Selecting agents

When more than one agent has history for the project, `lore import` prints a numbered list and prompts you to choose:

```
Found prior conversations for this project:

  1. Codex
     12 sessions, ~3400 messages
     Most recent: 2026-07-14 09:12

  2. Claude Code
     5 sessions, ~900 messages
     Most recent: 2026-07-13 18:40

[lore] Select agents (comma-separated numbers, or 'a' for all):
```

Enter `1,2` to import a subset, or `a` (or just press Enter) for all. Use `--agent <name>` to skip the prompt and import a single agent, or `--yes` to import everything without prompting.

## Worktrees & monorepos

Each agent records conversations under the **directory it ran in**. Since git worktrees don't copy untracked directories, a repo's history ends up split across its main checkout (e.g. `~/code/app`) and each worktree (e.g. `~/worktrees/app/feature-x`).

`lore import` resolves the full set of paths that belong to the same repository — using `git worktree list` plus the paths Lore already associates with the project — and finds sessions recorded under **any** of them. So running `lore import` from the main checkout also picks up conversations you had in a worktree, and vice-versa.

Pass `--no-worktrees` to restrict detection to the current directory only.

## Migrating from another memory system

`lore import` also migrates **already-curated** memory from dedicated memory tools directly into Lore's knowledge store. Unlike conversation import, this does **not** run the curator LLM — the entries are already structured, so they are mapped and written directly (fast and free).

### Engram

```bash
lore import --source engram                       # runs `engram export` for you
lore import --source engram --file engram.json    # or import an explicit export
lore import --source engram --global              # import as cross-project knowledge
lore import --source engram --dry-run             # preview counts without writing
```

Produce an export file manually with `engram export engram.json` if the `engram` binary isn't on your `PATH`.

**Mapping.** Engram observation `type` values map onto Lore categories:

| Engram `type` | Lore category |
| --- | --- |
| `decision` | `decision` |
| `architecture` | `architecture` |
| `config` | `architecture` |
| `pattern` | `pattern` |
| `preference` | `preference` |
| `bugfix`, `discovery` | `gotcha` |
| (anything else) | `pattern` |

Each observation's project is recovered from its Engram session `directory`; observations scoped `personal`/`global` are imported as cross-project knowledge. Soft-deleted observations are skipped. The import is **idempotent** — re-running dedups by title and updates only entries whose content changed.

### mem0

mem0 is imported **natively — no Python required** for any common deployment. `lore import --source mem0` auto-detects your deployment shape:

```bash
lore import --source mem0                       # auto-detect (Qdrant / server / embedded)
lore import --source mem0 --file mem0.json      # explicit export dump
lore import --source mem0 --global              # import as cross-project knowledge
lore import --source mem0 --dry-run             # preview counts
```

**Deployment shapes** (detected in order):

| Shape | How Lore reads it | Notes |
| --- | --- | --- |
| **Qdrant server** (OpenMemory / raw Qdrant) | HTTP `points/scroll` on `:6333` | Collections `openmemory` then `mem0`. `--mem0-token` if the server sets an api-key. |
| **mem0 self-hosted server** (FastAPI) | HTTP `GET /memories` on `:8888` | Needs `--mem0-user <id>` and usually `--mem0-token`. |
| **Embedded default** (`Memory()`) | Reads `storage.sqlite` + decodes pickled Qdrant points | Fully native (SQLite + a pure-TS pickle reader). No server, no Python. |

**Overrides:** `--mem0-qdrant <url>`, `--mem0-collection <name>`, `--mem0-server <url>`, `--mem0-token <t>`, `--mem0-path <dir>` (embedded store base dir), `--mem0-user <id>`.

mem0 OSS has no category taxonomy, so imported memories default to the `pattern` category. Each memory's `metadata.repo` (when present) sets its project; otherwise `--project`/cwd applies.

**Fallback.** If native read ever fails (e.g. a future change to mem0's internal pickle format), export manually and pass `--file`:

```bash
pip install mem0ai
python -c "import json;from mem0 import Memory;m=Memory();print(json.dumps(m.get_all(user_id='YOUR_USER')))" > mem0.json
lore import --source mem0 --file mem0.json
```

## Next steps

- [Install Lore](/docs/install/) — get the gateway running first.
- [Setup command](/docs/setup/) — configure an agent to route through Lore.
- [Configuration](/docs/configuration/) — tune distillation and knowledge extraction.
