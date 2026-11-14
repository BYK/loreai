---
title: Try a project-memory workflow
description: Follow a webhook decision from a conversation to reviewed knowledge and a later coding task.
---

Use a disposable project to see the workflow. This example illustrates a useful
result; it is not a benchmark or a guarantee about when extraction will run.
[Verify your connection first](/docs/first-session/).

## Record a decision

Tell your connected coding agent:

> This webhook provider can deliver the same event twice. Check the event ID before
> applying an update. Reuse the shared duplicate check. Also, let's get lunch at noon.

Continue normal work on the example. In the local browser, confirm the conversation
appears under **Sessions**. That is the first observable result.

## Review what becomes knowledge

When curation produces an entry, open **Knowledge** and inspect **Source & history**.
A useful entry would capture the duplicate-delivery rule, without turning the lunch
plan into a durable project convention. Correct inaccurate wording before sharing it.

A simplified review diff might look like this:

```diff
+ **Idempotent webhooks:** Check the event ID before applying a webhook update.
+ Reuse the existing duplicate check; the provider may redeliver the same event.
```

This is an illustrative diff excerpt. Real `.lore.md` entries include identity markers
and categories; retain those when editing. Do not create a fake generated file just
to make the demonstration pass.

## Use it in a later task

Start another connected session in the same project and ask:

> Add retries to the webhook handler. Look up our previous duplicate-delivery decision first.

Inspect the agent's answer, recall results, and resulting code. Does it reuse the
event-ID check? Does it cite or recover the original reasoning? The unrelated lunch
plan should not drive this implementation. Check the actual behavior rather than
assuming a recorded memory was supplied or followed.

## What this proves

A recorded conversation, a reviewable knowledge entry, and successful retrieval
are separate observations. This small workflow helps you inspect those stages;
it does not establish a general accuracy or cost improvement.

[Read the historical evaluation and its limitations](/docs/benchmark/) or
[learn to review and correct knowledge](/docs/using-lore/#review-knowledge).
