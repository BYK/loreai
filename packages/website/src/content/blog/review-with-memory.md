---
title: "The Semantic Linter: Automating reviews without losing touch"
subtitle: "Why AI code reviews need grounding with team context"
description: "You can't write down your taste. But you keep working by it, and Lore learns it the way an apprentice would, then helps enforce it in code review."
pubDate: 2026-07-26
author: Burak Yigit Kaya
tags:
  - knowledge
  - code review
  - ci
  - agents
---

About ten years ago, when machine learning got good enough that you could train a real classifier
without a research lab, I had a specific project in mind. I wanted to train something that reviewed
code the way I did, so I could step back from reviewing every change without the codebase drifting.
I never built it. I never had enough of the right data, and I never had the time.

The debate about review has finally caught up with the project I never built, and I think both
sides are half right.

## The same complaint from two sides

One camp says the whole point of writing code with agents is that a human still reads every line
before it ships. Slow down, look closely, stay in control. The other camp, often the same people
on a different day, says the job has turned into something worse: you don't write much anymore, you
sit and read change after change the machine produced, and it is dull and a little soul-crushing.
Reviewing slop, they call it.

Those are two views of one loss. Review used to be where judgment happened and where the
team learned how the codebase was meant to work. Now it has shrunk to a checkpoint you sign off on.
The "read every line" camp wants to protect what review was. The "this is soul-crushing" camp is
telling you it has already gone. Both are reacting to one loss.

A colleague told me the human side of this a few months ago. When he joined the team, he said, he
learned a lot from getting detailed reviews from me, the kind where you explain not just what to
change but why the team works this way. What he picked up wasn't a list of rules. It was a way of
working. Now we mostly work on our own, agents write and review most of the code, and he misses it.
He wasn't complaining about speed. He was noticing that something had stopped passing between us.

Armin Ronacher [wrote about this](https://lucumr.pocoo.org/2026/7/13/the-tower/) from the other
end. The shared understanding a team keeps of its own system used to be a byproduct of the friction
in working together, and agents have quietly removed the friction. My colleague felt that up close.

## What review was really passing along

A review was never only a gate. It was how one person's standard reached everyone else. You don't
mock the database in integration tests, and here's the migration bug that taught us why. Deploys go
from the release branch, because of the time they didn't. The standard arrived with its reason, at
the moment it mattered, to whoever was on the change.

When that stops, the standards don't disappear. They stop showing up when they're needed, and six
months later a pull request quietly brings back the exact thing the team decided against. Nobody
used bad judgment. The change looks reasonable on its own. What was missing was a reviewer who knew
the standard and noticed, right then, that the change cut against it.

## You are what you do, not what you write down

That is the hard part, and it's why the project I never got to needed data I never had. A review
teaches the person reading it, but it's a poor thing to learn from at scale. It's the verdict, not
the reasoning: "don't do this here" lands, and the thinking that led me there stays in my head. Most
of what makes a good reviewer good is taste, built from years of doing the work, and you can't write
it down. Ask someone to put their standards in a document and you get a thin, lifeless version of
what they actually do. But you keep doing it, review after review, and the standard is real even
when the document isn't.

That's the shift that makes this possible now. Lore watches the work the way an apprentice does. It
sits alongside your sessions, distills what you decide and why, and writes it down for you as
[`.lore.md`](/docs/team-memory/), a version-controlled file of the team's decisions and gotchas,
reviewed in pull requests like any other file. We've written before about
[why knowledge lives in text](/blog/distill-your-own-knowledge/). You don't write docs that go
stale in a few weeks. You work, and it learns.

An apprentice is not you, and I want to be honest about the ceiling. It won't learn your deepest
judgment, the calls that come from taste you couldn't explain if you tried. But it learns the
standards you set often enough, and that turns out to be a lot of them.

## The apprentice reviews the code

This is the thing I wanted ten years ago, and it turns out the achievable part was the part that
mattered. Not a machine that thinks like me. One that learned the standards and speaks up when a
change goes against one.

So we built a check that reads the diff against what Lore has learned. On every pull request, the
[semantic linter](/docs/guides/semantic-linter/) takes the changes and the standards from
`.lore.md` and asks, for the pairs that look related, one question: does this change go against
something the team decided? When the answer looks like yes, it says so, as an annotation next to
the line, with the reason attached. The reason is the point. It's the part of the review that used
to pass from person to person and stopped.

It's a judge, not a rule engine. "Never mock the database in integration tests" isn't a pattern you
can match with a regex, and any lint rule that tried would be brittle and easy to route around. It's
a meaning, and you can only check it by understanding what the change does and what the standard
intends. The honest cost is that a judge produces suspicions, not verdicts. It can be wrong, and we
designed around that instead of pretending otherwise.

## The boring part, handled

If you're in the "read every line" camp, what you're rightly afraid of is a noisy check that blocks
work on a bad guess. We share that fear, so the linter ships advisory only. It never fails a build.
It leaves a note and a human decides. A check that guesses and can break CI would teach everyone to
ignore it inside a week.

And if you're in the "this is soul-crushing" camp, look at what it takes off you: the dull part,
checking every change against every standard the team ever set, which is the work no human does well
or enjoys. What's left is the judgment, the taste, whether this is even the right change. The part
worth doing.

A ladder above advisory is designed in. Once a team has watched how often the check is wrong, a
rule can graduate to a gate, with an override for the author who knows better. That part is still
coming. Today everything stays advisory on purpose, because the system should earn trust before it
can block anything.

## Where's the limit?

I'm not claiming the reviewer goes away. On the contrary, we're lightening the reviewer's load so
they can do more of what's valuable: real judgment and taste. Here's the line: no reviewer can hold
every standard the team ever set and apply the right one at the right moment. That one job a system
does well, and handing it over costs you none of the taste you were afraid to lose. It gives you
back the attention for the parts that need a person, and brings back, a little, what used to pass
between people when they reviewed each other's work.

That's the version of automated review I'd ask a doubter to try. Not a bot that approves or rejects
your PRs. An apprentice that learned how you work and speaks up when a change breaks from that, and
otherwise stays quiet.

## Try it

Install Lore and let it learn from a few sessions:

```bash
curl -fsSL https://withlore.ai/install | bash
lore run
```

Then run the check against any range and see what it flags:

```bash
lore invariant-check --base main --head HEAD
```

With no arguments it auto-detects the range. When you're ready for CI, the
[semantic linter guide](/docs/guides/semantic-linter/) has a copy-paste GitHub Action.

