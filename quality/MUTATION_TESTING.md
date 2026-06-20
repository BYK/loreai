# Mutation testing (Stryker) — issue #832 — ⚠️ EXPERIMENTAL

Mutation testing measures whether the test suite **constrains behavior**, not just
whether it passes. Stryker makes small edits ("mutants") to source — flip `<=` to
`<`, replace a return value, delete a guard — and re-runs the tests. A mutant the
tests **kill** is behavior they pin; a mutant that **survives** *should* mean a line
no test constrains. It's the tool that directly answers "are our tests adequate?"
for the stateful modules where review — not tests — caught the recent sync bugs
(#828) and lifecycle edge cases (#816).

## ⚠️ Reliability caveat — DO NOT trust the score or the survivor list yet

On our stack (Vitest **4.1.8**, `@stryker-mutator/*` **9.6.1**) Stryker
**mis-attributes test results and reports false survivors** — mutants flagged
`Survived`/`NoCoverage` even though killer tests exist and demonstrably fail when
the mutant is applied by hand. So the **mutation score is an underestimate** and
the **per-line "gap list" contains false positives.** This is a **known upstream
bug**, not our configuration:

- stryker-mutator/stryker-js **#5928** "No proper coverage with Vitest 4" — root
  cause is a **breaking Vitest API change between 4.0 and 4.1**. A partial fix
  shipped in 9.6.1, but it is **still reproducing on 9.6.1 + Vitest 4.1.8** (our
  exact versions; see the issue's later comments).
- Tracked on our side in #843.

**Proven example:** `sync-data.ts:624` (`classifyRemoteRow` skip guard) is reported
`Survived`, but forcing that mutant (`if (true) return "skip";`) fails 4 existing
`classifyRemoteRow` tests. It is a **false survivor** — the suite already kills it.

### Always hand-verify a survivor before acting on it

```bash
# 1. Apply the mutant's replacement to the source by hand, then:
pnpm vitest run <the test file(s) that exercise it>
# 2. If tests FAIL → false survivor (already covered); ignore it.
#    If tests PASS → a real gap; write a test, then revert the manual edit.
```

Until upstream is fixed (or we pin Vitest ≤4.0 for a dedicated mutation run), treat
output as a **lead to investigate**, never as a verdict. The infra is kept so it's
ready the moment the runner is reliable.

## How to run

```bash
pnpm mutation                                              # configured scope (sync modules)
pnpm mutation -- --mutate "packages/core/src/sync-data.ts" # one module
```

Report: `reports/mutation/index.html` and `reports/mutation/mutation.json` (both
gitignored).

- **No hard gate.** `stryker.config.mjs` sets `thresholds.break = null` — the run
  never fails CI (doubly appropriate while results are unreliable).
- **CI:** `.github/workflows/mutation.yml` runs weekly + on demand and uploads the
  report as an artifact. Advisory only.
- **Scope:** `mutate` targets the **sync engine** (`sync-data.ts`, `sync.ts`).
  `vitest.mutation.config.ts` narrows the per-mutant test run to those modules'
  direct tests. `ltm.ts` / `gradient.ts` are a later expansion (coverage spread
  across many files).

## Indicative first run — `sync-data.ts` (2026-06-20)

Recorded for reference only; **unreliable** per the caveat above (true score is
higher than shown). 274 mutants → 189 killed / 80 reported-survived / 5
no-coverage; 13m38s on a 4-core box. At least one reported survivor (`:624`) is a
confirmed false positive, and the `:378` `pruneOutbox` `minCursor <= 0` guard is an
**equivalent mutant** (`DELETE WHERE seq <= 0` deletes nothing regardless, since
`seq` starts at 1 — no test *can* distinguish it). Both illustrate why the raw list
must be hand-verified, not actioned directly.
