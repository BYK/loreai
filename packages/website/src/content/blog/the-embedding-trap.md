---
title: "The Embedding Trap: Why AI team memory must live in plain text"
subtitle: "Vector databases are great for RAG. They are terrible for team consensus."
description: "Lore picks plain Markdown over a vector database for team memory. Here is why those are not two paths to the same answer."
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

He was right. He was also right that the answer is "open memory, open
harness." What I want to add is the part he left out: *where* that
memory has to live if it is going to outlive any one vendor.

## The lock-in is the point

When a closed platform builds "agent memory," it stores the team's
decisions in a proprietary vector store. It has to, because the
retrieval shapes the agent, and the shape of the agent is the shape
of the moat. To switch IDEs, to switch models, to switch anything,
the team rebuilds months of context from scratch. That isn't a bug.
It is the product.

Harrison names three levels of bad. The mild one stores state on the
provider's server so you cannot move threads between models. The bad
one runs a closed harness that interacts with memory in ways you
cannot see, and the artifacts are not portable. The worst one puts
everything behind an API, including long-term memory, and you own
none of it. Anthropic's Claude Managed Agents already lives in the
second camp; Codex builds an encrypted compaction summary nothing
outside OpenAI can read. The incentive is everywhere, and it points
the same way.

Six months of careful work, six months of carefully capturing a
team's taste, and a vendor change returns the team to zero. That is
the trap.

## Vector databases are great for RAG. They are bad for consensus.

The pitch is always the same. Embeddings retrieve things that mean
similar things. They find what you meant, not just what you typed.
They power modern RAG, and they do it well.

That isn't where the problem is. The problem is what happens after
retrieval, when a team has to agree on what the agent should do next.
Embeddings are opaque by design. If your agent hallucinates a rule
("always reach for Redis"), where in the vector space did it learn
that? You can't open a Pull Request against a vector store to debate
the rule. You can't run a linter against it. You can't grep your
memory to ask why a particular retrieval happened, or change one
entry without the whole similarity neighborhood shifting around it.
There is no review mechanism because there is no readable artifact
to review.

A team is a conversation between people who disagree productively.
A vector store ends that conversation, because nobody can see the
thing they are arguing about. What looks like memory is a black box.

## The file you can fork

Open memory is what LangChain is asking for. Open source, model
agnostic, an open format for the artifacts. That is the bar. The
question is what the format is.

We picked Markdown for the curated half. Specifically, a single file
at the root of the repo called `.lore.md`, with one stable marker per
entry, entries sorted alphabetically by title within each category.
That is the whole standard. It is human-readable, machine-parseable,
and Git-friendly out of the box, because Git already knows how to
diff it, merge it, and review it. The diff shows up in a pull
request next to the code change the memory touches.

When the team disagrees about whether an entry is right, you do what
you already do for any other disagreement: open a PR. The debate
happens in review, on the same surface as the code the memory covers.
When the rule changes, the rule changes in the file. The agent's
behavior changes on the next session with no re-indexing, no
re-embedding, no background job. The memory moves with the code
because it lives next to the code, and git history becomes memory
history.

This is the part closed vector stores can't copy. They can copy the
format. They can't copy the workflow. The workflow is the value.

## The database underneath

The curated file is only half of what you should own. Most of what
an agent remembers is not meant to be reviewed and merged. The raw
conversation, the layered distillations, the long-term memory
entries, the entities the curator found, all the way back to the
first session. That record belongs to you too, in a different
artifact.

Lore stores the rest of it in a local SQLite database at
`~/.local/share/lore/lore.db`, with an open schema the engine
publishes. You can open it with `sqlite3`, query it with anything
that speaks the API, export it to CSV, or build your own tooling
around it. Stop using Lore tomorrow and the database is still
there. The engine doesn't sit between you and your data. The
migrations are versioned, the schema is documented, and what Lore
stored for you is what you can read.

A vector store asks you to trust the retrieval layer because the
embedding model and the indexing choices the store made are opaque
to you. SQLite asks for nothing. The file is the database, the
database is the file.

## The escrow

A vector store says: trust us with the shape of your team's
thinking, and we will give it back to you on retrieval. It has to
be that way, because retrieval depends on the embedding model and
the indexing choices the store made for you. The lock-in lives in
the dependencies you can't see.

Lore says: the Markdown file is the curated memory, the SQLite file
is the full memory, and both are yours. Distillation writes the
Markdown. Distillation also writes the database. Review edits the
file. You read the database with or without us. Agents read the
file. Agents read the database. The model behind the agent doesn't
matter. The harness behind the model doesn't matter. The next
vendor reads the same Markdown and queries the same SQLite. The
previous vendor never had anything to lock you to.

When your team is ready to share, the sync engine works the way a
good group chat does: end-to-end encrypted, scoped to the entries
you explicitly approve, and the relay never sees plaintext. The
keys stay with the participants. Sharing is opt-in, per entry, and
reversible.

We have talked before about
[why knowledge lives in token space, not in weights](/blog/distill-your-own-knowledge/).
A vector store is halfway there. It pulls memory out of the model,
but it puts memory inside another opaque system. To finish the
move, memory has to be in artifacts humans already share a workflow
around. Markdown for the team. SQLite for the record. End-to-end
sync if and when you want it. Everything else is a concession to
someone else's moat.

Models will keep changing. They always do. Every part of the AI
tooling stack above the model is genuinely up for grabs right now.
The part that should not be up for grabs is how a team remembers
what it decided and why. That belongs to the team, in formats the
team already owns.

## Try it

The format is one file at the root of your repo, plus a SQLite
database on your machine. Both are committed, reviewed, queried,
and merged the same way as the code next to them.

```bash
curl -fsSL https://withlore.ai/install | bash
lore run
```

After a few sessions, open `.lore.md` *and* the database at
`~/.local/share/lore/lore.db`. Read what your agent has written
down. Open a PR when it gets something wrong. That is the
workflow, and that is the answer.
