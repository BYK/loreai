# Semantic-lint replay evaluation

This corpus is the final labeled replay/held-out evaluation for #1771. It is
deterministic and has no model or database dependency.

Each case records:

- a fixed base/head revision (including the known #1766 and #1768 PRs);
- one human-reviewed invariant and a bounded diff-hunk replay;
- a truth label: context false positive, true violation, or clean change;
- recorded first-pass and verifier traces with calls, retries, tokens, and latency;
- controlled mutants that remove an authentication guard.

This is a locked-trace metric replay, not a live model evaluation: it does not
fetch or execute the revisions. A reviewed SHA-256 manifest binds every case's
revision metadata, invariant, hunk set, labels, and recorded traces before any
metrics are produced. The two real PR cases use full commit SHAs; synthetic
cases are labeled as such.

The runner compares three arms:

- `isolated-baseline`: judge only the seed hunk;
- `holistic-fit`: use one complete-diff call when the input fits the bounded budget;
- `adaptive-connected`: judge the seed, then use bounded connected context and
  counterevidence for tentative violations.

Run it with:

```bash
node --import tsx packages/core/eval/semantic-lint/run.ts --repetitions 3
```

The JSON and Markdown reports include split-specific and aggregate precision,
decided recall, false negatives, abstention/unresolved counts, context coverage,
semantic/transport/verifier calls, input/output/cache tokens, estimated cost,
and p50/p95 latency. Abstentions are not silently counted as clean: the report
keeps them separate from decided false negatives and checks that all controlled
mutant violations remain visible. Primary precision/recall exclude controlled
mutants; their recall is reported separately. Held-out cases use distinct
invariants and hunk sets, and held-out mutants must be independently authored
rather than naming an in-corpus labeled parent.

The traces are locked fixture observations, not a claim that one model run is a
population estimate. New cases must update the reviewed digest manifest and
remain disjoint across the labeled/held-out split; the minimum-sample and
guardrail tests should remain green.
