---
title: "Why memory is not enough"
subtitle: "You need context management"
description: A long-term memory store remembers what you said last week. It can't manage the context window that's overflowing right now. Those are two different problems, and only one of them is getting solved.
pubDate: 2026-06-26
author: Lore Team
tags:
  - memory
  - context management
  - agents
---

Ask anyone building agents what "memory" means and you'll get the same answer: a place to
store facts and decisions so the agent can retrieve them later. A vector DB, a knowledge
graph, a directory of notes, take your pick. It remembers what you discussed last week.
That part is real, it's useful, and there are now solid tools that do it well.

Now ask a different question. What happens when the session you're in *right now* crosses
180K tokens and the agent starts forgetting how it began?

The answer you tend to get is a list of chores.

Spin up a background agent so the heavy work stays off your main thread. Write the plan to
a file. Then a second plan, and a third, stacked on top of each other. Open a trail of
GitHub issues. Leave notes in scratch markdown files. Keep a tidy `AGENTS.md`, and prompt
more carefully while you're at it. Every one of these is the same move: manually push state
*out* of the window and hope it finds its way back when it matters. That isn't managing
your context. It's you doing the filing.

Maybe your tools handle that filing for you now, pulling it straight from the conversation
so you never lift a finger. Better, but capture was never the hard part. What gets written
down isn't the question. What stays in the window *this turn* is, and saving it off to a
store, by hand or automatically, doesn't decide that.

And when the filing isn't enough, when the window actually fills mid-task, the one
automatic mechanism every major agent ships finally kicks in: compaction. The client
summarizes the older turns into a lossy blob, drops the originals from the window, and hands
you back an agent that was a genius a minute ago and now can't quite remember its own name.

This is the fix we all quietly accepted, or got talked into, for something that happens
*every single session*. Often more than once in the same one. Sit with that for a second:
the most predictable failure in agentic coding, the one you can set your watch by, and the
state of the art is a guillotine that drops the moment you fall behind. Nobody set out to
confuse context management with memory. We just decided the window was your problem to
babysit, and moved on. So why has nobody built the thing that actually keeps up?

## Two problems hiding behind one word

| What you say | What it actually needs |
|---|---|
| "What did we decide about auth last week?" | A long-term memory store. |
| "Wait, what was the other thing you said we should do after this?" | Active context-window management. |

These are not the same layer. A long-term store sits *beside* your conversation, like a
notebook you keep open on the desk. It only holds what you bothered to write down, and it
only helps when you reach for it. That's exactly right for what carries across sessions: a
decision, a preference, a constraint from days ago. This part has had real product
attention, and it shows.

The live window is the other half, and it's the one you're left to manage by hand, mid-task.
People do this well, but it's a tax: every note you set down pulls your focus off the actual
problem, and you have to remember to pick it back up later. And every tool for it is the
same shape: static (a markdown file the model may or may not read), offline (an indexer you
run between sessions), or just advice ("prompt better"). None of it is in the loop at the one
moment that matters, when the window is overflowing *while you work*. The one mechanism that
does fire on its own is compaction.

## A store on the sidelines can't intervene

That compaction step is triage with a blunt instrument: it runs whether or not it's about to
drop something you still need, with no idea what's worth keeping. Now bolt the best long-term
memory store on the planet onto the same session. What changes? Nothing. The store can answer
a question *if you ask it*, but compaction doesn't ask questions. It just runs. The store
never gets a vote on what survives. So you can have flawless recall of last week and still
watch the agent get amnesia at 200K tokens.

Some tools go further than a hand-fed store: they keep the entire conversation and let you
search over it. That's genuinely better, and it's worth saying so. But searching is
something *you* have to do, after you've already noticed something went missing, and
whatever you pull back lands in the same window that was overflowing in the first place.
You found the needle, and the haystack is still on fire. And automating the search doesn't
save it: async, agent-native retrieval still drops what it finds into the same window, and
still never decides what *leaves* it.

