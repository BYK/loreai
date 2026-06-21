# Review Heuristics — Lore

This document codifies the review bar for pull requests. It exists because
adversarial review has repeatedly caught correctness bugs that a green test
suite missed — skip/early-return branches, lifecycle sequences, and fan-out
registry gaps. Institutionalizing these patterns so they compound.

The review workflow (§3) is referenced from AGENTS.md.

---

## 1. Regression-test discipline

Every adversarial-review finding that surfaces a defect **must** land a
deterministic regression test in the same PR. The test:
- fails on the base branch (proving it reproduces the bug),
- passes on the fix (proving the fix works),
- drives the *real* precondition, not an artificially-constructed state (e.g.
  the #828 prune-floor tests actually push two tables and assert the stale
  upsert survived — they don't just `INSERT` a pretend outbox row).

Tests that "test the guard" must fail when the guard is deleted. If a test
still passes with the guard removed, it isn't testing the guard.

## 2. Adversarial-order state setup

Set up preconditions in the order the adversary would produce them, not the
order the code expects. Specifically:

- **State already present before the operation** that should handle it (e.g. a
  stale outbox entry exists *before* `reconcile` runs — not seeded inside the
  reconciliation window).
- **Delete-then-recreate** sequences across lifecycle boundaries (e.g. a row
  deleted while sync is OFF, recreated while still OFF, then re-enabled).
- **Modify-while-off** (content change made while sync is disabled, so capture
  triggers can't see it).

## 3. Fan-out registry coverage

Any addition to a fan-out registry must be covered by the corresponding
parametrized contract battery:

| Registry | Battery | Location |
|---|---|---|
| `SYNCED_TABLES` (tables, sync columns, id columns, versioned flag, pullOnly) | `sync-registry-contract.test.ts` | Assert every registered table's shape, pull-only/no-capture invariant, composite-pk correctness |
| `MIGRATIONS` array | `db.test.ts` schema-version assertion + any migration-specific test | One `toBe(MIGRATIONS.length)` assertion; add per-migration tests for new behavior |
| `AGENTS` registry | `agents.test.ts` | Every agent has `name`/`displayName`/`binary`/`detect()`; `binary` is a constant placeholder string |

## 4. Recurring bug classes → standing test batteries

Bug patterns that recur across PRs graduate into parametrized, property-based
batteries so every new PR is checked against the known failure modes:

| Battery | Covers | File |
|---|---|---|
| Registry contract | SYNCED_TABLES shape, pull-only guard, id-column correctness, versioned flag | `packages/core/test/sync-registry-contract.test.ts` |
| Sync invariants (per-op) | No pull-only outbox, profiles ≤ 1, every state row references a registered table | `packages/core/src/sync-data.ts` (`assertSyncInvariants`) |
| Sequence properties | Standing invariants after every op, prune-floor never wedges, eventual convergence, no ping-pong, currentTier correctness | `packages/gateway/test/sync.property.test.ts` |

## 5. Session-discovered patterns (June 2026)

Patterns from the stale-upsert family (#856, #861, #866, #868) and the PRAGMA
N+1 fixes (#874, #878):

- **Skip/early-return branches are the highest-risk surface.** `NOT EXISTS`,
  `latest <> 'upsert'`, and content-match guards all masked real data-loss
  bugs. Every skip branch needs a test that makes the branch fire *wrongly*
  (skip something it shouldn't) and proves it doesn't.
- **Property-based tests over faithful mocks catch what example tests miss.**
  The #833 property battery surfaced four real engine bugs that example tests
  had missed for the entire sync epic — all were sequence-dependent across
  `enable/disable/push/pull` boundaries.
- **TDD failing-first.** Every bug fix this session was driven by a regression
  test that was written first, confirmed to fail on the base branch, then
  confirmed to pass on the fix. Never trust the fix without seeing it fail.
- **Frozen shared arrays are a defensive win.** When memoizing a result that
  multiple callers share (e.g. the `syncedColumns` PRAGMA cache), freeze it so
  an accidental mutation fails loudly (`TypeError` in strict mode) rather than
  silently corrupting the cache.
- **`db().query` monkeypatches are shadowed by the tracing Proxy.** When
  counting SQL statements in tests, use the `log.registerSink({ withDbSpan })`
  seam — a naive `db().query = ...` patch is silently ignored by the Proxy
  wrapping (verified empirically in #874).

## 6. Review workflow

For non-trivial changes, use **two separate** review passes so verdicts aren't
conflated:

1. **Adversarial / correctness review:** "What state makes this break?" —
   enumerated cases, apply-then-revert mutants, property-test stability (×10),
   hash equivalence proofs, frozen-array mutation safety, stale-cache analysis.
2. **Security / pentest review:** injection vectors, credential leaks,
   protocol-level attacks, privilege escalation.

These are separate subagent invocations with distinct prompts. The adversarial
review is mandatory before merge; the security review per risk profile.

Reviewers must:
- Run `pnpm test` (full suite), `pnpm run typecheck`, and `pnpm run lint`
  (check the exit code — a blank tail can hide a format error).
- Verify property-test stability (×10 runs).
- Confirm the working tree is unmodified at the end (hash-verified).
- Report a per-point verdict (PASS / FAIL / CONCERN / MUST-FIX) with `file:line`
  evidence. Overall MERGE / DO-NOT-MERGE. No "LGTM" without structure.

PRs that touch correctness-critical paths (sync engine, hashing, lifecycle,
migrations) require adversarial review regardless of size. Mechanical or
test-only PRs may skip it at reviewer discretion.