---
title: "The compaction tax"
subtitle: "We benchmarked what memory actually costs you, in dollars and in focus"
description: A real coding-agent memory benchmark, with receipts. The two taxes memory puts on your dollars and your focus, each with a number attached.
pubDate: 2026-07-22
author: Lore Team
tags:
  - memory
  - context management
  - benchmark
  - agents
---

We have made two arguments on this blog. In
[Why memory is not enough](/blog/why-memory-is-not-enough) we said a store off to the side
cannot save the session overflowing right now, because compaction runs whether or not it
is about to drop something you still need. In
[How Lore remembers, forgets, and changes its mind](/blog/how-lore-remembers-and-forgets)
we said capture has to be automatic, because memory you have to reach for is memory you
will forget to reach for.

Arguments are cheap. So we built a benchmark and ran it, and this post is the receipts.

Agents pay two taxes on memory today. The machine charges one, in dollars and lost
context. You charge yourself the other, in attention. We can now put a number on both.

## How we measured it

The full protocol is in the repo (see
[the methodology](https://github.com/BYK/loreai/blob/main/packages/core/eval/live/METHODOLOGY.md)),
and you can reproduce it with `lore eval`. The short version:

Every run drives a real OpenCode agent, turn by turn, against a real model. We plant four
values, stated once in passing, that you cannot guess from the code: an order status, a
sales channel, a region, a warehouse. If they show up in the file the agent writes at the
end, something carried them. The scorer checks for those four values by hand, so no model
grades its own homework. We ran it across three models, from cheaper everyday ones
(MiniMax-M3 and DeepSeek V4 Flash, capable but not frontier) up to a frontier flagship
(Claude Sonnet-5), because that split is where the two approaches part ways.

This is not the first version of the benchmark. Like any real task, we had to iterate to
get numbers that were accurate, reliable, and realistic, especially when a result looked
too good for us. An early cut had the competitors at a flat zero everywhere; the cause
turned out to be ours, not theirs, and once we fixed it they tied us on the frontier model.
So now, before every run, we health-probe each memory backend: if it fails to come up we
drop the run as a harness artifact, and if it comes up fine but the model never calls it,
we count that as the real zero it is. The numbers below are the corrected ones.

For the record, so you can reproduce it or pick it apart: we ran this in July 2026 on a
nightly Lore build (off `main`, well ahead of the 0.37.0 release) driving our OpenCode fork
built on **OpenCode 1.18.5**. The models were MiniMax-M3, DeepSeek V4 Flash, and Claude
Sonnet-5 (`claude-sonnet-5`). The memory competitors were
[mem0](https://github.com/mem0ai/mem0) (mem0 cloud, via the official `mem0-mcp-server`)
and [mnemonic](https://github.com/Aamirofficiall/mnemonic) 2.0.2 (the `mnemonic-ai`
package), each given both a light "keep notes" instruction and a heavy mandatory-workflow
one, and we report the better of the two.

## The first tax: compaction

Put the agent in one long session and keep working until the window fills. Every major
client does the same thing at that point: it compacts, crushing the older turns into a
lossy summary and dropping the originals. That is the moment the facts you mentioned an
hour ago quietly fall out.

One thing to be upfront about, because it shapes every token number in this post: we do
not wait for a real workload to slowly fill the window. We force it, by piping a large
reference blob into most turns, roughly 90K tokens a turn in this single-long task and a
somewhat smaller 64K a turn in the cross-session one (where it is the accumulation across
sessions, not the per-turn size, that fills the window). Think of each blob as one large
tool result, a big file the agent reads, a long log it pulls in, which is exactly the kind
of thing that fills a real context window. We do it this way because reproducing a genuine
multi-hour session that overflows on its own is slow and hard to hold steady across runs;
forcing the fill gives every arm the identical pressure on a benchmark timescale. The
consequence is that the absolute token and cost figures below are a product of that forced
fill, not a measurement of what a typical session costs, so read them as *relative*
comparisons between arms under identical load, not as a bill you would see in normal use.

Here is that session, sixteen scripted turns, with the four facts mentioned once near the
start, on the frontier model. The "steps" column is the agent's own work, the model calls
and tool round-trips it took to get through those sixteen turns, so fewer is more
efficient:

| Sonnet-5, one long session | retention | compactions | steps | cost |
|---|---|---|---|---|
| vanilla | 20% | 7 | 56 | $9.79 |
| **Lore** | **100%** | **0** | **53** | **$9.54** |

Two things are happening at once. The vanilla agent compacts seven times and keeps one
probe run in five; the retention it does have is noisy, some runs recover a fact from their
own summary, most lose all four. Lore never compacts, because it manages the window on
every turn instead of waiting for it to overflow, and it keeps all four facts every run, in
fewer steps.

The cost here is close to a tie, and that is the honest read: Lore lands just under vanilla,
about a quarter under a percent, not a headline saving. Lore's figure is the whole of its
bill, the conversation plus the background distillation that captures memory; the background
worker is a small slice of the run (about nine cents here), and this benchmark is part of
why it is small. An earlier version showed the worker re-reading whole reference blobs it
did not need, so now Lore trims an oversized user blob down to the part that carries meaning
before it ever distills, and that trimming is in these numbers. Two further savings are not:
in real use the worker runs on a cheaper model than the conversation, and against Anthropic
or OpenAI its calls go through the batch API at half price, but this harness pins one model
per run and turns batching off so it can finish distilling before the next session (more on
that below). Even so, the point of this table is not the dollar column, it is the other two:
Lore keeps every fact and compacts zero times, where vanilla compacts seven and keeps almost
nothing. A compacting agent that loses the facts is not a cheaper way to succeed, it is a
more expensive way to fail.[^meters]

[^meters]: A note on where the dollar figures come from, since the two arms are metered
differently. On the Lore arm, Lore manages the window and proxies the model calls, and
OpenCode records zero token usage for those turns, so Lore's dollars come from Lore's own
cost ledger while vanilla's come from OpenCode's usage stream. Both meters multiply the
same token counts by the same models.dev prices, so the numbers are comparable, but they
are two meters, not one, and we would rather you know that than assume otherwise.

The pattern holds on a cheaper model, where the dollars are small enough to see the shape
plainly:

| DeepSeek Flash, one long session | retention | compactions | steps |
|---|---|---|---|
| vanilla | 0% | 5 | 47 |
| **Lore** | **100%** | **0** | **36** |

The loss is quiet, which is what makes it easy to miss. Independent research on
context rot ([Chroma's report](https://www.trychroma.com/research/context-rot), and the
[contextrot](https://github.com/Priyanshu-byte-coder/contextrot) tool that measures it on
your own sessions) shows models degrade as their window fills. Compaction does not
announce itself. The agent keeps going, confident, having quietly forgotten.

## The second tax: remembering to remember

Now the cross-session case, what most people mean by memory: something said in one
session, needed in a later, separate one. That is the job a memory store is built for, so
we put Lore next to two good ones:
[mem0](https://github.com/mem0ai/mem0) (cloud) and
[mnemonic](https://github.com/Aamirofficiall/mnemonic) (a local SQLite store, the closest
analogue to how Lore keeps things on your own disk).

On the frontier model, every system with memory carried the facts, and Lore and vanilla
mark the two ends of the range:

| Sonnet-5, cross-session | retention |
|---|---|
| vanilla | 0% |
| **Lore** | **100%** |
| mem0 | 92% |
| mnemonic | 67% |

That is the honest headline: a good store works, and on a capable model it works well. We
will not pretend otherwise. Every system had captured the facts; where the competitors miss
here it is the model failing to recall on a given run, not the store failing to hold. Even
so, on the frontier model the gap is narrow, and we would rather show the spread than round
it up to a tie.

The difference shows up on the cheaper, everyday models, the kind you actually run at
scale:[^zeros]

| cross-session, cheaper model | retention |
|---|---|
| vanilla | 0% |
| **Lore (DeepSeek Flash)** | **100%** |
| mnemonic (DeepSeek Flash) | 0% |
| mem0 (DeepSeek Flash) | 0% |
| **Lore (MiniMax-M3)** | **100%** |
| mnemonic (MiniMax-M3) | 0% |
| mem0 (MiniMax-M3) | 33% |

[^zeros]: Our first instinct was that the competitor zeros had to be a harness bug. They
are not. We health-probe each memory backend before every run, and every backend here came
up fine: mnemonic's local database initialized with its full schema, mem0's cloud connected
and stored on other runs. The zeros are behavioral. On DeepSeek the model mostly never
called the store at all, in either direction; on M3, mnemonic was invoked (three to four
calls a run) and still returned nothing usable at recall time. We count these as the real
0% they are rather than excluding them, because "the cheaper model did not reliably drive
the store" is the finding, not an artifact to discard.

The gap is not about storage quality, we just saw the stores hold the same facts. It is
about who has to remember to use it. A store the agent drives only works if the agent
decides, on its own, to save the offhand value when it is mentioned, and then to go
looking for it later. When we traced the competitors' misses, the pattern was almost
always the same: the agent never called the save step in the first session. The backend
was fine, the tool was there, the model just did not reach for it. An everyday model does
not reliably reach. Lore does not ask it to. It captures as the conversation happens,
with a dedicated background pass that runs whether or not the coding model thinks to, and
surfaces what is relevant on its own. So it does not hang on the model's discipline on any
given turn.

That is the attention tax made concrete. Every store the agent reaches for is a store
that depends on remembering to reach, and the further a model sits from the frontier, the
less reliably it reaches.

## What the stores actually held

Because the interesting question is not just the score but what each system extracted, here
is the same fact, "every order defaults to channel WHOLESALE, region EMEA, warehouse WH-07,"
as each store captured it:

- **Lore**: *"Every order built in orderkit carries these fixed metadata fields:
  channel='WHOLESALE', region='EMEA', warehouse_code='WH-07'. These are not optional,
  always include them when constructing order objects."*
- **mem0**: *"User defines that every order in orderkit includes fixed fields: channel set
  to 'WHOLESALE', region set to 'EMEA', and warehouse_code set to 'WH-07'."*
- **mnemonic**: batched into a single note alongside the other conventions, terser, but
  the values are all there.

All three are correct. Lore's tends to carry a little more, the rationale, the "not
optional," a cross-reference to the related convention, because a background pass with a
dedicated model has room to write more than a tool call squeezed into the coding agent's
turn. It is a real edge, but a modest one. The decisive difference is not what gets
written, it is whether anything gets written at all without the agent being told to.

## What it costs, honestly

Cost is where memory tools get quiet, so here is ours out loud, including the part that
does not flatter us. On the cross-session run with Sonnet-5:

| | measured cost | third-party backend cost |
|---|---|---|
| vanilla | $3.92 | none |
| mem0 | $3.97 | mem0 cloud subscription, external |
| mnemonic | $4.02 | Gemini (embeddings + extraction), external |
| **Lore** | **$4.02** | none |

Lore lands right on the vanilla line here, within run-to-run noise, and it did not
start there. Two things are true at once. The retention win is real: Lore held all four
facts on every run while vanilla held none, and on the cheaper models it held them where
the stores did not. And Lore gets there on the same bill as an agent that keeps nothing.
Both belong in the same paragraph, and the second one only became true because the
benchmark forced us to chase it.

Where the cost went is worth being precise about, because the benchmark is what turned it
up. Lore's figure is the whole bill: the conversation plus the background distillation, on
one key, about $0.28 of it the worker. The rest was prompt-cache churn, and measuring this
run is how we found it. When Lore first injects a session's recalled memory it rewrites part
of the prefix, which busts the cache for that turn; on the single-breakpoint protocol this
benchmark runs through, that one rewrite re-priced far more of the prompt than it should
have. We landed three fixes off the back of it: one that stops the recalled-memory block
from busting the whole system prefix, one that stops the compression layer from oscillating
turn to turn, and one that anchors a stable cache breakpoint at the middle of the prompt so
an upstream cache eviction re-bills half the prefix at most instead of all of it. Together
they cut this cross-session figure from about $6.22 to the $4.02 above, driving the
one-turn cache spike that opened the gap down to nothing. We would rather publish the number we
now stand behind, and the road we took to it, than a prettier one we could not explain.[^meters]

The competitors' lines also hide a cost this table cannot show. mem0 runs on a hosted
subscription; mnemonic's extraction and embeddings run on Gemini. mem0's is a flat monthly
fee, near nothing per run if you already pay it, a whole plan if you do not; the Gemini
spend is real but small, and lands on a separate bill rather than your model spend. Either
way it is off the bill we can show you, and all of Lore's is on it.

And Lore's number here is pessimistic in one direction the others are not: as noted above,
the harness runs the worker on the same frontier model and with batching off, both of which
you avoid in normal use. Point the worker at a cheap model and that $0.28 bucket drops by
roughly ten times; run against Anthropic or OpenAI and the batch API halves it again. That
does not close the whole gap, but it is real, and it is on our side to keep closing.

So the honest claim is precise. On this benchmark Lore keeps every fact, answers in fewer
steps, and puts its entire cost on one visible bill, and on the frontier cross-session case
it lands on the same bill as a vanilla agent that keeps nothing. The single-long frontier
run reads the same way, near-identical bills, one that keeps every fact against one that
keeps a fifth. You do not pay a premium to stop thinking about any of this, and you still
get to account for all of it.

## What we are not claiming

The benchmark has limits and we would rather say them than have you find them.

Start with the most obvious one: we built Lore, we designed this benchmark, we ran it,
and Lore comes out on top. That is a conflict of interest and you should read the numbers
with it in mind. The best evidence we can offer that we took it seriously is the audit we
mentioned up top: our first cut had the competitors at a flat zero, we did not like how
good that looked for us, we dug in, and the zero turned out to be our bug, not their
failure. We fixed it and the competitors climbed to near-parity on the frontier model. We
still almost certainly did not tune mem0 or mnemonic as well as their own authors would. If
you maintain one of these tools and we got your configuration wrong, tell us and we will
re-run it and update the numbers.

We did not meter the competitors' third-party backends ourselves, so their totals are
visible cost plus a small off-bill charge, not a full accounting. The reliability gap on
cheaper models is real, but on the frontier model it narrows to a near-tie, and we showed
that rather than bury it. On cost, Lore lands on the vanilla line on the frontier
cross-session run rather than under it; we put the full table up rather than lead with the
retention win alone. Where the numbers are noisy, it is the vanilla arm that carries the
noise: the frontier single-long baseline swings run to run, some runs recovering a fact
from their own compaction summary and some losing all four, the shape of degradation, not
a clean failure. Lore's cells came in at a flat 100% across every model and cap here, which
we read as the task being within reach once the facts are in front of the model, not as
proof no ceiling exists. A model can still ignore a value in plain sight, the same way it
can ignore any instruction; that is a ceiling no memory layer lifts. We kept every valid
run in the averages. The only runs we dropped were ones where a memory backend failed its
pre-run health probe, a dead server the model could not have called even if it tried; a
healthy backend the model simply never reached for is kept and scored as the zero it is,
because that behavior is the finding, not an artifact. And we could not run Lore on an
anonymous free endpoint, because its background worker needs a real key.

And, as said above, the window pressure is manufactured: we pipe large reference blobs
into most turns to force compaction on a benchmark timescale. That makes the token and
cost totals artifacts of the harness, not a forecast of your bill. It is why we lean on
the ratios between arms, run under the same forced load, rather than the raw numbers.

All of it, the tasks, the scorer, the raw per-run numbers, is in the repo. Run
`lore eval` and check our work.

## Back to the one question

We ended the first post with a question to ask anything sold to you as agent memory:
**what happens at 200K tokens?** Now there is a number on it. The client compacts, you lose
most of what mattered, and it takes more steps to get there. A store off to the side does
not change that, however good the store is, because it never runs at the moment of
overflow. Managing the window in the loop does, and you never have to think about it.

That last part is not hypothetical. Building this benchmark changed the product twice, both
times because a result looked wrong and turned out to be our bug. First, an early cut
showed cheaper models dropping the incidental facts even when Lore had captured them, so we
made Lore fold a session's own distilled memory into the working context the moment it is
written. Then a sharper version of the same symptom: a cheaper-model arm scored zero, and
we had a tidy story ready about the model's ceiling, not our layer. We did not trust our
own excuse enough to skip the check, and the check killed it. The facts were captured,
embedded, and searchable; the injection path returned nothing whenever a project had no
promoted long-term knowledge yet, so on a fresh project it handed the model an empty
context. Fixing that flipped the arm from 0% to 100% on both cheaper models. And it did not
stop at retention: measuring the cross-session bill turned up three ways Lore was busting the
prompt cache more than it needed to, a recalled-memory block that re-priced the whole system
prefix on first injection, a compression layer that oscillated turn to turn, and a single
cache breakpoint that let one upstream eviction re-bill the entire prompt; fixing all three
cut the frontier cross-session cost from about $6.22 to vanilla parity. The benchmark did not
just score the product. It kept telling us where it was broken, including the times we would
rather have blamed the model.

We have claimed that memory is table stakes and that the real value is active context
management. This is the shape of the evidence. On a frontier model, a good store lands near
Lore on retention, and Lore's edge is fewer steps and a bill you can fully account for, now
paid at parity with a vanilla agent that keeps nothing. On the cheaper models people
actually run at scale, the win is retention itself, because those models do not reliably
remember to drive a store by hand, and Lore does not ask them to. We could always _feel_
that difference. Putting a test around it, and being honest when the test caught us, both on
what we got wrong and on where we still cost more, is how we keep improving it.
