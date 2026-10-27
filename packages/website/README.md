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

Every page uses `ThemeProvider.astro` and `ThemeToggle.astro`. The provider runs
before paint and shares Starlight's existing `starlight-theme` storage key.
System clears the override and follows live OS changes; explicit choices survive
navigation. Blocked storage falls back to an in-memory preference. Native
navigation and readable content remain available without JavaScript.