There's a quieter cost on top of that: models use what's already in the window far more
reliably than what they have to go fetch. Hand a model the relevant text in-context and it
beats retrieving the same text on quality
([Li et al.](https://arxiv.org/abs/2407.16833)), and what it does hold, it reads best at the
front and back of the window, not buried in the middle
([*Lost in the Middle*](https://arxiv.org/abs/2307.03172)). Retrieval does have one honest
advantage worth naming: it can be cheaper, because pulling a few relevant snippets into the
prompt costs less than carrying the whole history. But that discount only exists if a small
slice can stand in for everything else, and an agent session doesn't work that way. The
window only grows as you go, the conversation *is* the context, and against a closed model
from OpenAI or Anthropic you can't reach in and swap it for a slice. Retrieval can only add
to the window, never stand in for it. The cheap version of RAG isn't on the table; the one
you can run just makes the window bigger.

## What managing the window actually looks like

Two hundred turns deep, that means keeping the auth decision and the path of the file you're
editing, and dropping the stale 4,000-token test dump, without anyone having to ask. To make
that call on every turn, instead of letting a blunt summarizer maul the whole thing at the
boundary, a few things have to be true:

- **A distilled prefix, not a flattened summary.** Compress the early conversation into a
  dense, structured record of what was established: the decisions, the shape of the work,
  the constraints. Keep that record at the *front* of the window where the model can always
  see it. Not "a paragraph about the first hour". The load-bearing facts, kept.
- **Gradual, layered compression, not a cliff.** Full passthrough while there's room. As
  pressure builds, compress the raw turns behind the distilled prefix. Under more pressure,
  strip what ages worst first: stale tool output, redundant dumps. Emergency compression is
  the last resort, not the opening move.
- **Calibrated from real token counts, not guesses.** The window is a hard budget. What
  gets cut should follow the actual token counts the API reports back, and what each
  model's real context and pricing are. Not a character cap hardcoded once and forgotten.
- **Some things are never cut.** The most recent turns stay intact, always. Whatever
  happens upstream, the live edge of the conversation is protected. That's where the work
  is happening.

The point isn't cleverness. It's that *something is actively deciding what stays in the
window on every turn*, in the loop, instead of a one-shot summarizer flattening the session
the moment it overflows.

## Two layers, one stack

This isn't memory *versus* context management. You need both, and they stack:

1. **Temporal storage.** Everything that's said, captured and indexed, so nothing is truly
   lost even after it leaves the window.
2. **Distillation.** That history compressed into a dense prefix, so the established facts
   survive context pressure and stay in front of the model.
3. **Long-term knowledge.** The durable decisions, patterns, and preferences pulled out and
   carried across sessions, retrievable on demand.

That store, layer 3, is what people mean today when they say "memory". It's the top of the
stack, not the whole stack. Without the two layers under it, it's a filing cabinet next to
a conversation that's quietly falling apart.

## The work this is built on

We didn't invent this architecture, and we want to be clear about that. Two teams got here
first and proved it works. Sanity's
[Nuum](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem) gave us the
framing we still use, "distillation, not summarization", and showed a three-tier memory
staying coherent across thousands of messages. (Simen Svale's description of compaction as
"JPEG compression of memory management" is hard to forget once you've read it.) Mastra's
[Observational Memory](https://mastra.ai/research/observational-memory) worked out the
observer/reflector loop and the move from rigid JSON to plain, timestamped observation
logs. Lore is built on both, and it's better for it. Their write-ups are worth your time.

There's a catch, though. Both teams shipped this architecture *inside their own agent*.
Nuum is a standalone REPL (Anthropic-only, yolo-mode, built to power Sanity's Miriad).
Observational Memory lives inside the Mastra framework. The memory is excellent. The
packaging is the constraint. Almost no one is going to replace the coding agent they
already rely on just to get a context-management layer.

## A layer, not a harness

So that's the gap: take the same ideas and unhook them from the harness. Deliver them as a
layer that works with whatever agent you're already using, on whatever provider you're
already paying for.

Here's the distinction that actually matters, and it's easy to miss now that everything
calls itself memory. A store is a tool the agent reaches for: it sits off to the side and
answers when it's asked, however clever the asking has gotten. A layer sits *in the request
path*. Every turn flows through it, and it can reshape that turn before the model ever sees
it. That position, in the path instead of beside it, is the only one from which you can
manage the live window at all.

It's also the most invasive seat in the system, and that's worth being honest about. A
thing that sees every token of every session only earns that seat if it's *yours*: a single
file on your own disk, no account to create, no database to run, nothing leaving your
machine unless you choose to share it. It's also why this is
[Fair Source](https://fair.io) (FSL-1.1-Apache-2.0): the code that touches your tokens is
right there to read, and it turns into Apache 2.0 on a timer. That last part is hard for a
cloud service to follow you into. Routing every token through someone else's box is a lot to
ask, and a lot for that box to be responsible for. The seat really only makes sense when
you're the one sitting in it.

That same vantage point, seeing every request as it happens, is also the right home for a
lot more than distillation:

- **Warm the cache automatically**, so you're not paying full price for a cold context at
  the start of every session.
- **Extract long-term knowledge on its own**: decisions, conventions, gotchas, without you
  remembering to save anything.
- **Recognize patterns** in how you and your agent actually work, and act on them.
- **Track token spend** day to day, across every agent you run.

That last one is quietly becoming the point. As model and token costs climb, the layer that
sees every request is exactly where cost control belongs, and because it runs on your own
machine, there's no infrastructure bill and no per-request meter to feed. A store on the
sidelines can't do any of this. Plenty of them run the other way: a server you're renting,
an extra model call to extract and index every exchange, and a metered fee on top of the
requests you were already paying for.

And once memory lives in that layer instead of inside one agent, it stops belonging to any
single agent. Your context follows you. Move from Claude Code to Codex to OpenCode, or reach
for a different agent on a different task, and the same memory comes along. A team running a
mix shares one knowledge base instead of three separate silos. That portability isn't the
trick. It's just what falls out once the memory no longer lives inside the harness.

Memory is the wedge. The layer is the platform.

## The one question worth asking

Next time something is pitched to you as agent "memory", ask one question:

> **What happens at 200K tokens?**

If the answer is some version of "you can search what we stored", or worse, "write a better
context file", then it's a storage tool, and the part that actually breaks mid-session is
still yours to handle. That's fine, and a good store is genuinely worth having. But it has
no answer for the session that's overflowing right now, which is the problem you'll hit
today, not next week.

Memory is table stakes. Managing the window, in the loop, while it fills, is the part
nobody wants to build. Make sure you know which one you're being sold.
