# Lore website

Astro builds the marketing site, blog, and Starlight docs into `dist/` for
withlore.ai. The gateway memory browser remains in `packages/ui`.

- `pnpm site:dev` starts local development from the repo root.
- `pnpm --filter @loreai/website test` checks theme state, setup commands, and journal URL parsing.
- `pnpm --filter @loreai/website test:browser` builds and checks desktop,
  intermediate, and 320px mobile pages in Chromium. Install the matching browser
  with `pnpm --filter @loreai/website exec playwright install chromium` first.
- `pnpm --filter @loreai/website check` checks Astro templates and TypeScript.

## Application design language

`public/palette.css` copies the local app's olive/amber scales and semantic
roles from `packages/ui/src/styles/app.css` (Tailwind 4.3.3 values). When changing
the app's palette, update the website's scale values and role mappings too.
Marketing/blog aliases live in `public/theme.css`; Starlight maps its roles in
`src/styles/starlight.css`. Each consumes the same palette, controls, and journal CSS.
Logo SVGs retain their brand colors. Journal illustrations have separate geometry-identical light and dark palettes.

`src/styles/fonts.css` uses the same pinned self-hosted DM Sans Variable and
Playfair Display fonts as the app, including latin and latin-ext subsets.
The website does not load the application's CSS or JavaScript.

Every page uses `ThemeProvider.astro` and an icon-only `ThemeToggle.astro` pill.
Its native Light/System/Dark buttons expose accessible names, pressed state, and
compact desktop controls and 44px touch targets; focus stays on the selected button. The provider runs
before paint and shares Starlight's existing `starlight-theme` storage key.
System clears the override and follows live OS changes; explicit choices survive
navigation. Blocked storage falls back to an in-memory preference. Native
navigation and readable content remain available without JavaScript.


## Page structure and first use

`PublicLayout.astro` owns the common public header/footer. `FieldGuideNav.astro`
renders native Product and Resources disclosures beside Why Lore in the floating
header shared with Starlight. `src/lib/site-navigation.ts` owns the static link
copy and destinations; `PrimaryLinks.astro` renders the grouped phone menu and
docs drawer. Product features the quest journal, and Resources features the first
session guide, using existing appearance-aware Quiver artwork. GitHub, the theme
pill and a neutral Get started action remain separate utilities. Docs retain
Starlight search, with a 44px icon button at compact widths.
`public/navigation.css` supplies the shared floating frame and menu presentation.
`InstallCommand.astro` and `Waitlist.astro` keep command and signup copy consistent.
Native disclosures provide navigation without JavaScript. `menus.js` adds dismissal
and focus restoration, plus dismissal when keyboard focus leaves a menu; `site.js` owns copy receipts, a bounded release lookup, and
signup submission/retry/timeout feedback. No response-supplied HTML or destination
URLs are used.

The example on the homepage is explicitly fictional. Published evaluation figures
are scoped in `docs/benchmark.md`, while `docs/installation-reference.md` preserves
the detailed installer and cleanup documentation. Existing installation anchors
remain on the guided page and link to their full reference sections.

The homepage starts with a readable `.lore.md` artifact and a preview of the actual
memory browser. The interactive journal follows that product evidence. Its default
Conversation chapter follows one fictional webhook decision into Saved knowledge,
then a relevant rule supplied for a Next session task. Temporary fixture details
stay separate from the durable project rule. The `.lore.md` excerpt and source
quote are native disclosures; the three-entry inventory is optional and becomes
readable full-width rows on phones.

`src/lib/quest-journal.ts` owns static example data, task explanations, art names,
and the allowlisted parser. `src/scripts/quest-journal.ts` enhances native radio
controls with atomic `chapter`, `entry`, and `task` query state, reload/history
restoration, and focus transfer after explicit actions. Existing query values stay
compatible. URL values never become HTML or selectors. Valid URL choices take
precedence; early native choices survive delayed loading. Keyboard selection
retains radio focus; pointer-selected cards bring their rule into view.

Nine local Quiver objects ship in `public/journal-art/`, each with a dark and light
version (18 SVG files). See that directory's README for provenance and paint
adaptation. `JournalArt.astro` prefixes static URLs, marks the images decorative,
and selects a palette by appearance, including the device preference without JS.
Light art uses darker ink rather than a brightness filter. Chest, messenger bird,
satchel and tools explain storage, providers, carried knowledge and setup. All
variants preserve geometry and contain no scripts, external resources or inline
styles. There is no 3D renderer or WebGL requirement.

`public/journal.css` supplies paper, margins, selection marks, readable secondary
text, native controls and field-guide diagrams. Fine-pointer lift/press feedback
and short pointer transitions require no reduced-motion preference; keyboard and
reduced-motion interactions remain immediate.

## Visual language

