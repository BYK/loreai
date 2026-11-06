# Field Guide Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement the ten approved field-guide improvements across the website in PR2115.

**Architecture:** Native radio disclosures and static Astro components share existing artwork, palette and allowlisted URL-choice enhancement. Existing app screenshots remain truthful product proof, with separate illustrative inspection details.

**Tech Stack:** Astro, TypeScript, CSS, Playwright; existing dependencies only.

**Spec:** `docs/superpowers/specs/2026-11-06-field-guide-pages.md`

## Global Constraints

- Preserve the floating header, journal state/history, real app proof, setup command contracts, legacy fragments, light/dark art and BASE_URL.
- No new dependencies, backend, fabricated connection detection, competitive claims, or merge.
- Native fallbacks and readable keyboard/reduced-motion paths are required.

## Review Focus

- New query parameters must coexist with chapter/agent/view, unrelated queries and fragments.
- A confirmation for one agent must not imply success for another agent.
- Inspector sample details must not imply always-available exact-message attribution or automatic knowledge extraction.
- Converted MDX must preserve route IDs, search indexing and every legacy heading target.
- Phone controls/details must stay contained while longer text grows naturally.

### Task 1: Product explanation and homepage

**Files:** Create KnowledgeFile.astro and KnowledgeInspector.astro in website components; add page-field-guide.css. Modify homepage/ProductTour/QuestJournal and scoped shared styles. Add field-guide-pages.spec.ts browser contracts.

**Interfaces:** Consume bindUrlChoice(selector, parameter, choices), JournalArt, existing tour/journal state. Produce `.knowledge-file` with `format` and `.tour-inspector` with `inspect` choices; keep `.hero-proof` and original screenshot links.

- [x] Add tests for native readable/Markdown choice, malformed format fallback, independent history, inspector rule/source/history, preserved screenshots and journal highlighted continuity.
- [x] Run focused tests on4298d9e5 and confirm absent controls fail.
- [x] Implement components, shorter homepage task links and journal continuity/optional pointer transition.
- [x] Run focused contracts; preserve existing journal/tour/browser regressions.

### Task 2: Setup, docs navigation and diagnostic paths

**Files:** Modify AgentSetup.astro, add DocsTasks.astro and TroubleshootingGuide.astro, convert docs index/troubleshooting to MDX while keeping routes/headers, add FAQ links and browser tests.

**Interfaces:** Consume original SETUP_AGENTS and bindUrlChoice. Produce per-agent native confirmation, real docs links, and `issue=session|knowledge|gateway` diagnostic guide.

- [x] Add failing tests for per-agent confirmation isolation, task directory URLs, diagnostic selection and noJS paths.
- [x] Implement compact selector, reader confirmation and docs/diagnostic components with existing headings retained.
- [x] Run setup/doc tests; verify all legacy anchors and query/history state.

### Task 3: Comparison, editorial styling and delivery

**Files:** Add FitGuide.astro; modify different.astro, blog index/article templates and blog/shared CSS. Refresh README/gallery and PR.

**Interfaces:** Consume existing comparison rows and article nextStep metadata. Produce `fit` choices that highlight existing rows; preserve entire table and article-specific links.

- [x] Add failing tests for fit selection/table highlighting and illustrated editorial next steps.
- [x] Implement selector, featured article composition and topic diagram, and finish consistent shared surface/control styling.
- [x] Run full website browser/unit/Astro and root type/lint/format, doc parity, social/fragment/prefix checks. Expected website checks green; record any unrelated broader failure honestly.
- [x] Perform visual QA across light/dark, phone/desktop/docs; capture actual website screenshots.
- [x] Obtain independent correctness/security reviews; reproduce and fix actionable findings with regressions.
- [x] Commit and push to existing draftPR2115; refresh description/screenshots with gh and verify remote head. Leave unmerged.
