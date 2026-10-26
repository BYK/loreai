# Reading and recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make directory, sessions, knowledge, recovery, operations and entities easier to understand within existing PR #2110.

**Architecture:** Retain the current Solid routes/state and expose secondary information through native disclosures. Share the existing bounded diff rendering between version history and recovery; preserve all mutation and account guards.

**Tech Stack:** Solid 1.9, TypeScript, existing owned components, Vitest and Playwright; no new dependencies.

**Spec:** docs/superpowers/specs/2026-10-26-reading-and-recovery.md

## Global Constraints

- Keep desktop navigation mini-only; preserve labeled mobile drawer and existing context behavior.
- Use existing Solid, owned UI components, olive/amber theme, existing contracts and bounded diffText; no dependencies, backend/schema/contract changes, provider calls, or production-data mutations.
- Keep existing routes, URL values, permissions, owner/quarantine safeguards, mutation confirmations and API semantics.
- Use only recorded data. Missing values are unknown, never invented zeroes, timestamps, success or relationships.
- Maintain keyboard navigation, native links and disclosures, visible focus, 44px mobile controls, reduced motion and no horizontal overflow at 320px and 390px.
- Tests use isolated mocks or seeded disposable DBs; screenshot fixtures are fictional, run real frontend code, and use no DOM/CSS injection.
- Update PR #2110 only, keep it ready for review, do not merge. Refresh final screenshots and description, preserve relevant existing gallery evidence.

## Review Focus

- Long/unbroken names, paths and IDs must wrap; disclosure and link controls remain separate keyboard targets.
- Cached source metadata or absent original messages must not be presented as verified evidence.
- Title-only, identical, deleted, missing or oversized recovery text must preserve the right action and all original data.
- Background refresh, failed actions and forbidden/hosted modes must keep recovery controls and uncertainty visible.
- Entity incoming/outgoing links and null-project knowledge must navigate correctly under /ui without per-row detail fetches.

### Task 1: Compact directory and readable sessions/knowledge

**Files:** Modify packages/ui/src/components/lore/ProjectDirectory.tsx, SessionList.tsx, KnowledgeDocument.tsx; their existing unit tests and relevant UI E2E assertions. No shell/sidebar changes.

**Interfaces:** Keep ProjectDirectory, SessionList and KnowledgeDocument public props and all loader contracts unchanged. Task 2 consumes none of their markup; reuse existing href, source evidence and status helpers.

- [x] Write focused failing-first tests for compact directory rows preserving all grouping/filter/sort/sessions-mode hrefs; session title/recency with processing data inside a separate initially closed native disclosure; initially closed knowledge Source & history and truthful source summary across available/summary-only/missing/no-source/error states. Cover long/unbroken labels, no nested interactive elements, paging and low recorded confidence.
- [x] Run exact focused tests with pnpm --filter @loreai/ui exec vitest run --config vitest.config.ts test/project-directory.test.tsx test/session-list.test.tsx test/knowledge-document.test.tsx. Save RED command/output in report.
- [x] Implement the three surfaces described in spec points 1–3. Preserve every original secondary field and action behind the disclosure. Source summary must not add fetches; confidence is a recorded value rather than verified correctness. Use native A links and details/summary, with mobile target sizing and normal theme tokens.
- [x] Run focused tests GREEN and UI typecheck; update only browser assertions invalidated by the intentional disclosure/layout changes, never weaken actual behavior checks.
- [x] Self-review, commit coherent changes on codex/intentional-ui, write detailed report with exact commands, outputs, changed files and any concern. Do not push or edit PR.

### Task 2: Understandable recovery, operations and entity context

**Files:** Modify packages/ui/src/components/lore/ConflictsPage.tsx, VersionDiff.tsx, WarmingPage.tsx, CostsPage.tsx, ModelUsagePage.tsx, EntitiesPage.tsx, EntityPage.tsx, TeamPage.tsx, ProviderCards.tsx, ModelTidesUpload.tsx; create a small shared TextChanges.tsx renderer if needed; existing focused unit and E2E files. Do not change API/contracts/backend.

**Interfaces:** Reuse diffText(before: string, after: string): TextChange[] | null from lib/text-diff.ts. Shared TextChanges consumes changes: TextChange[] and renders escaped equal/ins/del text. ConflictsPage compares existing snapshot/current contracts directly; do not synthesize KnowledgeVersion data. Existing entity detail already has metadata, relations(direction/other_id/other_name/other_type) and knowledge(id/title/category/project_id); list has aliases/project_id. All API methods and public props remain unchanged.

- [x] Write failing-first focused tests for recovery bounded diff/title-only/no-text-change/full-text fallback/deleted-current and original action confirmations; operations concise status and initially closed technical disclosures with warnings/actions still reachable; entities recorded aliases/scope/context, linked incoming/outgoing relationships and project/null-project encoded knowledge URLs under /ui. Include error/hosted/refresh behavior, empty and long labels, and zero extra per-row detail requests. Correct the existing entity count plural (2 entities) while touching the list; do not change the global pluralize helper for unrelated nouns.
- [x] Run focused unit tests RED (discover the existing operation/recovery test filenames and record exact command/output).
- [x] Implement spec points 4–6 with native disclosures. Extract the existing text-change renderer from VersionDiff into a small shared component, preserving semantic styling/accessibility and diff budgets. Explain action outcomes without changing mutation behavior. Keep operations status and actionable warnings outside technical details. Use metadata description only when recorded/string; prioritize evidence links over edit forms, preserve editing/deletion guards, and navigate with href helpers/router base.
- [x] Address verified existing PR Seer thread PRRT_kwDORU1hfc6wMi4k: in no-team state, surface TeamParityActions organization/status errors outside the collapsed settings through the existing onStatusError callback. Keep the banner visible even at section=settings; do not offer a settings link that merely changes a URL without revealing its collapsed error. Preserve create/join and retry behavior, and cover the initially collapsed failure plus error clearing with a failing-first regression.
- [x] Run focused unit tests GREEN plus Task 1 tests and UI typecheck. Update affected production browser assertions and add meaningful cases for responsive disclosure/diff/relationship navigation rather than snapshot-only tests.
- [x] Self-review and commit on codex/intentional-ui; write report with RED/GREEN evidence, exact test results, changed files and concerns. Do not push or edit PR.

### Task 3: Final review, screenshots and PR refresh

**Files:** docs/ui-redesign/README.md and this plan; fictional preview API under private tmp only, no screenshot assets committed. Add missing meaningful browser coverage identified by final review.

**Interfaces:** Consume final Task 1/2 UI and unchanged existing APIs. PR is https://github.com/BYK/loreai/pull/2110 on codex/intentional-ui.

- [ ] Run the complete UI suite, workspace typecheck/lint/format, and production bundle. Run affected production desktop/mobile Playwright specs against isolated seeded DBs. Capture 320px/390px geometry, keyboard disclosures, source/recovery fallback states and mini-only navigation.
- [ ] Obtain a final whole-branch adversarial correctness review and separate scoped security review. Resolve confirmed findings with failing-first regression and scoped re-review; preserve prior exact validation limits for the unchanged backend.
- [ ] Capture actual fictional-data frontend screenshots covering all six changes in light/dark and relevant narrow layouts. Inspect every image; ensure no incidental tooltip, incorrect disclosure state, clipping or real data. Update README and PR description to describe final full behavior with current screenshots; clearly distinguish any retained prior comparison captures.
- [ ] Commit documentation/evidence links, push existing branch, upload screenshots, verify hosted head, ready state, gallery URLs and current CI/review findings. Do not merge. Preserve useful reports outside scratch and clean this plan workspace when complete.
