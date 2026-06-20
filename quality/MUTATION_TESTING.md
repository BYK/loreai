# Mutation testing (Stryker) — issue #832

Mutation testing measures whether the test suite **constrains behavior**, not just
whether it passes. Stryker makes small edits ("mutants") to source — flip `<=` to
`<`, replace a return value, delete a guard — and re-runs the tests. A mutant the
tests **kill** is behavior they pin; a mutant that **survives** is a line no test
constrains: a named gap (sometimes an *equivalent* mutant — see below). It's the
tool that directly answers "are our tests adequate?" for the stateful modules
where review — not tests — caught the recent sync bugs (#828) and lifecycle edge
cases (#816).

## How to run

```bash
pnpm mutation                                              # configured scope (sync modules)
pnpm mutation -- --mutate "packages/core/src/sync-data.ts" # one module
```

Report: `reports/mutation/index.html` (browse) and `reports/mutation/mutation.json`
(machine-readable). Both gitignored.

- **No hard gate.** `stryker.config.mjs` sets `thresholds.break = null` — the run
  never fails CI. We record a baseline and ratchet over time.
- **CI:** `.github/workflows/mutation.yml` runs weekly + on demand and uploads the
  report as an artifact.
- **Scope:** `mutate` targets the **sync engine** (`sync-data.ts`, `sync.ts`).
  `vitest.mutation.config.ts` narrows the per-mutant run to those modules' direct
  tests. `ltm.ts` / `gradient.ts` are a later expansion (coverage spread across
  many test files).

## ⚠️ Triage a survivor by hand-applying the EXACT mutant

Before writing a test for any survivor, **copy the mutant's exact replacement from
the report**, apply it to the source, and run the relevant test file:

```bash
# tests FAIL  -> real, killable gap: write a test, then revert.
# tests PASS  -> equivalent mutant or an uncovered edge no current input hits.
pnpm vitest run <the test file(s) that exercise it>
```

**Footgun (learned the hard way):** Stryker's `ConditionalExpression` mutator
splits a compound `if (A && B)` — it emits separate mutants for `A → true`,
`B → true`, and the whole condition — and reports them at the **same column** with
the **same replacement string** (`"true"`). They are visually indistinguishable in
the report. Apply the *precise* replacement, not your assumption: e.g. for
`if (remoteHash !== null && localHash === remoteHash)`, the survivor is
`if (true && localHash === remoteHash)` (the `remoteHash !== null` operand), **not**
`if (true)`. The whole-condition mutant is killed; the operand one survives because
no test passes `remoteHash = null`.

## Baseline — `sync-data.ts` (2026-06-20)

| Metric | Value |
|---|---|
| Mutation score | **68.98%** (70.26% of covered) |
| Mutants | 274 total |
| Killed | 189 |
| Survived | 80 |
| No coverage | 5 |
| Runtime | 13m38s (4-core, concurrency 2) |

Of the 80 survivors, **~52 are low-value** string/array/object-literal mutations in
the `SYNCED_TABLES` registry and SQL fragments (mostly equivalent mutants). **28
are logic-mutator survivors** — a mix of genuine gaps and equivalent mutants, all
hand-verified individually:

### Genuine gaps → follow-up test tasks
1. **`sync-data.ts:624` — `classifyRemoteRow`: `remoteHash !== null` operand.**
   `remoteHash !== null → true` survives because no test passes a `null` remote
   hash (tombstone). *Add: classify with `remoteHash = null` on a present vs absent
   local row.*
2. **`sync-data.ts:296` — `serializeValue`: `v === null || v === undefined`.**
   `||→&&` survives — null/undefined column serialization in the content hash is
   unpinned. *Add: contentHash distinguishes a null column from the literal string
   `"null"`, and treats null vs undefined identically.*
3. **`sync-data.ts:243` — `meta()`: `if (!m) throw`** unknown-table guard not
   asserted. **`:270`** `pickSyncColumns` absent-column skip. **`:422`** `rowIdExpr`
   single-vs-composite branch. (+ more in the JSON report.)

### Equivalent mutants (cannot be killed — no behavioral difference)
- **`sync-data.ts:378` — `pruneOutbox`: `if (minCursor <= 0) return 0;`.** Both
  `<= 0 → < 0` and conditional-removal are equivalent: `DELETE … WHERE seq <= 0`
  deletes nothing regardless (AUTOINCREMENT `seq` starts at 1). No test can
  distinguish it.

These are honest gaps, not failures — the suite is strong on the paths it covers
(189 killed). The value is the *named, hand-verified* list of unconstrained lines
to harden next.
