# Website story and visual QA implementation plan

> Use superpowers:executing-plans inline. Approved scope is recorded in the spec; no additional approval stop.

**Goal:** Deliver all approved visual-QA improvements plus light-mode artwork and more purposeful Quiver SVGs in PR #2115.
**Architecture:** Native Astro/CSS journal and setup, static typed example data, local theme-specific SVG assets, actual-app captures with synthetic fixture responses. Existing small state helpers retain URL/native enhancement behavior.
**Spec:** docs/superpowers/specs/2026-11-06-website-story-design.md

## Constraints and review focus

Preserve client commands, query/hash/history behavior, keyboard focus, reduced motion, no-JS usefulness, 320px layouts, prefixed URLs, accurate provenance, factual data/cost/availability distinctions. SVGs remain local and inert. No React/shadcn runtime or new dependency. Same draft PR, no merge.

### Task 1: Readable causal journal and theme-specific artwork

Files: QuestJournal.astro, JournalArt.astro, quest-journal data/controller, journal.css, public/journal-art/*; browser/unit regressions.
- [x] Write and observe RED for Conversation default, readable inventory/contrast, optional inventory and correct light artwork; retain URL/native regressions.
- [x] Add Quiver artwork and geometry-preserving light palettes; implement compact causal journal, optional native inventory, file excerpt and task reasons; fix typography/contrast.
- [x] Run journal units and focused browser cases; preserve delayed-native and checked-card regressions.

### Task 2: Product evidence and one setup sequence

Files: index.astro, AgentSetup.astro, install/first-session docs, capture-product-tour.mjs, product-tour assets, theme.css; journey regressions.
- [x] Observe RED for proof-before-journal and honest verification navigation.
- [x] Put a readable knowledge-file artifact near headline, real app before journal; align synthetic source/session/version history and capture supported app views.
- [x] Remove duplicate numbered setup flow; show verification result and an actual Sessions detail, retain reference anchors and six client paths.
- [x] Run setup/unit/browser checks and capture checks.

### Task 3: Purposeful cross-site layouts

Files: Why Lore, blog index/article, docs PageTitle, memory/data docs, shared static diagram components, theme/blog/Starlight styles.
- [x] Add responsive comparison and article/diagram checks; observe missing behavior/layout failure.
- [x] Lead Why Lore with fit, show comparisons stacked on phones; use memory flow/definitions and data boundaries; purpose-map docs art and compact titles.
- [x] Feature a practical blog starting article, quiet metadata, contextual availability; retain genuine reading navigation.
- [x] Run all website browser projects, units, Astro, typecheck/lint/format, docs parity, social metadata, links and prefixed deployment checks.

### Task 4: Review and same-PR delivery

Files: evidence READMEs, screenshots, plan ledger, PR description.
- [x] Refresh direct desktop/phone/light/dark captures and document every QA item.
- [x] Obtain separate correctness/security reviews; reproduce findings before fixes; distinguish local broad-suite limits from hosted checks.
- [x] Commit coherent final changes, push same branch and update PR using gh. Verify exact head/mergeability/check status; leave draft and unmerged.

Execution ruling: the user explicitly approved all audit recommendations and additional art. Use the existing suitable worktree. Asset variants feed all tasks, so define the static art map and theme selection before cross-site styling. Commit the coherent final change once the integrated checks pass.
