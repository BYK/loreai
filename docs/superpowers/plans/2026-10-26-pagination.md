# Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered pagination links with consistent text/icon controls in existing PR #2110.

**Architecture:** One presentational PaginationControls component consumes existing callbacks and disabled states. Callers retain every navigation/history decision. Existing Button/Icon/Tooltip primitives supply semantics and theme behavior.

**Tech Stack:** Solid, TypeScript, Kobalte, Tailwind, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-10-26-pagination-design.md

## Global Constraints

- Main views use First, Previous and Next text with direction icons and full accessible page labels. The reader session sidebar uses icon-only controls with accessible labels and hover/focus tooltips.
- Preserve all cursor/history, filtering, sort, URL base, selected transcript and source-anchor behavior. Expose only existing actions; no page numbers or invented totals.
- Use 44px mobile targets, visible keyboard focus and real disabled buttons. Reuse existing primitives; no API/backend/dependency changes or sidebar expansion.
- Keep append-style Load more actions unchanged. Add screenshots to PR #2110, keep ready for review and do not merge.

## Review Focus

- Direct cursor links without history must not acquire a fictitious Previous action.
- Paging preserves encoded filters, sort, project/UI base and reader anchors.
- Terminal/empty pages keep Next disabled and callbacks guarded.
- Compact controls support keyboard activation and accessible labels/tooltips without nested buttons.
- All supported controls fit at 320px with 44px mobile hit targets.

### Task 1: Shared controls and caller integration

**Files:** Create packages/ui/src/components/lore/PaginationControls.tsx; modify KnowledgeTable.tsx, SessionList.tsx, SessionContextList.tsx, EntitiesPage.tsx, ImportHistoryPage.tsx and shell/Icon.tsx. Extend existing pagination/caller tests and add focused production browser coverage.

**Interfaces:** PaginationControls props: label:string; onFirst?:()=>void; onPrevious?:()=>void; onNext:()=>void; previousDisabled?:boolean; nextDisabled:boolean; compact?:boolean; class?:string. No cursor ownership in the component.

- [ ] Add integration regressions for named navigation landmarks, main text/icons and compact accessible controls while retaining existing URL/filter/anchor assertions. Run focused tests RED before source changes.
- [ ] Implement the shared component and migrate all five callers using their unchanged callbacks/history logic. Use ghost buttons, right-aligned grouping and a first-page double-chevron icon.
- [ ] Run focused and complete UI suites GREEN, workspace typecheck/lint/format and production build. Add/run desktop/mobile browser paging, terminal state, keyboard, tooltip and 320px geometry cases; update existing caller assertions only for intended accessible names.
- [ ] Commit source/tests. Obtain independent adversarial correctness and security reviews of the increment since ed2d66ea; retain prior full-PR review and green hosted checks as context. Resolve confirmed defects and verify fixes.

### Task 2: Screenshots and publication

**Files:** docs/ui-redesign/README.md and this plan; screenshot artifacts outside tracked source.

**Interfaces:** Consume Task1 final UI and existing fictional preview API. Preserve all46existing remote screenshot URLs in the PR description.

- [ ] Capture and inspect matched real-frontend before/after screenshots of main pagination and narrow sidebar, including mobile. No DOM/CSS/image editing or real user data.
- [ ] Update docs/PR with new screenshots and exact validation results; push the same branch, verify hosted head/ready state/review threads/current checks. Do not merge.
