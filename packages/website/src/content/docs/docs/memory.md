---
title: How project memory works
description: Understand stored conversations, summaries, knowledge, and current agent context.
---

**Stored does not mean supplied on every request.** Lore keeps a record that can
be searched and selects material for the current task within its context budget.

## Four things you can inspect

| Material | Purpose | Where to look |
| --- | --- | --- |
| Stored conversation | Original messages and tool results available for later search | Sessions in the local app |
| Distilled context | Compressed observations from older work | Session context and distillation views |
| Project knowledge | Durable decisions, patterns, preferences, architecture, and gotchas | Knowledge and `.lore.md` |
| Current context | Material composed for the request, including recent work and selected memory | Session context where recorded |

## Follow one decision

You discuss duplicate webhook deliveries. That conversation also mentions lunch.
A curated entry might retain the event-ID rule as project knowledge. Later, a
webhook task can use that rule; lunch is unrelated to the task.

This is an illustration of relevance, not a promise that every curation run produces
exactly this entry or that every request includes it. Selection also depends on
scope, confidence, available task context, and token budget.

## What happens as a session grows?

Recent work remains available while older context can be distilled and compressed.
Original details can remain searchable beyond what currently fits in the prompt.
A summary is lossy: use recall and source history when exact details matter.

## Review the result

Read knowledge before treating it as a project rule. Correct inaccurate entries,
review `.lore.md` changes, and inspect the source. [Everyday review workflow](/docs/using-lore/#review-knowledge).

For the request pipeline, storage layers, and context-budget rules, see the
[architecture reference](/docs/architecture/). To adjust relevance behavior, see
[tune knowledge injection](/docs/guides/tune-knowledge-injection/).
