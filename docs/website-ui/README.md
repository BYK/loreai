# Website UI and first-use journey

The website uses the local memory browser’s olive foundation, amber accents and
self-hosted DM Sans. Serif lettering is reserved for the brand mark. The approved
quest journal replaces the 3D camp; its local Quiver illustrations, quiet margins,
numbered choices, and explicit selection marks now connect the homepage, actual-app
tour, client setup, Starlight docs, Why Lore and blog.

The homepage starts with a concrete description and installation action beside a
larger open-journal expedition illustration generated with Quiver. The artwork
links to the native journal. Distinct page, spine and card surfaces, chapter
progress, larger illustrations and readable rule text strengthen its hierarchy.
Fine-pointer hover/press movement is disabled for reduced motion. The
journal follows a fictional decision from conversation into inspectable knowledge,
then into a later task. Its inventory cards open their rule and native expandable
source. Task selection highlights the relevant entry; unrelated entries remain
stored. It is explicitly an illustration, not a live agent or curation run.

The three native radio groups work without JavaScript. Enhancement keeps
`chapter`, `entry`, and `task` in one allowlisted history entry and restores them
on reload or Back/Forward. Other parameters and fragments survive. Valid explicit
URL state wins; early native choices survive delayed initialization otherwise.
Pointer selection on phones brings the selected card’s rule into view; keyboard
selection keeps radio focus. Short pointer transitions respect reduced motion.

The product tour continues to use original captures of the built Solid app with
fictional API fixtures. It opens no gateway or production database. Setup keeps
all six existing client choices, copy/error handling and the connection-to-first-
session path. Pagefind, generated references, public fragments, signup recovery,
compact Light/System/Dark controls, and availability/cost distinctions remain.

The five Quiver SVGs ship as static local geometry-only images, with no external
resources, scripts, or account metadata. Source provenance is in
[the art directory](../../packages/website/public/journal-art/README.md). The old
renderer, geometry/fallback code, and Three.js/type dependencies are removed.

## Current visual evidence

These are direct captures of the built website. Desktop captures use the normal
1280px browser width; phone captures use 320px. Both appearances are represented.
No DOM, CSS, or image edits are applied to the captures. The original pre-PR PNGs
remain available for the baseline design at `82e1af50`; the current captures below
show the journal rather than the earlier camp iterations.

![Homepage with the interactive journal](screenshots/journal-home-light.jpg)
![Dark journal and inventory](screenshots/journal-home-dark.jpg)
![Phone recall and relevant knowledge](screenshots/journal-recall-mobile-dark.jpg)
![Full actual-app tour](screenshots/journal-tour-dark.jpg)
![Field-guide docs](screenshots/journal-docs-dark.jpg)
![Phone setup](screenshots/journal-setup-mobile-light.jpg)
![Blog field notes](screenshots/journal-blog-light.jpg)
![Why Lore](screenshots/journal-why-dark.jpg)

See [the website package](../../packages/website/README.md) and
[the approved design](../superpowers/specs/2026-11-06-quest-journal-design.md)
for implementation and maintenance.

## Approved audit coverage

