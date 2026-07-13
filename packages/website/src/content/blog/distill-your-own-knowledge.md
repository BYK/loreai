---
title: "Distill the knowledge, not the model"
subtitle: "You pay for intelligence twice. Keeping what you reveal doesn't require training a model."
description: "Satya Nadella named the Reverse Information Paradox. His fix over-solves it: your learning can stay yours in token space, without training a model."
pubDate: 2026-07-13
author: Lore Team
tags:
  - memory
  - context management
  - agents
---

## The diagnosis is right

Satya Nadella [posted this week](https://x.com/satyanadella/status/2076323181154230284) about
what he calls the Reverse Information Paradox, and if you build with these models you already
feel it. You pay for intelligence in cash, and then you pay again in the proprietary knowledge
you reveal to make it useful. The harder you push the model to perform, the more of yourself
you feed it. He's right, and it's the cleanest framing of the problem we've seen.

The valuable part is everything around a single prompt: how you work a problem, the fixes you
apply when the model gets it wrong, the standard you hold it to. Enough of that adds up to a
portrait of how your team actually thinks, and the portrait moves in only one direction. The
provider gets a little more of it every session. You get an answer to today's question and
nothing about what they kept.

## Look closely at the fix

Here's where we part ways with him, and it's worth being specific about how. Much of what he
prescribes we have no quarrel with, and some of it we already build. This is about one piece.

Nadella's answer is that enterprises should win "the rights to use model outputs to fine tune
and/or train their own models." Read that twice. The remedy he's reaching for is the right to
train on the exhaust. In the industry that has a name, distillation: using a strong model's
outputs to teach a competing model. Anthropic and the other frontier labs restrict exactly
this, which is what he means by "restrictive terms on distillation."

It's worth asking who that fix helps most. Training or fine-tuning a model on your own traces
is expensive, and it pays off only at a scale and with a purpose most companies don't have. It
reads less like a fix for everyone and more like one sized for large players who want to build
or tune models of their own. Microsoft, for its part, has no frontier-class model of its own
yet, its bet on a single provider has grown complicated, and it's now building in-house. We
can't see anyone's intent and won't pretend to. But when a fix this specific arrives bundled
with the diagnosis, it's fair to notice that the principle and the interest happen to point the
same way.

It also reaches further than the problem needs. Nadella writes that the answer "requires more
than data protection," and leans on that to justify training rights. But look at the leak he
actually describes: the provider walks away with a compounding record of how you work, and you
walk away with nothing durable. That gap closes the moment you start keeping and compounding
the learning on your own side. You do not need the right to train a model to do that. Training
rights are a separate, much larger ask, folded into the same sentence as if they were the same
need.

## Learning doesn't have to live in weights

The move that dissolves most of the debate is noticing that "learning from your interactions"
and "training a model on your interactions" are two different things.

There are two kinds of distillation. One compresses a teacher model into a student's weights.
That's the kind under dispute, the kind that's expensive, and the kind the frontier labs
forbid. The other compresses your history into a compact, durable record that rides in the
context window: the decisions you reached, the conventions you set, the corrections you made.
No training run. No weights. No violated terms.

When we say distillation, we mean the second kind. It's the framing we took from Sanity's
[Nuum](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem), distillation, not
summarization, and it's the whole reason Lore can hand you a compounding learning loop without
going anywhere near a model's weights.

## What Lore does instead

The learning accumulates in a single file on your own disk. Distillation compresses your
sessions into a dense record of what was established. The knowledge layer pulls out the
decisions, conventions, and gotchas as they happen, including the ones you only ever expressed
by correcting the model. You never have to remember to save anything, and none of it lives in
someone else's tenant. No account, no server, and none of this learning leaves your machine
unless you choose to share it with your team.

Be honest about the wire: your prompts still go to whatever model you're using, because that's
how you get an answer. Lore doesn't pretend otherwise. What it changes is the other side of the
ledger. The distilled history, the extracted knowledge, the patterns, the record of every
correction, all of it gets captured and compounded on your side too, in token space, where no
distillation rule reaches. The provider still sees each turn. It just stops being the only one
that walks away with a durable record.

That seat, seeing every token of every session, only makes sense if it's yours. It's why Lore
is [Fair Source](https://fair.io) (FSL-1.1-Apache-2.0): the code that touches your tokens is
right there to read, and it turns into Apache 2.0 on a timer.

## Portability without the weights

Nadella's sharpest point is about lock-in. If the model you rely on were taken away tomorrow,
would your veteran capability go with it, or would it stay with you?

This is the part we already shipped. Lore sits between you and the model, outside any one agent.
Your memory doesn't belong to Claude Code or Codex or OpenCode. It belongs to the file. Switch
models, switch agents, run three at once, and the same accumulated context comes along. A
generalist model becomes a veteran of your codebase, and that veteran capability is yours to
keep. Take the model away and the learning stays. You get the portability he's asking for
without owning a single weight.

## You can skip the debate

Whether the frontier labs should loosen their terms on distillation is a real argument, and
it's going to play out over years between companies with far more at stake than you. You're
welcome to watch it.

You don't have to wait for it. The learning loop Nadella says every organization needs already
exists in a form that asks no one's permission: token-space, local, model-agnostic, running
today. In consuming intelligence, you are creating intelligence. That's his line, and he's
right about it. The only question is who keeps it, and you can answer that one yourself this
afternoon.
