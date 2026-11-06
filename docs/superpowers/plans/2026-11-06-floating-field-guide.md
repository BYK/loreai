# Floating Field Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved floating field-guide header across the website in PR #2115.

**Architecture:** Shared static navigation descriptors feed native desktop disclosures and grouped mobile links. Public and Starlight headers share the presentation and existing theme/menu enhancements.

**Tech Stack:** Astro, TypeScript, CSS, native details, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-floating-field-guide.md`

## Global Constraints

- No new dependencies. Keep the quest journal and page content intact.
- All internal paths respect BASE_URL. Ordinary links and native disclosures work without JavaScript.
- Keep the existing theme behavior and selected-ring contrast. Preserve docs search and mobile sidebar.
- Use the same existing PR; leave it unmerged.

## Review Focus

- Opening Product then Resources quickly must leave Resources open.
- Docs links nested inside Product must not create multiple current-section anchors.
- Short phone screens must scroll the menu without hiding Get started.
- Intermediate docs widths and coarse-pointer theme buttons must not overlap search.
- Prefixed preview links and featured artwork must resolve beneath BASE_URL.

### Task 1: Shared floating navigation

**Files:** Create `src/lib/site-navigation.ts`, `src/components/FieldGuideNav.astro`, `public/navigation.css` under `packages/website/`. Modify shared header, logo, primary links, mobile menu, controls/theme/Starlight CSS, and browser header/current-section tests. Refresh website documentation and screenshots.

**Interfaces:** Consumes existing BASE_URL, palette roles, JournalArt, ThemeToggle, and `details[data-menu]` dismissal. Produces `navigationGroups(base: string)` with stable static links and FieldGuideNav rendering; PrimaryLinks renders the mobile equivalent.

- [ ] Write browser tests for Product/Resources native disclosure, mutual exclusion, Escape/outside dismissal, real destination URLs, unique current links, and no-JavaScript desktop/mobile navigation.
- [ ] Run the focused header test against existing code and confirm it fails because Product is absent.
- [ ] Implement shared descriptors, desktop and mobile rendering, floating styles, docs search layout, and a pointer-only entrance if appropriate.
- [ ] Run focused tests, then the complete website browser suite, Astro/unit/type/lint/format checks, and prefixed build/link verification. Expected: no website regressions; record unrelated failures separately.
- [ ] Capture actual website light/dark desktop, dropdown, docs, and phone screenshots. Inspect visual hierarchy, containment, and menu scrolling.
- [ ] Obtain independent correctness and security reviews per quality/REVIEW.md; address findings with reproducing tests.
- [ ] Commit, push the existing PR branch, update its description with current evidence, and verify remote head and status with gh.
