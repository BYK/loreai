# Journal visual polish implementation plan

> Execute inline with the existing Astro/CSS stack. The user's follow-up authorizes improving the approved journal direction and generating more matching Quiver artwork.

Goal: Give the quest journal more visual character and stronger interaction cues while keeping the local app palette and existing behavior.

Design: Extend the approved illustrated journal, rather than introduce another scene or a new design direction. Use one cohesive open-journal expedition SVG in the hero; strengthen the distinction between page, spine and inventory; increase artwork scale; add a reading-progress motif and pointer-only card/choice feedback. Keep ordinary documentation readable, with the same accents across docs, setup, tour and editorial pages. No fake live state, reward system, backend or dependencies.

Alternatives: Decorative icon proliferation adds noise without hierarchy. A new game scene reopens a direction the user replaced. The chosen incremental treatment builds on their approved journal and responds to the muted presentation.

- [x] Generate and inspect one matching Quiver SVG; preserve static local asset safety and provenance.
- [x] Adjust hero composition, journal card/page hierarchy, shared illustrated headings and pointer feedback; preserve native state, keyboard focus and reduced motion.
- [x] Check desktop/light/dark/320px layouts, meaningful existing browser regressions, Astro/lint/format and local SVG safety. Capture updated previews and deliver in the same draft PR.

Review focus: oversized art cannot obscure text or controls; mobile stays contained; selected/focus state retains contrast; motion is decorative and bounded; images remain static, local and deployment-base-aware. This is a presentation-only iteration; the journal controller/state model stays unchanged. Existing full-suite local failures and hosted results are recorded separately in PR #2115.

Validation:302 browser checks passed/8 conditional skips;13website units;Astro41files/zero diagnostics;lint and formatting passed. Prefixed build37pages at1280/320 passed with no failed assets or runtime errors. Separate source reviews pass after a reduced-motion hover finding was reproduced and fixed. Existing broad core/gateway failures remain recorded separately. Direct screenshots refreshed for all seven surfaces; same draft PR delivery follows these checks.
