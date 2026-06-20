# Mutation testing (Stryker) — issue #832

Mutation testing measures whether the test suite **constrains behavior**, not just
whether it passes. Stryker makes small edits ("mutants") to source — flip `<=` to
`<`, replace a return value, delete a guard — and re-runs the tests. A mutant the
tests **kill** is behavior they pin; a mutant that **survives** is a line no test
constrains: a named gap. This is the tool that directly answers "are our tests
adequate?" for the stateful modules where review — not tests — caught the recent
sync bugs (#828) and lifecycle edge cases (#816).

## How to run

```bash
# Whole configured scope (sync modules) — slow, ~25 min:
pnpm mutation

# One module (faster):
pnpm mutation -- --mutate "packages/core/src/sync-data.ts"
```

Report: `reports/mutation/index.html` (browse) and `reports/mutation/mutation.json`
(machine-readable). Both are gitignored.

- **No hard gate.** `stryker.config.mjs` sets `thresholds.break = null` — the run
  never fails CI. We record a baseline and ratchet over time.
- **CI:** `.github/workflows/mutation.yml` runs it weekly + on demand
  (`workflow_dispatch`) and uploads the report as an artifact.
- **Scope:** `stryker.config.mjs` `mutate` targets the **sync engine**
  (`sync-data.ts`, `sync.ts`) — where the #828 bugs lived and the test set is
  clean and bounded. `vitest.mutation.config.ts` narrows the per-mutant test run
  to those modules' direct tests (the full 3.5k-test suite per mutant is not
  tractable). **Follow-up:** `ltm.ts` / `gradient.ts` are in the allowlist comment
  but need a broader `include` (their coverage is spread across many test files).

## Baseline — `sync-data.ts` (2026-06-20)

| Metric | Value |
|---|---|
| Mutation score | **68.98%** (70.26% of covered) |
| Mutants | 274 total |
| Killed | 189 |
| Survived | 80 |
| No coverage | 5 |
| Runtime | 13m38s (4-core, concurrency 2) |

Of the 80 survivors, **52 are low-value** string/array/object-literal mutations in
the `SYNCED_TABLES` registry and SQL fragments (mostly equivalent mutants — e.g.
renaming a `syncColumns` entry that no test byte-asserts). **28 are logic-mutator
survivors — the real gaps.**

### Top surviving-mutant gaps → follow-up test tasks

1. **`sync-data.ts:378` — `pruneOutbox`: `if (minCursor <= 0) return 0;`**
   `<= 0`→`< 0` and conditional-removal both **survive**. The prune-floor boundary
   at exactly 0 — the precise mechanism the #828 wedge bug abused — is not pinned.
   *Add: a test that `pruneOutbox(0)` is a no-op AND `pruneOutbox(n>0)` reclaims.*
2. **`sync-data.ts:296` — `contentHash` null coalesce: `v === null || v === undefined`**
   `||`→`&&` survives. Null vs undefined column handling in the content hash is
   unpinned (hash-divergence risk). *Add: contentHash equality across null vs
   undefined vs `"\x00"` sentinel.*
3. **`sync-data.ts:624` — `classifyRemoteRow`: `remoteHash !== null && localHash === remoteHash` → `"skip"`**
   Conditional mutants survive — the identical-content pull "skip" optimization is
   not pinned. *Add: a re-pull of an unchanged row classifies `skip`.*
4. **`sync-data.ts:422` — `rowIdOf`: `m.idColumns.length === 1`**
   `=== 1`→`!== 1` survives — the single-id vs composite-id row-id construction is
   not distinguished at the boundary. *Add: rowIdOf for a 1-col and a 2-col PK.*
5. **`sync-data.ts:243` — `syncedTableMeta`: `if (!m) throw`** unknown-table guard
   not asserted. **`:567`** `nonPk.length > 0` boundary unpinned. (+ ~22 more in
   the JSON report.)

These are honest gaps, not failures — the suite is strong on the paths it covers
(189 killed). The value is the *named list* of unconstrained lines to harden next,
prioritised by the logic-mutator survivors above.
