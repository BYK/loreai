---
title: "How Lore remembers, forgets, and changes its mind"
subtitle: "The principles behind memory that manages itself"
description: Most memory tools now ship a set of principles for how an agent should manage its context. Lore's principles work differently, because the layer enforces them instead of asking the agent to. Here are the rules Lore runs on.
pubDate: 2026-07-02
author: Lore Team
tags:
  - memory
  - principles
  - agents
kind: "Engineering"
takeaway: "Stored history, active knowledge, and the material supplied to a request have different lifecycles. Review inaccurate knowledge and check its source."
nextStep:
  label: "Review and correct knowledge"
  href: "/docs/using-lore/#review-knowledge"
---

Everywhere you look, agents are being taught to fix themselves. Self-healing loops,
self-improving memory, a model that reads back its own transcript, rewrites its own
instructions, and prunes whatever it decides has gone stale. There is real energy here, and
some of it genuinely works.

Here is the catch, and it is an old one. Self-correction is the hardest kind. Whatever made a
mistake is usually the worst-placed thing to catch it, because from the inside the mistake
still looks like a reasonable call. People hit this constantly, which is why we lean on
outside help: an editor for the draft you have read too many times, a reviewer for the code
you are sure is fine, a colleague who remembers you already tried that back in March. The
whole value is that they are not you. A model sits in the same spot. Once it has written a
shaky assumption into its own memory, it is not the thing you can count on to go back and
find the error.

Lore puts capture and context management in a layer outside the agent. Once your
client is connected, that layer can record conversations, distill older context,
and select stored knowledge for a request. The model does not have to remember
to maintain every part of that record itself.

That does not make the resulting memory infallible. Distillation is lossy,
curation can produce an incomplete rule, and selection depends on the current
task, scope, confidence and context budget. Review what Lore keeps, especially
before turning it into a shared project convention.

A model change can leave the local record available to another supported client.
Whether a particular request receives the useful part of that record still needs
to be checked. Here are the principles behind that workflow, with its limits.

## You never have to remember to remember

Capture is automatic. Lore sits between your agent and the model, and it distills your work
as it happens. You do not tag a message, save a decision, or file anything away for later.

This is the whole reason capture lives in the layer. Memory you have to reach for is memory
you will forget to reach for, right at the moment you are heads-down on the actual problem.
The filing was never the hard part, and it should never be your job. If a rule for managing
memory depends on you (or the agent) remembering to invoke it, it is already broken.

Getting it back works the same way. When memory only returns because the agent thought to
call a search tool, the knowledge can be sitting right there and never reach the model,
because nobody went looking. Lore surfaces what is relevant on its own, and keeps a recall
tool for when the agent wants to dig deeper, so recall does not hang on the agent's
discipline on any given turn either.

## Being surfaced is not being right

When Lore pulls a memory into your context, that is a bet about what might be relevant this
turn. It is not a vote on whether the memory is true. Selecting an entry never raises its
confidence.

That separation keeps the store honest. A note that keeps getting surfaced but never actually
helps does not get more entrenched just for being loud. Confidence is earned somewhere else,
by whether the knowledge holds up in practice, and the act of showing it to the model is kept
strictly out of that accounting.

## Confidence is earned, and it decays

Every entry carries a confidence score. It rises when the knowledge proves useful across
sessions and drifts down when it sits untouched. Fall below the floor and the entry is
evicted. The store stays bounded by usefulness rather than by a fixed timer that forgets
things on a schedule, whether or not you still need them.

There is one deliberate exception. Some explicitly stated preferences receive different treatment from inferred knowledge.
Inspect scope and configuration before assuming an entry applies across projects.

## When two things disagree, you get told, not overruled

Conflicting rules deserve a review rather than a silent assumption. When Lore
flags a contradiction, inspect both entries and their sources in the knowledge
dashboard or with `lore data contradictions`. Correct an outdated rule, retire
it, or keep both if they apply in different circumstances.

Detection is not a guarantee that every conflict has been found. Curation,
confidence changes and consolidation can also change the active set. Review
consequential rules and the exported diff as the project evolves.

## Changes leave a reviewable history

Ordinary knowledge edits append a revision. Deleting an entry marks it deleted
rather than immediately erasing its version history. Those revisions help you
inspect what changed; they do not mean all data is retained forever.

Bulk deletion and purge operations have different effects. Uninstall normally
preserves memory; the explicit purge option can remove the default local data
directory. Neither operation removes copies already committed to Git or data
already sent to a provider. Read the [data lifecycle and cleanup boundaries](/docs/data-and-costs/#undo-or-remove-lore)
before choosing an operation.

Curated knowledge can be exported to a plain `.lore.md` file. Review that diff,
and keep identity markers when correcting an entry. Version history and a Git
review help you inspect a rule; neither proves that it is correct.

## The current request has a context limit

Lore aims to retain recent working material while distilling older context. Under
pressure it can compress tool output and use more aggressive context layers.
A stored detail is not necessarily present verbatim in the current prompt.
Use recall and the recorded conversation when exact wording matters; see
[stored history and active context](/docs/memory/).

## What's learned lives in tokens, not weights

Lore learns by writing durable text, not by fine-tuning the model. That is a deliberate
choice. Text is something you can read, carry across providers and across model generations,
and undo a line at a time. Knowledge baked into weights is none of those things: you cannot
inspect it, it does not move to the next model, and you lose it on the upgrade. The model is
the part you replace. The knowledge is the part you keep.

## Boring on purpose

Making a model better at checking itself is worth doing, and we hope it keeps improving. But
the corrections you can lean on are the ones that do not wait for the model to notice, this
turn, that it was wrong. Those come from outside it.

Lore's bet is that capture, review and retrieval belong in an inspectable layer,
with rules you can test and correct. That reduces the housekeeping asked of the
agent, while leaving you responsible for checking consequential knowledge.

And because a layer that sees every token is a lot to ask you to trust, the rules above are
not a description you take on faith. Lore is [Fair Source](https://fair.io)
(FSL-1.1-Apache-2.0), so the code that decides what your agent remembers and forgets is right
there for you to read, and it turns into Apache 2.0 on a timer. Principles you can enforce are
better than principles you have to believe.
