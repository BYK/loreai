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

## Next steps

- [Install Lore](/docs/install/) — get the gateway running first.
- [Setup command](/docs/setup/) — configure an agent to route through Lore.
- [Configuration](/docs/configuration/) — tune distillation and knowledge extraction.
