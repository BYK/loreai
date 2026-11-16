---
title: Recall benchmark methodology
description: Scope, reported results, and limitations of the published mega-session recall evaluation.
---

## What was evaluated

The repository publishes results from **one recorded coding session** spanning
8–12 March 2026: 95 user turns and approximately 2.3 million tokens
(2,374,811 in the scenario metadata). Twenty authored questions target details
from different parts of that session: five late-session, seven mid-session,
and eight early-session questions.

Answers are scored against reference answers using an LLM judge and a 1–5
accuracy rubric. A score of five means an answer matches the expected specifics.
It is not a percentage of all information retained.

## Published historical results

| Measure | Lore | Simulated compaction |
| --- | --- | --- |
| Average judged accuracy | 4.0 / 5 | 2.4 / 5 |
| Perfect answers | 13/20 | 5/20 |

The ratio of perfect answers is 13/5 = 2.6. **This is not a claim of 2.6× overall
recall, speed, or cost savings.** Scores above are historical figures reported
in the repository README; this website change did not rerun the evaluation.
The transcript dates identify the scenario, not a verified date of the result run.

## Baseline and context

The evaluation code includes a simulated compaction baseline built from
multi-pass LLM summaries and a recent raw-message tail. It is an approximation,
not a direct measurement of every coding client’s current compaction behavior.
The published Lore setup describes distilled observations, a 64K raw tail, and
searchable history through recall. Context sizes, models, prompts, and worker
configuration affect the result.

## Limitations

- This is a single session and a small set of authored questions, not an
  independent benchmark across many projects.
- LLM judging introduces variability and possible bias.
- Historical result rows are reported in the README. A raw result artifact and
  complete model/run metadata are not included with that table.
- Current source or model defaults do not establish which exact configuration
  produced the historical scores.
- These scores do not establish universal quality, latency, cost, or reliability
  improvements for the current release.

## Sources and reproduction

These pinned repository links identify the evidence behind this page:

- [Published results](https://github.com/BYK/loreai/blob/82e1af50/README.md#the-mega-session-test-23-million-tokens)
- [Scenario, metadata, and authored questions](https://github.com/BYK/loreai/blob/82e1af50/packages/core/eval/scenarios/mega-session.ts)
- [Baseline implementation](https://github.com/BYK/loreai/blob/82e1af50/packages/core/eval/baselines.ts)
- [Evaluation harness](https://github.com/BYK/loreai/blob/82e1af50/packages/core/eval/harness.ts)
- [Judging implementation](https://github.com/BYK/loreai/blob/82e1af50/packages/core/eval/judge.ts)

The source tree includes the scenario and compressed transcript fixture. The
README documents this live-evaluation command:

```bash
npx tsx packages/core/eval/run.ts --mode live --scenarios mega-cli-refactor
```

A live run requires provider access, makes model calls, may incur charges, and
can produce different results. Consult the current evaluation source before
running it; this page reports the published result rather than certifying a
fresh reproduction.
