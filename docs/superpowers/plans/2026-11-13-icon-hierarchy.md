# Icon hierarchy implementation plan

> Execute inline with the executing-plans skill. Approved scope: the six icon and copy improvements from the visual QA; keep the floating nav and RPG artwork.

**Goal:** Make choices and stages easier to scan without replacing understandable labels with unexplained symbols.

**Architecture:** Extend the shared native radio label with optional decorative icons and compact labels. Reuse local agent marks in compatibility and setup. Decorate the framework-rendered docs group summaries without replacing its disclosure, persistence or navigation. Keep controllers, URLs stable. Tour labels become Sessions / Knowledge / Activity and Rule / Source / History; accessible names match the visible labels.

**Tech stack:** Astro, TypeScript, native HTML/CSS, existing Playwright suite.

- [x] Add local, attributed agent artwork and a shared line-icon vocabulary. Apply to setup, journal, tour, diagnostics and workflow choices; trim repeated journal and comparison copy.
- [x] Add docs group icons using the existing framework sidebar, preserving native disclosure and persistence.
- [x] Run scoped interaction tests and full website browser suite, static checks, and visual QA at phone/desktop widths in both themes. Review source delta for correctness/security; commit and push to PR #2115 without merging.

Validation includes keyboard and no-JS behavior, accessible radio names, manual setup verification, responsive labels, accurate source qualifications and independent query/history state. Do not repeat the previously interrupted full-repository test run for these website presentation changes; report that broader limitation separately.

Validation: 577 website browser checks passed / 8 conditional skips; 19 website unit tests; 69 Astro files with no diagnostics; workspace typecheck/lint/format passed. Prefixed links passed on all 37 generated pages. Phone light/dark and desktop visual checks completed. Broader repository testing limitation remains recorded in the PR.
