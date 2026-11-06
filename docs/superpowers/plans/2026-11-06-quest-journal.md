# Quest journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the camp with the approved illustrated quest journal and carry its design across the website in PR #2115.

**Architecture:** Static Astro components render the complete journal with native radios, details and CSS. A small state controller enhances navigation and history without HTML interpolation. Shared local art and CSS connect public pages, the actual-app tour, client setup and Starlight docs.

**Tech Stack:** Existing Astro/Starlight, TypeScript, CSS, Playwright; local Quiver SVGs.

**Spec:** `docs/superpowers/specs/2026-11-06-quest-journal-design.md`

## Global Constraints

- Use existing Astro/Starlight and DM Sans; preserve the compact Light/System/Dark icon pill.
- Native/no-JS choices, reduced motion, 320px layouts, familiar navigation labels.
- Static local SVGs only; remove the 3D renderer and Three.js dependency.
- Preserve actual app screenshots, setup commands, generated docs, signup behavior and existing public fragments.
- Same branch and PR; no merge or ready-for-review mutation.

## Review Focus

- An early native selection before JS loads must survive absent/invalid URL state.
- Returning through history must restore chapter, inspected card and task together.
- Changing the task or inspected card must never inject URL text or show a mismatched source.
- Hiding a focused action must transfer focus to the selected chapter; native radio focus remains stable.
- No-JS, reduced-motion, narrow layouts and prefixed deployments must retain useful content and working assets.

### Task 1: Native journal, state and approved artwork

**Files:** Create `src/components/QuestJournal.astro`, `src/components/JournalArt.astro`, `src/lib/quest-journal.ts`, `src/scripts/quest-journal.ts`, `public/journal.css`, `public/journal-art/*` under `packages/website/`. Replace the homepage camp and remove the old camp files/tests/dependencies.

**Interfaces:** Static `JOURNAL_CHAPTERS`, `JOURNAL_ENTRIES`, `JournalState` and `readJournalState(params, fallback)` define allowed values and content. Journal radio groups are marked `data-journal-choice="chapter|entry|task"`. No dynamic string becomes markup or a selector.

- [x] Add browser regressions for source inspection, task relevance, URL/reload/history, malformed query, early native state, keyboard and no-JS chapters/cards/tasks. Run focused tests against current code and observe missing-journal failures.
- [x] Implement static data, safe state parsing, native Astro markup/CSS and atomic history enhancement. Import four SVGs and provenance from the approved standalone preview.
- [x] Replace camp, delete its obsolete renderer/tests, remove `three` and `@types/three`, update affected journey tests.
- [x] Run new browser cases and website unit suite; resolve failures before moving on.

### Task 2: Carry the design across website surfaces

**Files:** Shared public styles/layout, `ProductTour.astro`, `AgentSetup.astro`, Starlight PageTitle override, footer/header treatments, blog list/article, Why Lore and homepage sections.

**Interfaces:** `JournalArt` accepts a static named illustration and dimensions, prefixes local asset paths, and is decorative. Shared `journal.css` supplies tokens/frames/selection treatment to public and docs styles.

- [x] Add cross-surface regression checking local decoded illustrations, overflow and preserved task navigation; run red before adding the shared treatments.
- [x] Implement tour chapter navigation, setup frame/step markers, docs title/sidebar/pagination, blog masthead/takeaway, Why Lore/workflow/footer details. Keep existing semantics and URLs.
- [x] Run all website units/browser projects, Astro, workspace typecheck/lint/format, docs parity and builds; inspect desktop/phone in light/dark.

### Task 3: Delivery and review

**Files:** `packages/website/README.md`, `docs/website-ui/README.md`, screenshots and this ledger; PR description.

- [x] Refresh visual evidence for journal, tour, setup/docs, blog and Why Lore; document local art provenance and behavior.
- [x] Verify prefixed build/assets/state, metadata and internal links; repeat state scenarios ten times.
- [ ] Obtain separate adversarial correctness and security reviews; run required broad checks and report baseline/platform limits distinctly.
- [ ] Fix findings with red/green regressions, commit and push to existing PR, refresh its description, verify hosted checks and mergeability.

## Ledger

Ruling: the approved interactive preview and explicit request to apply it authorize implementation; no additional design-approval stop is needed. Execute inline, with final separate reviews required by `quality/REVIEW.md`.

Pre-flight: journal assets and tokens are shared with Task 2; Task 1 defines their static component/data contract. Existing setup/tour URL helpers remain independent; only the journal owns its three new query parameters.
