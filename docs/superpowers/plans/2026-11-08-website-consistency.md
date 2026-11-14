# Website Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address all eight approved visual-QA findings while preserving the floating navigation and RPG journal.
**Architecture:** Native Astro shared choice/command compositions and app surface tokens; focused responsive tour; enhanced reference index with native fallback and Starlight route middleware; contextual recovery hero.
**Tech Stack:** Astro, TypeScript, CSS, Playwright.
**Spec:** docs/superpowers/specs/2026-11-08-website-consistency.md

## Global Constraints

- Same draft PR #2115; preserve all existing commands, fragments, content facts and independent URL groups.
- No new runtime dependency; no-JS controls remain useful; native disclosures keep browser-owned state.
- Keep floating navigation and RPG journal; confirmation remains reader-controlled.
- Keep reference content/anchors, use generated-document sources when needed, preserve Starlight controllers.
- Do not merge; wider repository validation remains a separate gate.

## Review Focus

- Nested controls must retain URL binding boundaries and early native state.
- Finder literal input, blank/no results, query/history, long tokens, no-JS directory and prefix URLs.
- Focus visible at cropped images, native directory edges and sticky TOC/header; no duplicate search dialog.
- Client-grid wraps and command copy success/failure must not confirm connection.
- Reference TOC middleware must not affect other docs, all anchors still resolve.

### Task 1: Shared controls, setup and surfaces

**Files:** Create ChoiceGroup/ChoiceItem/CommandBlock Astro components and shared patterns CSS; migrate file/preview/fit/diagnostics/setup/tour selectors; simplify setup/panel styling.
**Interfaces:** Preserve native name/value/checked/aria-controls and existing class/controller hooks. Shared command slots preserve install/setup clipboard status hooks. Consumers keep native URL and checkbox state.
- [x] Write/observe failing browser checks for shared controls, stable client grid, command copy/confirmation independence and neutral non-journal surfaces.
- [x] Implement shared components, simplify nested frames, unify action hierarchy and readable labels.
- [x] Run focused behavior and existing selection/copy contracts; inspect browser appearance.

### Task 2: Tour and product story

**Files:** Modify tour page, ProductTour, KnowledgeInspector, product-tour metadata/styles, KnowledgeFile/ProductSpotlight, homepage/Why Lore copy and spacing.
**Interfaces:** view/inspect/format/preview/journal groups and original capture links remain independent. New responsive crop is read-only real-image presentation.
- [x] Write/observe failing mobile first-proof/readability check while keeping old URL/history tests.
- [x] Merge intros, compact view switcher, improve phone captures, simplify notes, reduce repeated story/fit text.
- [x] Verify actual views and all existing URL/no-JS contracts.

### Task 3: Docs navigation, finder and recovery

**Files:** Create ReferenceFinder Astro + TS enhancement, docs route middleware, recovery hero; modify DocsPageTitle, Astro config, Starlight styles and semantic labels.
**Interfaces:** Render native directory from route headings. Search uses setting query, literal text matching and replaceState; never hides reference prose. Reference-only TOC shortening retains root anchors. Recovery opens existing Search.
- [x] Write/observe failing finder/history/no-JS, semantic title, reference-only TOC and404 recovery checks.
- [x] Implement progressive finder, reference-only route data, compact TOC/header labels and recovery actions.
- [x] Run full website/browser/Astro/unit and root type/lint/format/doc parity/social; prefix and fragment checks.
- [x] Obtain separate correctness/security reviews; fix defects with RED/GREEN regressions; capture actual light/dark/phone evidence.
- [x] Commit/push/update same draftPR with gh, verify remote head and report CI separately. Do not merge.
