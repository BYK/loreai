---
title: "Local-first memory: Why your AI memory should live on your machine"
subtitle: "Lore doesn't leave you in the hands of the platform. The architecture is local-first, and we aim to keep it that way."
description: "Lore is a vendor-neutral proxy that runs on your machine. The memory lives in your repo and your local database, in open formats, run by a fair-source engine."
pubDate: 2026-07-29
author: Burak Yigit Kaya
tags:
  - infrastructure
  - open standards
  - data
  - ownership  
---

Last April, Harrison Chase wrote an essay called
[Your harness, your memory](https://blog.langchain.com/your-harness-your-memory/).
He named what the AI tooling industry has been circling for a year.
Memory is the new lock-in. The harness owns it by default, and the
harness is what every platform is racing to be.

He was right about the diagnosis. He was wrong about the
prescription, and the wrongness is self-serving.

> "There is sometimes sentiment that memory is a standalone service,
> separate from any particular harness. At this point in time, that
> is not true."
> — Harrison Chase, [Your harness, your memory](https://blog.langchain.com/your-harness-your-memory/)

LangChain builds harnesses. The argument is a fit for their product.
The analogy is wrong on the merits too. Memory is part of your brain.
Agent harnesses are like your body, the limbs and everything. You
don't move your memory to your limbs. You move your memory to your
brain.

The time has come. Lore is the standalone memory service, and it is
the architecture that gets you out of the trap.

## The platform owns your data. You should.

When a closed platform builds "agent memory," it stores your team's
decisions in a proprietary database behind an API. Retrieval shapes
the agent, and the shape of the agent is the shape of the moat.
Switch IDEs, switch models, switch anything, and the team rebuilds
months of context from scratch. The lock-in is the product.

Harrison names three levels. The mild one stores state on the
provider's server so you cannot move threads between models. The bad
one runs a closed harness that interacts with memory in ways you
cannot see, and the artifacts are not portable. The worst one puts
everything behind an API, including long-term memory, and you own
none of it. Anthropic's Claude Managed Agents already lives in the
second camp; Codex builds an encrypted compaction summary nothing
outside OpenAI can read. The incentive is everywhere, and it points
the same way.

Six months of careful work, six months of capturing a team's taste,
and a vendor change returns the team to zero.

## Lore is local-first. We aim to keep it that way.

Lore is a vendor-neutral proxy that sits between your harness and
your model. The whole engine runs on your machine. The memory lives
in your repo and your local database, in open formats you can read
with or without Lore.

<figure>
  <svg viewBox="0 0 460 460" xmlns="http://www.w3.org/2000/svg" style="max-width: 460px; width: 100%; margin: 1.5rem auto; display: block;" role="img" aria-label="Lore architecture: the harness on top, the model provider API on the bottom, and Lore sits between them as a local-first vendor-neutral proxy whose artifacts live on your machine.">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#1a1a1a" />
      </marker>
    </defs>

    <rect x="40" y="20" width="380" height="80" rx="8" fill="#fafafa" stroke="#1a1a1a" stroke-width="1.5" />
    <text x="230" y="55" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="600" fill="#1a1a1a">Harness</text>
    <text x="230" y="78" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#5a5a5a">Claude Code · OpenCode · Pi · Codex</text>

    <line x1="230" y1="105" x2="230" y2="135" stroke="#1a1a1a" stroke-width="1.5" marker-end="url(#arrow)" />

    <rect x="20" y="140" width="420" height="170" rx="8" fill="#c4ddc7" stroke="#1a1a1a" stroke-width="2" />
    <text x="230" y="175" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="20" font-weight="700" fill="#1a1a1a">Lore</text>
    <text x="230" y="198" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" font-style="italic" fill="#1a1a1a">local-first, vendor-neutral proxy</text>

    <rect x="60" y="225" width="340" height="55" rx="6" fill="#ffffff" stroke="#5a5a5a" stroke-width="1" />
    <text x="230" y="245" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="#1a1a1a">.lore.md  +  ~/.local/share/lore/lore.db</text>
    <text x="230" y="265" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" font-style="italic" fill="#5a5a5a">on your machine, in open formats</text>

    <line x1="230" y1="315" x2="230" y2="345" stroke="#1a1a1a" stroke-width="1.5" marker-end="url(#arrow)" />

    <rect x="40" y="350" width="380" height="80" rx="8" fill="#fafafa" stroke="#1a1a1a" stroke-width="1.5" />
    <text x="230" y="385" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="600" fill="#1a1a1a">Model Provider API</text>
    <text x="230" y="408" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#5a5a5a">Anthropic · OpenAI · Google · others</text>
  </svg>
  <figcaption style="text-align: center; font-size: 0.9em; opacity: 0.8; margin-top: 0.5rem;">
    Lore is the brain. The harness is the body. The model provider API is the cognition.
  </figcaption>
</figure>

What you actually own is two things:

- **`.lore.md`** at the root of your repo. The curated knowledge the
  team has reviewed and merged. Version-controlled, PR-reviewable,
  human-readable Markdown.
- **A local SQLite database** at `~/.local/share/lore/lore.db`. The
  full record: raw conversations, distillations, long-term memory,
  entities. Open schema, queryable with `sqlite3`, exportable.

The engine that ties them together is fair source
(FSL-1.1-Apache-2.0). The code that touches your tokens is right
there to read, and it turns into Apache 2.0 on a timer.

The vector database lives inside Lore, on your machine. It is the
runtime cache for semantic search, and it is the right tool for it.
When a team changes a memory entry, the engine picks up the change
on the next session and re-embeds the affected entries automatically
— fast, transparent, and on your hardware. No batch job, no
re-indexing window, no waiting for a vendor to apply your team's PR.

## The vendor route vs the local-first route

A vendor-managed memory stack says: trust us with the shape of your
team's thinking, and we will give it back to you on retrieval. It
has to work that way, because the data lives behind an API, and the
schema is whatever the vendor chose. To change a memory entry, you
ask the vendor. To delete an entry, you ask the vendor. To export
the corpus, you ask the vendor. To move to a different harness, you
ask the vendor. The lock-in lives in the dependencies you cannot
see.

Local-first says: the data lives on your machine, in open formats,
and the engine is the source code in front of you. To change a
memory entry, you edit the file. To delete an entry, you delete the
row. To export the corpus, you run `sqlite3 lore.db .dump`. To move
to a different harness, you point the new harness at the same files.
The lock-in lives wherever you let it live, and you can move it any
time.

When your team is ready to share, the sync engine works the way a
good group chat does: end-to-end encrypted, scoped to the entries
you explicitly approve, and the relay never sees plaintext. The
keys stay with the participants. Sharing is opt-in, per entry, and
reversible.

## Why this matters

We have talked before about
[why knowledge lives in token space, not in weights](/blog/distill-your-own-knowledge/).
The same logic applies to where the token-space lives. A vector store
in someone else's cloud is halfway there. A vector store on your
machine is the rest of the way.

Models will keep changing. They always do. Every part of the AI
tooling stack above the model is genuinely up for grabs right now.
The part that should not be up for grabs is who owns your team's
data. That belongs to the team, on infrastructure the team controls.

Lore is local-first. We aim to keep it that way.

## Try it

```bash
curl -fsSL https://withlore.ai/install | bash
lore run
```

After a few sessions, open `.lore.md` and the database at
`~/.local/share/lore/lore.db`. Read what your agent has written
down. Open a PR when it gets something wrong. That is the workflow.