| Idea | Delivered behavior |
| --- | --- |
| 1. Actual product | One homepage Knowledge preview links to the full Sessions, Knowledge/source-history, and model-activity tour |
| 2. Agent selection | Installation and first-session guides offer six fixed choices, separate Codex CLI/Desktop paths, and Pi prerequisites |
| 3. First success | First-session guide checks a recorded message, with connection-to-verification links |
| 4. Everyday use | Task guide for resuming, finding decisions, correcting knowledge, switching agents, and sharing |
| 5. Journal relevance | Three chapters follow a useful rule; choosing a later task shows the matching knowledge and keeps unrelated entries stored |
| 6. Memory concepts | Stored history, distillations, knowledge, and supplied context have distinct explanations |
| 7. Docs structure | Get started, Use Lore, Integrations, Advanced/reference, and Contributors groups |
| 8. Search | Built Pagefind with root and prefixed-preview search-result navigation verified |
| 9. Troubleshooting | Symptom-based checks and expected observations, plus safe issue-reporting guidance |
| 10. Reference clarity | Curated task intros, friendly environment groups, cleaned source-comment artifacts, generator parity |
| 11. Concrete benefits | One concise homepage workflow links to the daily-use guide for resuming, switching agents, and sharing |
| 12. Decision guide | Why Lore distinguishes instruction files, application memory infrastructure, agent frameworks, and existing-client memory |
| 13. Data and costs | Local/provider/embedding/telemetry boundaries, opt-out, import preview, and estimated-versus-billed usage |
| 14. Availability | Local/Git features and Folk Lore early access are explicit, including historical article notes |
| 15. Concise copy | Redundant copy instructions and fictional-example disclaimers removed; setup prerequisites clarified |
| 16. Hierarchy/navigation | Short homepage overview; full tour, setup, evaluation, and team signup disclosed on destination pages; functional docs headings |
| 17. Practical blog paths | Plain article kinds, takeaways, availability context, and specific next steps |
| 18. Reproducible proof | Webhook conversation, illustrative knowledge diff, later task, and separate observable milestones |

No new backend behavior, dependencies, accounts, permissions, or guaranteed performance
claims are introduced. The command contract test caught the incorrect `claude-code`
launch token before it was corrected to the actual `claude` executable.


## Follow-up design and accessibility audit

All eight approved improvements are included:

| Area | Delivered behavior |
| --- | --- |
| Navigation | Docs identifies its section; Get started remains an action rather than a second current destination |
| Setup state | Allowlisted agent selection persists in the URL, reload, Back, and Forward; delayed initialization preserves early native choices |
| Product preview | Knowledge preview opens the matching tour state; mobile uses actual 390×700 app captures; full-size originals remain linked |
| Selected state | Compact theme pill retains its size and now uses an accent border exceeding 3:1 against its surrounding fill |
| Hero explanation | One direct explanation of running Lore locally with an existing coding agent and reviewing project rules in Git |
| Proportions | A full-width journal replaces the camp, with compact chapter/card controls and no WebGL dependency |
| Articles | Long posts gain a native collapsible outline linked to generated heading IDs |
| Signup recovery | Email and form stay visible on failure, with associated feedback and a one-action retry |

![Mobile Knowledge tour](screenshots/tour-mobile-light.png)
![Article section navigation](screenshots/article-outline-light.png)
![Inline signup recovery with a synthetic address and mocked service response](screenshots/signup-error-light.png)

These checks establish behavior for the reviewed routes and conditions, not full
WCAG certification or a completed VoiceOver/NVDA audit. No real signup is submitted
while capturing or testing the error/retry flow.


## Journal validation

The final journal build passes 302 browser checks with eight conditional
skips across five viewport/appearance configurations. Fifty repeated state checks
cover checked-card navigation, atomic journal history, explicit URL precedence and
the product tour. Thirteen website unit tests, Astro diagnostics (41 files, zero
diagnostics), workspace typecheck/lint/format, generated-doc parity, all 37 pages’
social metadata, and 77 internal HTTP destinations pass.

A separate prefixed build exercises all 37 HTML pages and tests journal history,
setup/tour state, decoded illustrations, and Pagefind result navigation at 1280px
and 320px. It reports zero failed assets or runtime errors. Separate correctness
and security reviews checked static source binding, allowlisted query state and
the geometry-only SVG assets. The checked-card navigation defect found during
review has failing-before/passing-after regressions.

The broader root test result and hosted CI status are recorded in the PR; these
website checks do not imply that every core/gateway test passed locally.

The visual-polish review caught a reduced-motion hover jump. A real bounding-box
regression reproduced the 3px movement before the fix and passes in all three
desktop projects afterward. Geometry-only SVG checks and separate correctness/
security reviews pass for this presentation-only delta; no controller, query,
command, signup, or dependency behavior changes in this iteration.
