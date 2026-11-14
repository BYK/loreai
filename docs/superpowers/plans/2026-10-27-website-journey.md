# Website journey implementation plan

> Execute inline using superpowers:executing-plans; independent final correctness
> and security reviews follow quality/REVIEW.md.

**Goal:** implement all twelve approved website improvements in PR #2115.
**Architecture:** shared Astro navigation/footer/layout and native theme disclosure;
static content with small scripts for copy, release lookup, signup and menu feedback.
**Tech Stack:** existing Astro, Starlight, vanilla JS, Playwright and node:test.
**Spec:** ../specs/2026-10-27-website-journey.md

## Constraints and review focus

- Keep palette/fonts, existing URLs and reference fragments, newsletter destination,
  theme key and no-JavaScript navigation. Add no dependency or backend behavior.
- First mobile action must fit at 320×844; also inspect 320×480 and landscape.
- Storage/clipboard/network denial must not fabricate success or hide the command.
- Escape/outside click/menu selection must restore sensible focus.
- Duplicate signup submissions and malformed release responses must stay bounded.
- Benchmark copy must distinguish published results, fixture dates and limitations.

## Task 1: Navigation and truthful feedback

Files: shared navigation/header/footer, ThemeToggle, theme.js, site.js, controls.css,
node tests and browser tests. Introduce regression cases first, observe failures,
then build compact theme/details controls, consistent nav and clipboard/signup states.
Verify theme stability ×10, denied capabilities and both layouts/themes.

## Task 2: Product story and editorial pages

Files: index.astro, different.astro, shared layout/install/waitlist components,
theme.css, blog index/CSS. Replace decorative/duplicate sections with the concrete
example and scoped evidence; preserve public fragments. Run browser viewport,
contrast, URL, state and content regressions and inspect native screenshots.

## Task 3: First successful setup

Files: install.md, docs index, setup reference pages, Starlight sidebar. Reorder
existing content into the setup path; move detailed lifecycle content to a linked
reference page while preserving old fragment links. Keep telemetry note visible.
Verify new/legacy anchors and all production and preview links.

## Task 4: Review and publish to the existing PR

Run website unit/browser/Astro checks, workspace typecheck/lint/format and link checks.
Request separate adversarial and security reviews; fix findings with regressions.
Existing full-root baseline failed in 17 unchanged files in the previous PR pass;
report the actual scope of any new runs and keep hosted CI as the complete gate.
Refresh screenshots and PR title/body around the final implementation; commit and
push with gh-based PR updates. Do not merge or deploy.
