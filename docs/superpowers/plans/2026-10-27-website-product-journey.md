# Website product journey implementation plan

> **For agentic workers:** Use native execution in this existing worktree, followed by separate correctness and security reviews.

**Goal:** Implement the user's approved 18-point website audit in PR #2115 while retaining the adventurer camp.

**Architecture:** Keep Astro/Starlight and progressive HTML controls. Share agent setup content across homepage and install docs. Use actual local-app screenshots from the built app with synthetic API responses, not a simulated app. Add task-oriented docs and local Pagefind search; generated references remain reproducible.

**Tech stack:** Astro, Starlight, TypeScript, native HTML/CSS, existing Three.js camp, Pagefind, Playwright.

**Spec:** The 18 numbered recommendations approved in this conversation: real product tour; agent selection; first success; daily use; camp relevance; storage/context distinction; docs IA; search; troubleshooting; human references; concrete use cases; decision guide; costs/data; availability; concise copy; hierarchy/navigation; practical blog paths; reproducible proof.

## Constraints

- Preserve the approved camp geometry, landmarks, native controls and motion/failure behavior.
- Same branch/PR; no merge, live deployment, new account, paid action or production database access.
- Keep telemetry opt-out visible, historical benchmark scope honest, Folk Lore early access explicit.
- Never promise knowledge appears after one message, every stored memory is injected, or guaranteed savings.
- Setup examples must agree with repository CLI/adapter behavior. Pi's extension prerequisite must be explicit.
- Keep legacy fragments, preview URL prefixes, keyboard access and no-JS operation.

## Review focus

- Malformed/unknown agent query and multiple setup widgets cannot select arbitrary selectors or execute anything.
- Installation choices must work without JS; clipboard denial retains readable commands.
- Built search must load under both root and preview prefixes, with keyboard/mobile dismissal.
- Tour images must contain isolated sample data only and remain understandable on small screens.
- Generation/check parity must survive reference cleanup; current release capability statements remain consistent.

## Tasks

### Task 1: Concrete product and setup journey (audit 1,2,3,5,6,11,15,16,18)

Files: `src/components/AgentSetup.astro`, `ProductTour.astro`, `src/lib/agent-setup.ts`, `src/scripts/agent-setup.ts`, homepage/camp/CSS; `scripts/capture-product-tour.mjs` and public sample screenshots; `test/browser/product-journey.spec.ts`.

- [x] Add meaningful browser tests for tailored Desktop/Pi choices, unknown query, no-JS choice and copy denial; observe failures.
- [x] Add shared fixed setup definitions and progressive chooser; preserve existing install copy behavior.
- [x] Capture actual app screens against isolated synthetic fixture data; add tour with labeled native choices and full-size images.
- [x] Connect homepage outcomes, camp relevance example and sample knowledge diff to first-session walkthrough.
- [x] Verify build, types, browser interactions, mobile and themes.

### Task 2: Practical docs, IA and reference clarity (audit 3,4,6,7,8,9,10,13,14)

Files: docs index/install/first-session/using-lore/troubleshooting/memory/data-and-costs/example; client guides/Hermes; Astro sidebar and search; environment generator and generated output; Starlight styles.

- [x] Add tests for first-session navigation, built search, legacy fragments and public task paths; observe failures.
- [x] Replace duplicate entry points with task navigation; reuse chooser in MDX install.
- [x] Add task guides with actual UI names, command effects, expected results, limitations and source links.
- [x] Enable built Pagefind and group sidebar by tasks; expose knowledge tuning and contributor material appropriately.
- [x] Clean generated reference presentation in the generator; regenerate and check parity.
- [x] Verify all docs links and root/preview builds, search, no-JS and small-screen layout.

### Task 3: Decision, trust and editorial paths (audit 11,12,13,14,15,16,17,18)

Files: Why Lore, header/footer, blog schema/list/article, historical post notes, website README/evidence screenshots.

- [x] Rewrite Why Lore as a fit/decision page with sourced adjacent-tool context and genuine tradeoffs.
- [x] Add availability and data/cost paths; preserve all public anchors and signup semantics.
- [x] Add article kinds, practical next steps and status notes; no fake filters or invented metrics.
- [x] Tighten docs typography, hero copy and spacing; add consistent start/help/data navigation.
- [x] Verify complete website suite, generated docs, links and independent reviews; update same PR with current captures and explicit test limitations.

## Execution record

- User approved all 18 ideas and explicitly retained the camp; approval is the design handoff. No additional approval gate is needed.
- Reuse the clean `codex/website-app-design` worktree and existing UI fixtures; no backend behavior change is planned.

## Verification record

- Website browser suite: 254 passed / 6 conditional skips across five layouts/themes.
- Website unit suite: 14 passed, including launch-command ownership and malformed query tests.
- Astro check: 38 files, no errors/warnings/hints; workspace typecheck, lint, formatting, and generated-doc checks pass.
- Production link check: zero broken links. Metadata: all 36 pages complete.
- Separate PR-prefix build: all 36 HTML pages retain prefixes; actual search-result navigation and setup links pass at 1280px and 320px with no failed assets or runtime errors.
- Captures: actual built app with synthetic API responses; all API calls handled, no page errors, no external network/gateway/account/production database.
- Two independent reviews found no outstanding website correctness/security issue after fixes.
- Broader repository suite remains non-green: completed earlier run had 13,945 pass / 91 fail / 272 skipped, 16 untouched failing files, and two failed snapshots. No clean-base reproduction or full-suite pass is claimed.
- The final step is committing and updating existing PR #2115 with current evidence; no merge or deployment is authorized.


## Follow-up: reduce homepage density

The user found the overall page too busy. Keep the approved camp and all delivered
help, but use progressive disclosure: one static Knowledge preview links to `/tour/`,
installation and first-session guides own agent choices, and benchmark/team signup
links lead to their existing destinations. Remove the homepage section-navigation
strip, repeated feature blocks, evaluation table, and signup form. Keep legacy
fragment destinations and exercise the complete interactions on their owning pages.

Follow-up verification: 254 browser tests passed with 6 conditional skips; 14
website unit tests passed; Astro checked 39 files with zero diagnostics. Workspace
typechecks, lint, formatting, generated-doc parity, and 37-page social metadata
passed. The final prefixed build had no unprefixed HTML links and successful search
and setup navigation at 320/1280px. Direct LinkChecker validation found 68 passing
internal HTTP destinations and zero broken HTTP links, excluding external and
non-HTTP discovery references; the standard link wrapper hit an existing Astro
preview lock. Correctness and security reviews passed the incremental change after
restoring the shared Why Lore navigation styles. Earlier broader root-test
limitations remain unchanged. Site builds must run sequentially: a concurrent
prefix build caused transient 404s in an earlier browser run; the isolated final
run passed.
