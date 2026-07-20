---
title: Semantic linter (CI)
description: Catch pull requests that contradict a documented invariant in your .lore.md, at CI time, as advisory annotations that never block the build.
sidebar:
  order: 7
---

Your team's decisions, patterns, and gotchas live in [`.lore.md`](/docs/team-memory/), a version-controlled record of how this codebase is supposed to work. The **semantic linter** reads that record and, on every pull request, flags changes that appear to contradict it.

It is a judge, not a rule engine. Instead of matching regexes, it asks an LLM whether a specific diff hunk conflicts with a specific documented invariant, and surfaces the ones that do as GitHub annotations. It is **advisory by default: it never fails a build.** A human decides what to do with each finding.

```
✓ no suspected invariant violations (45 hunks × 67 invariants → 20 candidates → 20 judge calls)
```

## What it is good for

- Surfacing the "we decided *not* to do this" cases that a reviewer would catch only if they happened to remember the original decision.
- Turning tribal knowledge in `.lore.md` into a check that runs whether or not the person who wrote the rule is reviewing.
- Doing this cheaply. Most hunk/invariant pairs are eliminated before any model is called (see [How it works](#how-it-works)).

It is **not** a replacement for tests, type checking, or a linter. It has no ground truth; it produces suspicions for humans, so it runs alongside your real gates and never blocks them.

## Quick start (GitHub Actions)

The repository ships a reusable composite action and a reference workflow. The zero-secret path uses [GitHub Models](https://models.github.ai) via the built-in `GITHUB_TOKEN`, so there is nothing to configure on a public or GitHub-Models-enabled repo.

Add `.github/workflows/semantic-linter.yml`:

```yaml
name: Semantic linter (advisory)

on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: semantic-linter-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: read
  models: read # lets GITHUB_TOKEN call GitHub Models as the default judge

jobs:
  invariant-check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    continue-on-error: true # advisory: never block a PR
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0 # full history so merge-base against the PR base resolves
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @loreai/gateway run bundle
      - name: Run Lore semantic linter
        uses: ./.github/actions/invariant-check
        with:
          lore-command: "node packages/gateway/dist/bin.cjs"
          model: ${{ vars.LORE_INVARIANT_MODEL != '' && vars.LORE_INVARIANT_MODEL || (secrets.LORE_WORKER_API_KEY == '' && 'github-models/openai/gpt-4o-mini' || '') }}
          worker-api-key: ${{ secrets.LORE_WORKER_API_KEY != '' && secrets.LORE_WORKER_API_KEY || github.token }}
```

That is the whole setup. Open a PR and the check runs, posting any suspected contradictions as annotations plus a job summary. It exits `0` regardless of findings.

:::caution
`fetch-depth: 0` is required. The check diffs the PR against the merge-base with its target branch; a shallow clone forces a noisy tip-to-tip diff instead of the fork-point diff.
:::

### Choosing a judge model and credential

The credential and the model are chosen independently.

**Credential** (the `worker-api-key` input):

- **Zero-secret (default).** The reference workflow falls back to the built-in `GITHUB_TOKEN` with `models: read`, calling GitHub Models. The free tier is rate-limited (~150 requests/day), which is fine for low-traffic repos. On fork PRs the token is read-only and may lack model inference, in which case the judge no-ops (advisory, still passes) rather than breaking CI.
- **Dedicated key (busy repos).** Set a `LORE_WORKER_API_KEY` secret. It takes precedence over the token.

**Model** (the `model` input, `provider/id`):

| Situation | Model used |
| --- | --- |
| `LORE_INVARIANT_MODEL` repo variable is set | that value (with either credential) |
| No dedicated key, no variable | `github-models/openai/gpt-4o-mini` |
| Dedicated key, no variable | your repo's configured default worker model |

:::note
The model id must match the credential. A GitHub token needs a `github-models/...` id (sent as a Bearer token to models.github.ai); pairing a dedicated Anthropic key with a forced `github-models` id would 401 and silently no-op. The precedence table above avoids that trap: leave `model` empty when using a dedicated key unless you set `LORE_INVARIANT_MODEL`.
:::

## How it works

The check is a three-stage funnel designed so the expensive stage runs as rarely as possible:

1. **Changed-files gate.** Only files touched by the PR are considered.
2. **Embedding cosine prefilter (free, local ONNX).** Every diff hunk is embedded and matched against the invariant embeddings. The vast majority of hunk/invariant pairs are semantically unrelated and dropped here. A large PR can generate thousands of pairs, of which only a handful survive.
3. **LLM judge.** The surviving candidates (capped at 20 per run) are sent to the judge one pair at a time: *does this hunk contradict this invariant?* Only these calls cost tokens.

The funnel line in the report (`N hunks × M invariants → C candidates → J judge calls`) shows how aggressively each stage narrowed the work.

### Where the invariants come from

In CI there is no local Lore database, so the action **derives one from the committed `.lore.md`**: it imports the plaintext entries and embeds them in-process. That derivation is cached with `actions/cache`, keyed on the judge model, the `onnxruntime-node` version, **and** the `.lore.md` content hash, so a stale embedding space is never silently reused (embedding drift would quietly rot recall). The cache only rebuilds when the knowledge or the embedding stack changes.

:::caution
`.lore.md` omits cross-project (global) invariants, roughly a dozen entries that span repositories. A `.lore.md`-sourced check therefore has slightly narrower coverage than a full local database. This is acceptable for the advisory tier; do not rely on it to enforce global rules.
:::

### Which invariants are eligible

Not every `.lore.md` entry is a candidate. The check only considers **prescriptive** invariants: entries that state a rule ("always…", "never…") that a code change could actually contradict. Descriptive facts about workflow, sessions, or personal preferences are skipped, because a spurious flag there is pure noise. Enumeration-style invariants (lists that are expected to grow) are surfaced at most as advisory notes, since reordering or extending a list is legitimate drift, not a violation.

## Tuning

### Reasoning effort

`--effort` (or the `invariantCheck.effort` config key) is a cost/depth dial for the judge on reasoning-capable models. It accepts `off | low | medium | high | xhigh` and defaults to `off`.

- On a reasoning model, higher effort spends more tokens reasoning about each hunk/invariant pair, which helps when subtle contradictions are being missed.
- On a non-reasoning model (like `gpt-4o-mini`, the zero-secret default), it is ignored.

Set it per-repo in `.lore.json`:

```json
{
  "invariantCheck": {
    "effort": "medium"
  }
}
```

Or per-run via the action's `effort` input, or the `--effort` CLI flag. The flag overrides the config value.

## Running it locally

The same check is available from the CLI, which is the fastest way to try it against a real range before wiring up CI:

```bash
lore invariant-check --base <sha> --head <sha>
```

With no arguments it auto-detects the range (the current branch against its base). Useful flags:

- `--model <provider/id>` sweeps a specific judge model.
- `--effort <level>` sets reasoning effort, as above.
- `--project <path>` checks a different working tree.
- `--json` emits machine-readable output (what the CI reporter consumes).

In advisory mode the command always exits `0`; a genuine tooling error (for example, no resolvable range) exits `1`.

## Enforcement tiers

The linter ships **advisory-only**: findings are surfaced, nothing blocks. This is intentional. A probabilistic judge is right to inform a human but wrong to gate on until a team has watched its false-positive rate on their own repo.

A graduated ladder is designed above advisory:

- **advisory**: a note; never fails a build. (Shipped, the default.)
- **soft**: an overridable gate. A finding blocks unless the PR author adds a `lore-override: <invariant> — <reason>` trailer to a commit in the range.
- **strict**: a hard gate that cannot be overridden.

An invariant only escalates past advisory when its author explicitly opts it in (an `enforce` marker), and enumeration invariants are always capped at advisory regardless. The `--gate` flag (and the action's `gate` input) is the switch that makes soft/strict findings blocking.

:::note
The gate/override machinery exists in the judge, but there is not yet an authoring path to set the `enforce` opt-in through `.lore.md`, so the CI check currently gates on nothing: every finding is advisory in practice. Treat gate mode as forthcoming. Use the advisory tier today and let a team tune the false-positive rate before any gate is turned on.
:::
