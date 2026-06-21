---
title: Code review
description: Review heuristics and workflow for Lore contributors — regression-test discipline, adversarial-order state setup, and recurring bug-class batteries.
sidebar:
  order: 6
---

This page documents the review bar for pull requests. It exists because
adversarial review has repeatedly caught bugs that a green test suite missed.
Institutionalizing these patterns so they compound across PRs.

See [`quality/REVIEW.md`](https://github.com/BYK/loreai/blob/main/quality/REVIEW.md)
in the repo for the full reference.

---

## Regression-test discipline

Every review finding that surfaces a defect **must** land a deterministic
regression test in the same PR. The test:

- fails on the base branch (proving it reproduces the bug),
- passes on the fix (proving the fix works),
- drives the *real* precondition, not an artificially-constructed state.

A test that "tests the guard" must fail when the guard is deleted. If a test
still passes with the guard removed, it isn't testing the guard.

## Adversarial-order state setup

Set up preconditions the way the adversary would produce them, not the order
the code expects:

- **State already present before the operation** that should handle it.
- **Delete-then-recreate** sequences across lifecycle boundaries (e.g. a row
  deleted while sync is OFF, recreated while still OFF, then re-enabled).
- **Modify-while-off** (content change made while sync is disabled, so capture
  triggers can't see it).

## Fan-out registry coverage

Any addition to a fan-out registry must be covered by the corresponding
parametrized contract battery:

| Registry | Battery |
|---|---|
| `SYNCED_TABLES` | `sync-registry-contract.test.ts` |
| `MIGRATIONS` array | `db.test.ts` schema-version assertion |
| `AGENTS` registry | `agents.test.ts` |

## Recurring bug classes → standing batteries

Bug patterns that recur across PRs graduate into property-based batteries so
every new PR is checked against the known failure modes. The sync engine
property battery (`packages/gateway/test/sync.property.test.ts`) found four
real engine bugs that example tests had missed — all sequence-dependent across
`enable/disable/push/pull` boundaries.

## Review workflow

**Two separate passes** so verdicts aren't conflated:

1. **Adversarial / correctness** — enumerated edge cases, apply-then-revert
   mutants, property-test stability, hash equivalence proofs, stale-cache
   analysis. Mandatory for non-trivial PRs.
2. **Security / pentest** — injection vectors, credential leaks, protocol-level
   attacks. Per risk profile.

Reviewers must run `pnpm test`, `pnpm run typecheck`, and `pnpm run lint`
(verify the exit code). Report a per-point verdict (PASS / FAIL / CONCERN /
MUST-FIX) with `file:line` evidence. No "LGTM" without structure.
