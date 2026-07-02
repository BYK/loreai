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

Lore takes a different road to the same destination. You never have to manage memory, and
neither does the agent. A fixed set of rules, enforced by the layer that sits in the request
path, makes the call on every turn instead. That distinction matters more than it sounds. A
set of principles written *for* an agent is guidance, and it holds only when the agent is
paying attention. The same principles built *into* the layer are guarantees. They hold
whether or not anyone is paying attention that turn.

And because that layer sits outside the model, a model swap does not take your memory with
it. A newer model arrives brilliant and completely unfamiliar with your work, the way a new
hire does; the layer is the institutional memory already in the room, so the model is useful
on the first turn instead of the fiftieth. Change the engine as often as you like. The
assistant, and everything it has learned, stays.

So here are the rules Lore runs on. Not aspirations we hope a cooperative model follows: the
actual behavior of the layer that touches every token.

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

There is one deliberate exception. The preferences you state outright, the ones that follow
you across every project, are protected from that decay. Those are not guesses Lore made
about you, so they are not subject to the same erosion as things Lore inferred.

## When two things disagree, you get told, not overruled

Opposing rules are never quietly merged. "Always use tabs" and "always use spaces" are not
two versions of one fact, and collapsing them would be Lore deciding for you. Both are kept
and ranked by confidence.

Genuine contradictions still need settling, so Lore looks for them in the background and flags
each pair for you: on the knowledge dashboard, or from `lore data contradictions`. You pick the
rule that still holds, or you keep both. Lore never merges them and never deletes the losing
side on its own. The layer's job here is narrow on purpose: notice the conflict and hand it to
you. Picking a winner silently is exactly the kind of decision a memory system should not be
making.

## Nothing is really deleted

Knowledge is append-only. An edit writes a new version and keeps the old one; a delete leaves
a marker rather than erasing the trail. Because the history is intact, you can diff what your
agent has learned and roll it back, the same way you already do with code.

That is not an abstract property. Curated knowledge lands in a plain
[`.lore.md`](/different/) file in your repo, so a change to your agent's memory shows up in a
pull request and gets reviewed by the same people and the same process that review your code.
Memory that changes without a diff is memory nobody can audit.

## The live edge stays whole

The most recent turns are always protected. Whatever gets distilled or dropped as older
context is compressed, the active end of the conversation, where the work is actually
happening right now, is never touched. Everything else is negotiable under pressure; the edge
you are working on is not.

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

Lore's bet is narrower, and honestly a little boring in the way infrastructure should be: the
rules that decide what stays, what fades, and what gets surfaced ought to hold on every single
turn, not only when the agent happens to be attending to them. A principle the layer enforces
is one you never have to hope about.

And because a layer that sees every token is a lot to ask you to trust, the rules above are
not a description you take on faith. Lore is [Fair Source](https://fair.io)
(FSL-1.1-Apache-2.0), so the code that decides what your agent remembers and forgets is right
there for you to read, and it turns into Apache 2.0 on a timer. Principles you can enforce are
better than principles you have to believe.
