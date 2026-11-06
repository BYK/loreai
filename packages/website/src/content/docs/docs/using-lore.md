---
title: Use Lore day to day
description: Resume work, find past decisions, review knowledge, and switch coding agents.
---

Once [your first session is recorded](/docs/first-session/), keep working in your
coding agent. Use Lore's local browser when you need to inspect the record.

## Start tomorrow's work

Open the same project and use your agent's connection path again: a terminal
launch through Lore, an installed adapter, or the configured Desktop client with
the gateway running. [Choose your connection path](/docs/install/).
Starting a new session does not erase stored project knowledge.

## Find an earlier decision

Select the project in the local browser. Use its search to find a remembered error,
file, or decision. Open **Sessions** to read the conversation around it, or
**Knowledge** for the curated rule. Source material can be more detailed than a summary.

You can also search from your project's terminal:

```bash
lore recall "webhook event ID"
```

Your connected agent has recall available through supported integrations. Ask it
to look up the previous decision and check its source before applying it to a new task.

## Review knowledge

Open **Knowledge**, select an entry, and inspect **Source & history**. Check the
wording, project scope, source, and recorded confidence. Confidence is a recorded
signal, not proof that a statement is correct.

- Use **Edit** to correct a wrong rule. Review the save receipt and resulting file diff.
- Use **Delete** for an entry that should no longer be active knowledge. Read the
  confirmation: this does not erase the original conversation or all retained history.
- Use the available version history and restore controls when recovering an earlier
  entry. Restoring creates a new version.

Do not remove or rewrite `<!-- lore:... -->` identity markers when hand-editing
`.lore.md`. [File sharing and import behavior](/docs/team-memory/).

## Switch agents

Connect the other supported agent from the same project. Curated project knowledge
is shared through Lore's local store and `.lore.md`; the original client's UI and
session history can still differ. [Choose an integration](/docs/install/#1-choose-your-agent).

## Share with a teammate

Review `git diff -- .lore.md`, commit useful knowledge with your code, and let a
teammate import it when their next Lore-connected session starts. Git-based sharing
shares the knowledge file, not your complete conversation database.
[Team memory](/docs/team-memory/) describes the current workflow and Folk Lore early access.

## Inspect activity and costs

**Model usage** shows model activity from recorded assistant turns. **Providers &
costs** shows available spend estimates and provider quota observations. Neither
replaces your provider's bill. [Data and costs](/docs/data-and-costs/).
