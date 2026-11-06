# Website UI and first-use journey

The website uses the local memory browser’s olive foundation, amber accents and
self-hosted DM Sans. Serif lettering is reserved for the brand mark. The approved
quest journal replaces the 3D camp; its local Quiver illustrations, quiet margins,
numbered choices, and explicit selection marks now connect the homepage, actual-app
tour, client setup, Starlight docs, Why Lore and blog.

The homepage starts with a concrete explanation and a readable `.lore.md` artifact.
An actual-app preview comes before the journal. Conversation is the default chapter;
one durable project decision becomes reviewable knowledge, then relevant context for
a later task. An optional inventory keeps secondary choices out of the main reading
path and uses full-width phone rows. Source and file excerpts expand natively.
Task-specific reasons explain why a rule is supplied; unrelated rules remain stored.
The journal is explicitly fictional rather than a live agent or curation run.

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

Nine Quiver objects (18 geometry-identical light/dark SVG variants) ship as static local geometry-only images, with no external
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
![Dark journal conversation](screenshots/journal-home-dark.jpg)
![Phone recall and relevant knowledge](screenshots/journal-recall-mobile-dark.jpg)
![Full actual-app tour](screenshots/journal-tour-dark.jpg)
![Field-guide docs](screenshots/journal-docs-dark.jpg)
![Phone setup](screenshots/journal-setup-mobile-light.jpg)
![Blog field notes](screenshots/journal-blog-light.jpg)
![Why Lore](screenshots/journal-why-dark.jpg)
![Light artwork and data boundaries](screenshots/journal-data-light.jpg)
![Full-width phone inventory](screenshots/journal-inventory-mobile-dark.jpg)
![Phone comparison retains all facts](screenshots/journal-comparison-mobile-light.jpg)

See [the website package](../../packages/website/README.md) and
[the current approved design](../superpowers/specs/2026-11-06-website-story-design.md)
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


## Product-story and visual QA follow-up

| Area | Delivered behavior |
| --- | --- |
| Product proof | Readable knowledge-file artifact near the headline; actual app before the fictional journal |
| Journal sequence | Conversation → Saved knowledge → Next session; optional inventory, real file excerpt and task-relevance reasons |
| Readability | 15px reading text, 13px controls/status, full-width phone inventory; unrelated entries retain readable contrast |
| Setup | One visible sequence, six clients, honest “See verification steps” action, recorded-session example and preserved legacy fragments |
| Source fidelity | One consistent webhook rule across the journal, actual-app record, two revisions and linked conversation; exact-message limitation stated |
| Illustration | Nine purposeful objects, separate light ink palettes, local inert geometry and no brightness filter |
| Memory model | Recent conversation, distilled context and relevant knowledge shown as current-request inputs; stored history remains searchable |
| Decision guide | Fit-first introduction, all comparison facts stacked on phones, explicit local/provider/telemetry boundaries |
| Reading paths | Practical featured article, quiet metadata, relevant availability notes and compact, purpose-specific docs artwork |

One hundred fifty repeated delayed-load cases also pass across all five projects.
The regression suite covers the new default, optional inventory, composed text
contrast, light/dark artwork, setup destination, legacy fragments, no-JS dark
verification, responsive comparisons, memory diagrams and article hierarchy.
Existing URL/history, delayed-native, keyboard, reduced-motion, theme, setup and
product-tour contracts remain covered. Test results and the broader root-suite
limitations are recorded in the PR; website checks alone do not imply a passing
core/gateway suite or completed assistive-technology certification.

Current validation: 352 browser checks pass with eight conditional skips across five
viewport/appearance configurations; the final diagram alignment regression passes
in all five. Thirteen website unit tests and Astro diagnostics pass. A prefixed
build serves all 37 HTML pages and exercises journal history, setup/tour state,
local images and Pagefind navigation at 1280px and 320px without failed assets or
runtime errors. All 817 internal fragment links and 91 local HTTP destinations pass. Separate correctness and security reviews audit parser stability,
SVG geometry/paint safety, and factual boundaries. Full repository testing remains
separate and is reported with exact local failures in the PR.
