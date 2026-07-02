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

The field is converging on an idea: agents should manage their own context. Give the
model tools to edit its own instructions, let it decide what to keep and what to drop, teach
it to notice when its own memory is going stale. It is a genuinely interesting bet, and the
teams chasing it are doing real work. Writing those principles down, out in the open, is a
good instinct too.

Lore takes a different road to the same destination. You never have to manage memory, and
neither does the agent. A fixed set of rules, enforced by the layer that sits in the request
path, makes the call on every turn instead. That distinction matters more than it sounds. A
set of principles written *for* an agent is guidance, and it holds only when the agent is
paying attention. The same principles built *into* the layer are guarantees. They hold
whether or not anyone is paying attention that turn.

So here are the rules Lore runs on. Not aspirations we hope a cooperative model follows: the
actual behavior of the layer that touches every token.

## You never have to remember to remember

Capture is automatic. Lore sits between your agent and the model, and it distills your work
as it happens. You do not tag a message, save a decision, or file anything away for later.

This is the whole reason capture lives in the layer. Memory you have to reach for is memory
you will forget to reach for, right at the moment you are heads-down on the actual problem.
The filing was never the hard part, and it should never be your job. If a rule for managing
memory depends on you (or the agent) remembering to invoke it, it is already broken.

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
two versions of one fact, and collapsing them would be Lore deciding for you. Both are kept,
ranked by confidence, and a genuine contradiction is meant to be surfaced for you to settle,
not resolved behind your back.

The layer's job here is narrow on purpose: notice the conflict, and hand it to you. Picking a
winner silently is exactly the kind of decision a memory system should not be making on its
own.

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

None of this says self-managing agents are the wrong idea. An agent that edits its own memory
is an exciting direction, and we are glad people are pushing on it.

Lore's bet is narrower, and honestly a little boring in the way infrastructure should be: the
rules that decide what stays, what fades, and what gets surfaced ought to hold on every single
turn, not only when the agent happens to be attending to them. A principle the layer enforces
is one you never have to hope about.

And because a layer that sees every token is a lot to ask you to trust, the rules above are
not a description you take on faith. Lore is [Fair Source](https://fair.io)
(FSL-1.1-Apache-2.0), so the code that decides what your agent remembers and forgets is right
there for you to read, and it turns into Apache 2.0 on a timer. Principles you can enforce are
better than principles you have to believe.
