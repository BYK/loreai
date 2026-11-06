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
Logo SVGs and illustrative SVGs keep their existing artwork colours.

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

`PublicLayout.astro` owns the common public header/footer. `PrimaryLinks.astro`
is also used by the docs header and drawer; section links remain secondary.
`InstallCommand.astro` and `Waitlist.astro` keep command and signup copy consistent.
Native disclosures provide navigation without JavaScript. `menus.js` adds dismissal
and focus restoration; `site.js` owns copy receipts, a bounded release lookup, and
signup submission/retry/timeout feedback. No response-supplied HTML or destination
URLs are used.

The example on the homepage is explicitly fictional. Published evaluation figures
are scoped in `docs/benchmark.md`, while `docs/installation-reference.md` preserves
the detailed installer and cleanup documentation. Existing installation anchors
remain on the guided page and link to their full reference sections.

The homepage's `QuestJournal.astro` is an illustrative RPG field journal with
three native chapter choices, three knowledge cards with expandable sources, and
three later tasks. `src/lib/quest-journal.ts` owns its static data, art map, types,
and allowlisted parser. `src/scripts/quest-journal.ts` enhances native controls with
atomic `chapter`, `entry`, and `task` query state, reload/history restoration, and
focus transfer after explicit actions. URL values never become HTML or selectors.
Valid URL choices take precedence; early native choices survive delayed loading.
Keyboard selection retains radio focus; pointer-selected cards in the stacked
phone layout bring their rule into view. No-JavaScript controls remain useful.

Four local Quiver SVGs live in `public/journal-art/`; see that directory's README
for provenance and construction. `JournalArt.astro` prefixes their URLs and marks
them decorative. `public/journal.css` provides the shared paper/margin/selection
roles, native-control styling and field-guide frames. There is no 3D renderer,
WebGL requirement, or Three.js dependency. Only explicit pointer actions receive
short transitions; reduced-motion and keyboard interactions remain immediate.

## Visual language

Public pages, articles, and docs use the local app’s functional DM Sans headings,
neutral title colors, olive surfaces, amber actions, subtle borders, and 6–14px
control/pane radii. Playfair is reserved for the wordmark. The journal uses the same illustrated objects, page margins, numbered choices,
and amber selection marks across the tour, client setup, docs and blog. Keep the
ordinary product labels and bounded reading columns; illustration must not
obscure commands, product captures, or source material.

## Product journey and documentation

The homepage pairs the interactive quest journal with one actual-app preview and a concise
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
Knowledge includes a 390×700 mobile capture alongside the 1120×760 desktop view.
Responsive pictures retain explicit dimensions and link to the original full-size image.


Long blog posts expose a native collapsible outline using Astro’s rendered heading
IDs. Signup errors remain associated with the email input in the visible form;
the original submit action becomes a direct retry with the existing timeout,
duplicate-submit guard, and timestamp-only rate tracking.
