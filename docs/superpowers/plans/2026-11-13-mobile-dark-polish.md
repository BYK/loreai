# Mobile and Dark-mode Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan.

**Goal:** Resolve all seven approved QA findings in PR #2115.
**Architecture:** Existing native Astro controls, shared CSS and static screenshot crops. Literal reference filtering remains an enhancement over complete prose.
**Tech Stack:** Astro, TypeScript, CSS, Sharp, Playwright.
**Spec:** docs/superpowers/specs/2026-11-13-mobile-dark-polish-design.md

## Global Constraints
Keep floating navigation and RPG journal. Preserve native/no-JS behavior, URL/history state, source/provider qualifications, legacy anchors and original captures. No new dependencies.

## Review Focus
- Long identifiers and hostile description markup remain escaped text.
- Search reset/popstate/show-all returns consistent visible results without changing reference prose.
- Legacy setup links still land on visible content; copying never confirms setup.
- Phone touch and no-JS choices retain coherent theme-specific evidence.
- Crops and prefixed links resolve without changing original screenshots.

### Task 1: Apply the approved visual QA repairs
**Files:** ProductSpotlight, ProductTour, AgentSetup, QuestJournal, ReferenceFinder, reference-directory, reference-finder, site-navigation, PrimaryLinks, install.mdx; shared CSS; screenshot crop script/assets; search-index integration; browser/unit tests.
**Interfaces:** Existing radio names/values, query keys, copy hooks and anchor IDs remain. ReferenceEntry gains a plain-text description. Finder initially shows six matches and offers all matches explicitly.
- [x] Write failing tests for single-line desktop proof tabs, complete mobile crops, compact copy rows, contextual search results/show-all and preserved legacy anchors.
- [x] Run targeted browser/unit tests; confirm failures reproduce the reported problems.
- [x] Implement the seven repairs, including literal description extraction, non-destructive search indexing and deliberate dark surface roles.
- [x] Run website units and full browser suite, Astro checks, docs parity, root type/lint/format; verify preview-prefix links serially.
- [x] Visually inspect phone light/dark and desktop states, save evidence, obtain separate correctness/security reviews.
- [x] Commit, push to the same PR branch, verify hosted checks and preserve draft status.
