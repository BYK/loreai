---
title: Semantic linter (CI)
description: Catch pull requests that contradict a documented invariant in your .lore.md, with explicit health reporting and advisory or gate modes.
sidebar:
  order: 7
---

Your team's decisions, patterns, and gotchas live in [`.lore.md`](/docs/team-memory/), a version-controlled record of how this codebase is supposed to work. The **semantic linter** reads that record and, on every pull request, flags changes that appear to contradict it.

It is a judge, not a rule engine. Instead of matching regexes, it asks an LLM whether a specific diff hunk conflicts with a specific documented invariant, and surfaces the ones that do as GitHub annotations. It is **advisory by default: findings and health failures do not fail the build.** A human decides what to do with each finding. Gate mode fails closed when the run is inconclusive.

```
✓ no suspected invariant violations (45 hunks × 67 invariants → 20 candidates → 20 judge calls)
```

## What it is good for

- Surfacing the "we decided *not* to do this" cases that a reviewer would catch only if they happened to remember the original decision.
- Turning tribal knowledge in `.lore.md` into a check that runs whether or not the person who wrote the rule is reviewing.
- Doing this cheaply. Most hunk/invariant pairs are eliminated before any model is called (see [How it works](#how-it-works)).

It is **not** a replacement for tests, type checking, or a linter. It has no ground truth; it produces suspicions for humans, so it runs alongside your real gates and never blocks them.

## Quick start (GitHub Actions)

The repository ships a reusable composite action and a reference workflow. It uses the workflow's GitHub token with GitHub Copilot by default, or you can configure the custom credential and model pair described below.

Add `.github/workflows/semantic-linter.yml`:

```yaml
name: Semantic linter (advisory)

on:
  pull_request_target:
    types: [opened, synchronize, reopened]

concurrency:
  group: semantic-linter-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: read
  copilot-requests: write

jobs:
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    continue-on-error: true # advisory: never block a PR
    steps:
      - uses: actions/checkout@v6
        with:
          # Execute only trusted base code. The PR head is fetched as diff data.
          ref: ${{ github.event.pull_request.base.sha }}
          fetch-depth: 1
      - name: Fetch exact PR head for diffing
        env:
          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: |
          set -euo pipefail
          sha_re='^[0-9a-fA-F]{40}$'
          [[ "$PR_HEAD_SHA" =~ $sha_re ]] || exit 1
          [[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || exit 1
          git fetch --no-tags --depth=1 origin \
            "+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/lore-pr-head"
          test "$(git rev-parse refs/remotes/origin/lore-pr-head)" = "$PR_HEAD_SHA"
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @loreai/gateway run bundle
      - name: Run Lore semantic linter
        uses: ./.github/actions/lint
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
          lore-command: "node packages/gateway/dist/bin.cjs"
          model: ${{ secrets.LORE_WORKER_API_KEY != '' && vars.LORE_INVARIANT_MODEL != '' && vars.LORE_INVARIANT_MODEL || 'github-copilot/gpt-5.6-luna' }}
          worker-api-key: ${{ secrets.LORE_WORKER_API_KEY != '' && vars.LORE_INVARIANT_MODEL != '' && secrets.LORE_WORKER_API_KEY || '' }}
          github-token: ${{ secrets.LORE_WORKER_API_KEY != '' && vars.LORE_INVARIANT_MODEL != '' && '' || github.token }}
```

Open a PR and the check runs, posting any suspected contradictions as annotations plus a job summary. The reference workflow passes a 20-minute overall deadline and a 90-second per-candidate timeout, leaving five minutes for report publication and gateway shutdown.

:::caution
Use `pull_request_target` only with the trusted-base checkout pattern above. The workflow executes the base revision's code and fetches the PR head solely as immutable diff data, so the judge secret is never exposed to code supplied by the pull request.
:::

### Choosing a judge model and credential

The credential and model are selected as a pair to prevent sending one provider's key to another provider.

**Credential** (`worker-api-key` or `github-token`):

- **Default.** The reference workflow passes `github.token` to the action's loopback-only official Copilot SDK bridge. The SDK resolves the Actions installation token and its billing identity; `copilot-requests: write` grants inference access. The token is not forwarded directly to `api.githubcopilot.com`.
- **Custom provider.** Set `LORE_WORKER_API_KEY` and `LORE_INVARIANT_MODEL` together. The custom pair takes precedence over the workflow token.

**Model** (the `model` input, `provider/id`):

| Situation | Model used |
| --- | --- |
| `LORE_WORKER_API_KEY` and `LORE_INVARIANT_MODEL` are set | the variable value, authenticated by the dedicated key |
| Only one custom override is set | `github-copilot/gpt-5.6-luna`, authenticated by the workflow token |
| Neither custom override is set | `github-copilot/gpt-5.6-luna`, authenticated by the workflow token |

:::note
The model id must match the credential. The custom model and key are honored only when both are set; a partial override falls back atomically to the Copilot model and workflow token, so one provider's credential is never sent to another provider.
:::

The `github-token` bridge accepts only the Responses-compatible `github-copilot/gpt-5.6-*` family. Use `worker-api-key` for a different provider or a Copilot model that uses Chat Completions.

For a personally owned repository, Copilot usage is billed to the repository owner's Copilot seat. Organization-owned repositories must enable **Allow use of Copilot CLI billed to the organization** in their Copilot policy settings. These billing and policy requirements are separate from the workflow permission.

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
- On a non-reasoning model, it is ignored.

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
lore lint --base <sha> --head <sha>
```

With no arguments it auto-detects the range (the current branch against its base). Useful flags:

- `--model <provider/id>` sweeps a specific judge model.
- `--effort <level>` sets reasoning effort, as above.
- `--project <path>` checks a different working tree.
- `--json` emits the versioned machine-readable report on stdout for local tooling.
- `--report-file <path>` atomically writes a validated, versioned JSON report. CI uses this owned channel instead of redirecting stdout.
- `--deadline-ms <ms>` bounds the overall run (default: `1200000`).
- `--candidate-timeout-ms <ms>` bounds each selected judge candidate (default: `90000`).

The CLI exit contract is:

| Exit | Meaning |
| --- | --- |
| `0` | Complete, non-blocking report |
| `1` | Argument/usage failure before report setup |
| `2` | Complete gate-mode report with blocking findings |
| `3` | Partial or failed runtime report |

The action always consumes and validates `--report-file`, regardless of the CLI exit. Missing, malformed, wrong-version, or internally inconsistent reports are health failures. Advisory actions show those failures but remain non-blocking; gate actions fail closed.

### Report health

The report distinguishes `complete`, `partial`, and `failed` runs. It records health for range resolution, diff parsing, invariant loading, invariant vectors, hunk vectors, and the judge. Every selected candidate is recorded as resolved, unresolved, or not attempted, and the report validator checks that candidate states and semantic/transport attempt totals match the funnel counters.

“No suspected invariant violations” is shown only for a complete report with zero findings. Partial and failed reports remain visibly inconclusive even when they contain no findings.

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
