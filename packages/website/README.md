# Lore website

Astro builds the marketing site, blog, and Starlight docs into `dist/` for
withlore.ai. The gateway memory browser remains in `packages/ui`.

- `pnpm site:dev` starts local development from the repo root.
- `pnpm --filter @loreai/website test` exercises theme state transitions.
- `pnpm --filter @loreai/website test:browser` builds and checks desktop,
  intermediate, and 320px mobile pages in Chromium. Install the matching browser
  with `pnpm --filter @loreai/website exec playwright install chromium` first.
- `pnpm --filter @loreai/website check` checks Astro templates and TypeScript.

## Application design language

`public/palette.css` copies the local app's olive/amber scales and semantic
roles from `packages/ui/src/styles/app.css` (Tailwind 4.3.3 values). When changing
the app's palette, update the website's scale values and role mappings too.
Marketing/blog aliases live in `public/theme.css`; Starlight maps its roles in
`src/styles/starlight.css`. Each consumes the same palette and controls CSS.
Logo SVGs and illustrative SVGs keep their existing artwork colours.

`src/styles/fonts.css` uses the same pinned self-hosted DM Sans Variable and
Playfair Display fonts as the app, including latin and latin-ext subsets.
The website does not load the application's CSS or JavaScript.

Every page uses `ThemeProvider.astro` and a compact native `ThemeToggle.astro` disclosure. The provider runs
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

The interactive homepage landscape lives in `MemoryLandscape.astro`. Shared terrain
contours, region classification and orthographic projection are in
`src/lib/memory-landscape.ts`; the SVG is rendered at build time. The controller
lazily loads the pinned Three.js renderer only while visible, with normal motion
and sufficient device memory. Native stage controls work without JavaScript; SVG
region selection remains available when GPU rendering is disabled. The renderer
handles terrain raycasting, bounded rotation, one-shot stage trails, context loss
and resource disposal. Geometry and browser tests cover the shared boundaries,
projection, selection and failure paths.
