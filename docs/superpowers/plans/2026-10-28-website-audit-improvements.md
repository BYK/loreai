# Website audit improvements implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement these approved tasks sequentially. Review the finished changes separately for correctness and security.

**Goal:** Deliver all eight website improvements approved in this chat in PR #2115.

**Architecture:** Preserve Astro/Starlight, the camp scene/controller, native HTML controls, the compact theme pill, and the existing data boundaries. Add a small allowlisted URL-choice helper for setup/tour selection. Render article outlines at build time from Astro headings. Keep signup recovery in the original form.

**Tech Stack:** Astro, TypeScript, native disclosures/radios/buttons, CSS, Playwright.

**Spec:** The eight-item design/accessibility audit immediately preceding the user's approval: one active primary destination; URL-preserved agent choices; correct Knowledge preview/tour state and mobile readability; selected-ring contrast; concrete hero explanation; tighter camp proportions; collapsible long-article navigation; inline signup recovery.

- [x] Add failing browser regressions for navigation, selection URL/history, preview routing, selected-ring contrast, article navigation, and inline signup retry.
- [x] Update PrimaryLinks so Get started remains an action and Docs identifies its section.
- [x] Add an allowlisted URL-choice binder; use it for agent and tour radios, preserving other URL parameters/hash and Back/Forward behavior.
- [x] Link the homepage image to the Knowledge tour view. Capture a real mobile Knowledge screen with the existing isolated fixtures and offer an explicit full-size image link.
- [x] Strengthen the compact pill's selected border using the existing accent; retain desktop and touch sizes.
- [x] Replace the hero explanation and tighten camp layout without changing geometry, camera, art aspect ratio, or stable stage-panel height.
- [x] Add a native collapsible article outline for long posts using rendered heading IDs.
- [x] Keep signup fields visible on error; associate the message with the input and retry directly using the original submit control.
- [x] Run browser/unit checks, workspace typecheck/lint/format, Astro diagnostics, generated-doc parity, production/prefixed links and contrast/reflow checks. Run site builds sequentially.
- [x] Obtain separate read-only correctness/security reviews; refresh evidence and prepare the same PR update using gh CLI.

Do not alter the local app's production code or backend, introduce dependencies,
submit real email addresses, remove no-JavaScript paths, or claim full WCAG/screen-reader certification.
The earlier broader root-suite failures remain documented; this change does not touch those packages.


Implementation/verification ledger:
- The six audited behavior/accessibility regressions failed on the original candidate.
- Review reproduced initialization erasing an early native choice. A seventh delayed-module regression failed before its fix; the helper now preserves nondefault native selection if there is no valid explicit URL. A valid explicit URL remains authoritative.
- Final full browser run: 289 passed / 6 conditional skips. URL/history/delayed-module cases repeated ten times: 30 passed.
- All 14 website unit tests passed; workspace typechecks/lint/format, generated-doc parity, and Astro diagnostics passed (41 files; zero errors/warnings/hints).
- Separate correctness and security reviews found no remaining scoped blocker; final screenshots, prefix verification, commit/push follow below.

- Final prefixed verification checked all 37 HTML pages and actual setup/tour/history, decoded mobile images, search-result navigation, and article anchors at 1280/320px: zero failed assets or runtime errors.
- Production HTTP crawl: 73 passing internal destinations, zero broken. All 37 pages passed social metadata checks. Production preview rebuilt after prefix checks and restarted at 127.0.0.1:4330.
- Final captures show desktop/mobile pages, the preserved camp, theme contrast, the mobile Knowledge tour, article outline, and inline signup error. Signup uses only an intercepted synthetic failure.