Public pages, articles, and docs use the local app’s functional DM Sans headings,
neutral title colors, olive surfaces, amber actions, subtle borders, and 6–14px
control/pane radii. Playfair is reserved for the wordmark. The journal uses the same illustrated objects, page margins, numbered choices,
and amber selection marks across the tour, client setup, docs and blog. Keep the
ordinary product labels and bounded reading columns; illustration must not
obscure commands, product captures, or source material.

## Product journey and documentation

The homepage presents actual-app proof before the interactive quest journal, followed by a concise
everyday workflow and installation entry. `/tour/` owns the full three-view app
tour; benchmark details and team signup remain on their destination pages.
`AgentSetup.astro` shares fixed definitions from `src/lib/agent-setup.ts` between
the installation and first-session MDX guides. Native radios work without JavaScript; enhancement allowlists the `agent`
query and enables click-only clipboard controls. Agent and tour changes update
allowlisted URL parameters and restore on reload or Back/Forward. Initial setup
retains an early native selection when no valid explicit URL choice exists. Launch commands are tested against
the owning gateway agent registry.

Starlight search uses its built-in Pagefind integration. It indexes public static
documentation locally; it does not query a running gateway or private conversations.
Task guides precede integrations and advanced reference in the sidebar. Both doc
generators own their curated introductions and generated fields; run `pnpm check:docs`
after changing them.

### Reproduce the product tour captures

```bash
pnpm --filter @loreai/ui build
node packages/website/scripts/capture-product-tour.mjs
```

The capture script serves the built Solid app on an ephemeral loopback port and
fulfills API requests with fixed synthetic responses based on UI contract fixtures.
It opens no gateway, account, provider connection, or production database, and blocks
all nonlocal browser requests. Captures contain a fictional webhook project and
sample counts; they are UI examples, not measurements or a live curation run. Both
appearance variants are saved under `public/product-tour/`, with no DOM/CSS/image edits.
The same idempotency rule appears in the journal, knowledge record, two revisions,
and linked source session. Additional knowledge-detail and recorded-session captures
show what to inspect; the Knowledge tour links to its complete source/revision capture. Exact-message attribution is not promised. Knowledge includes a
390×700 mobile capture alongside the 1120×760 desktop view.
Responsive pictures retain explicit dimensions and link to the original full-size image.


Long blog posts expose a native collapsible outline using Astro’s rendered heading
IDs. Signup errors remain associated with the email input in the visible form;
the original submit action becomes a direct retry with the existing timeout,
duplicate-submit guard, and timestamp-only rate tracking.

The guided setup has one visible sequence and preserves the four original numbered
installation fragments as aliases. Verification uses an actual recorded-session
capture with an explicit sample-data label. Shared memory and data-boundary diagrams
separate what is stored, supplied to the current request, sent to providers, and
reported as operational telemetry. Why Lore keeps every comparison fact in stacked
phone rows. Blog readers start with a practical article; availability notes remain
specific to the relevant article rather than repeated on every post.

## Field-guide page interactions

`KnowledgeFile.astro` presents the hero rule in readable form or Markdown (`format`).
`KnowledgeInspector.astro` places native inspection points over the actual Knowledge
capture and shows illustrative rule/source/revision notes beside it (`inspect`). The
outer tour binds `view` only to `.tour-picker`; it must not collect inspector radios.
On compact screens the same inspection choices become a labeled row above the image.
The image-sized `.inspection-stage` keeps points within the capture even when a note
is taller. Full-size originals remain ordinary links.

`FitGuide.astro` highlights an existing comparison row (`fit`) while retaining the
complete table. `TroubleshootingGuide.astro` provides observation/check/result paths
(`issue`), with full reference headings preserved. `DocsTasks.astro` supplies the
illustrated docs directory. `public/page-field-guide.css` owns these shared native
controls, 44px targets, contrast markers and scoped spacing. Starlight prose margins
are reset inside controls so they match the public pages.

All four query groups reuse the allowlisted `bindUrlChoice` helper and preserve
unrelated queries, fragments, early native choices, reload and Back/Forward. Native
radio/CSS selection works without JavaScript; query restoration is an enhancement.
Setup confirmation is a reader-controlled checkbox per client, with no gateway probe,
storage or automatic completion. Copying a command never confirms the connection.
Editorial diagrams and article-specific next steps keep source and relevance concepts
separate from automatic extraction or exact-message attribution guarantees.

`ProductSpotlight.astro` is the compact homepage workbench. Its Rule/Source/History
radios bind `preview` separately from `format`, journal state and the tour's `inspect`
parameter. Each view links to the corresponding full tour state and crops the
unmodified actual Knowledge detail PNG. The original asset stays linked. Its styles
are scoped; homepage section spacing is overridden explicitly, and image links use
an inward focus ring inside the crop. Public app captures also follow the device's
dark appearance without JavaScript when no explicit theme exists.
