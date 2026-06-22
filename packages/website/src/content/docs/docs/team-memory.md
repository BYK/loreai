---
title: Team memory & review
description: Share project knowledge with your team as version-controlled .lore.md, reviewed in pull requests — and how that relates to Folk Lore.
sidebar:
  order: 3
---

Lore's long-term knowledge is local-first: every decision, pattern, preference, and gotcha lives in a local SQLite database. But project knowledge is most valuable when the whole team shares it. Lore makes that sharing a **git artifact you review like code**, not a hidden database.

## `.lore.md` — memory that moves with the code

When the curator records a durable fact, Lore exports it to a `.lore.md` file at your project root. The file is plain Markdown, committed to your repository, and designed to be reviewed in pull requests.

- **Human-readable.** Each entry is a Markdown bullet under its category — decision, pattern, preference, architecture, or gotcha.
- **Diffable.** Entries are sorted alphabetically by title within each category, so the file has a stable, deterministic order. A new or changed fact shows up as a minimal, readable diff — not a reshuffle.
- **Merge-friendly.** That deterministic ordering keeps conflicts rare and legible. Each entry carries a stable `<!-- lore:UUID -->` marker, so edits map to the right entry regardless of position.
- **Reviewable.** Because it lives in the repo, knowledge changes ride through the same PR review your code does. Your team approves what the agent learned the same way it approves a code change.

### How it round-trips

- **Export.** After curation, Lore writes `.lore.md` — skipping the write entirely when nothing changed, so it never churns your working tree.
- **Import.** On the next session, Lore reads `.lore.md` back. A teammate's merged entry — or a hand-written one — is imported into the local database and injected into the agent's context. A known marker with changed content updates that entry; an unknown marker creates a new one.
- **Hand edits are first-class.** Edit `.lore.md` directly: fix a wrong fact, delete a stale one, or add a convention by hand. It's imported on the next run.

This is the team-memory path that works **today**, with nothing but your existing git workflow.

## Reviewing memory changes

Because `.lore.md` is just a tracked file:

- `git diff` shows exactly what the agent learned this session.
- A reviewer can reject a wrong or premature fact in a PR before it becomes shared truth.
- Knowledge history is your git history — `git blame` and `git log` work on individual facts.

## Configuration

`.lore.md` export/import is on by default. See [`loreFile`](/docs/configuration/#loreFile) to disable it — knowledge then stays in the local database and is still injected into context — and [`crossProject`](/docs/configuration/#crossProject) for how knowledge that recurs across projects is promoted.

To keep shared knowledge inside an existing `AGENTS.md` instead of a standalone file, pair `loreFile.enabled=false` with `agentsFile.enabled=true`.

## Folk Lore — live team sync (coming soon)

`.lore.md` shares knowledge through git: reviewable and durable, but it converges at the speed of commits and merges. **Folk Lore** is the upcoming hosted layer for teams that want **live** shared memory — knowledge that converges across every teammate's machine continuously, with promotion workflows for deciding what becomes shared truth, and integration with your existing team structure (GitHub Teams, repo collaborators).

The two are complementary:

| | `.lore.md` (today) | Folk Lore (coming soon) |
|---|---|---|
| Transport | Git (commit + PR) | Live hosted sync |
| Review | Pull request | Promotion workflow |
| Convergence | At merge time | Continuous |
| Where it lives | Your repo | Your repo + hosted team store |

You don't have to choose: git-native `.lore.md` is the reviewable record; Folk Lore adds live convergence on top. [Folk Lore early access &rarr;](/different/#waitlist)
