# `@loreai/ui` — Lore memory browser

Solid single-page app served by the gateway at `/ui`. It is a **read
projection** of the gateway's `/api/v1` surface: the gateway's SQLite store is
the only authority for projects, knowledge and sessions; the browser never owns
data in this slice and never talks to a provider. UI-01 (#1796) adds this
package as a compatibility smoke project plus documentation; UI-02 (#1797) adds
the shell, gateway static serving and removes the legacy server-rendered
dashboard.

Documents in this package:

- [`docs/api-inventory.md`](docs/api-inventory.md) — every `/api/v1` route,
  response shape, service ownership, gaps, and the management boundary the SPA
  must preserve.
- [`docs/baseline.md`](docs/baseline.md) — reproducible gateway startup / RSS
  / proxy-latency measurements before and after the UI.
- [`src/components/ui/ATTRIBUTION.md`](src/components/ui/ATTRIBUTION.md) —
  provenance and licence of the copied Solid UI primitives.

## Stack and pinned versions

Exact versions (no ranges). Every package below was published ≥ 7 days before
it was pinned (publish dates from `npm view <pkg> time`, checked 2026-09-18).

| Role | Package | Version | Published | Notes |
|---|---|---|---|---|
| Framework | `solid-js` | 1.9.15 | 2026-08-17 | see [Solid 2 status](#solid-2-status) |
| Router | `@solidjs/router` | 1.0.0 | 2026-07-28 | peer `solid-js ^1.8.6` |
| Build | `vite` | 8.3.0 | 2026-09-10 | rolldown-based |
| Compiler plugin | `vite-plugin-solid` | 2.11.14 | 2026-07-27 | peer `solid-js ^1.7.2`, `vite ^3–^9` |
| Headless primitives | `@kobalte/core` | 0.13.14 | 2026-09-07 | peer `solid-js ^1.9.8` |
| Table | `@tanstack/solid-table` | 9.2.4 | 2026-08-28 | v9 API (`createTable`, `tableFeatures`) |
| Virtual rows | `@tanstack/solid-virtual` | 3.13.38 | 2026-09-07 | |
| CSS | `tailwindcss` / `@tailwindcss/vite` | 4.3.3 | 2026-07-16 | CSS-first config, no `tailwind.config.js` |
| Local cache (scaffold) | `idb` | 8.0.3 | 2025-05-07 | UI-03 fills the repositories |
| Response validation | `zod` | 4.5.4 | 2026-08-29 | |
| Class helpers | `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.6.0 | | 2024-11-26 / 2024-04-23 / 2026-05-10 | used by the copied Solid UI components |
| Unit tests | `@solidjs/testing-library` 0.8.10, `@testing-library/jest-dom` 7.0.1, `jsdom` 30.0.1 | | 2024-09-25 / 2026-08-09 / 2026-07-29 | run by Vitest |
| Browser tests | `@playwright/test` | 1.63.0 | 2026-09-04 | separate CI workflow only (UI-02) |

### Solid 2 status

Owner preference was Solid 2.x if the *whole* set builds and typechecks.
Tested on 2026-09-18 by copying this package to a standalone directory, pinning
`solid-js@2.0.0-rc.9` (the `next` dist-tag; there is no stable 2.x) and running
`pnpm install`, `vite build`:

- `pnpm peers check` reports unmet `solid-js` peers for `vite-plugin-solid@2.11.14`
  (`^1.7.2`), `@kobalte/core@0.13.14` (`^1.9.8`), `@solidjs/router@1.0.0`
  (`^1.8.6`), `@tanstack/solid-virtual@3.13.38` (`^1.3.0`) and every
  `@solid-primitives/*` / `corvu` transitive of Kobalte.
- `vite build` **fails**: `"./web" is not exported … from package solid-js` —
  Solid 2 moves `solid-js/web` to `@solidjs/web`, which Kobalte 0.13 and
  Solid Router 1.0 still import from `solid-js/web`.
- The only Solid-2-compatible releases of the required packages are
  pre-releases: `@solidjs/router@2.0.0-next.26` (published the same day),
  `vite-plugin-solid@3.0.0-next.27`, `@kobalte/core@2.0.0-alpha.2` (peer
  `solid-js 2.0.0-rc.3`, already behind rc.9). None satisfies "stable, ≥ 7 days".

**Decision:** pin Solid 1.9.15. **Blocking dependency:** `@kobalte/core`
(no stable Solid 2 release; its alpha peers a different rc) — with
`vite-plugin-solid` and `@solidjs/router` also 1.x-only at stable. **Upgrade
test:** repeat the standalone-copy procedure above with `solid-js@2`,
`@solidjs/web`, `@solidjs/router@2`, `vite-plugin-solid@3`, `@kobalte/core@2`
once all are stable; the smoke page (`pnpm --filter @loreai/ui test`,
`typecheck`, `build`) is the acceptance gate.

### Tailwind major vs. the Solid UI recipe

Solid UI's published installation recipe targets **Tailwind 3**
(`tailwind.config.js` with `darkMode: ["class"]`, `tailwindcss-animate`,
`hsl(var(--x))` colour tokens, PostCSS). This package uses **Tailwind 4** with
the `@tailwindcss/vite` plugin and CSS-first configuration. They were not
mixed: the copied components were ported to Tailwind 4 (renamed utilities,
animation classes dropped, `@custom-variant dark`, `@theme inline` token
mapping). The full list of edits is in `src/components/ui/ATTRIBUTION.md`.

## Compatibility smoke (UI-01)

`src/compat/CompatSmoke.tsx`, mounted at `/ui/_compat` and labelled "not a
product screen". It is exercised three ways, all in the normal CI job — no
browser:

| Check | Command | What it proves |
|---|---|---|
| Typecheck | `pnpm --filter @loreai/ui typecheck` | Solid JSX types, Kobalte polymorphic props, TanStack v9 generics, router `RouteDefinition` |
| Unit tests (jsdom) | `pnpm --filter @loreai/ui test` | `test/compat-smoke.test.tsx`: reactivity; router creates/disposes nested routes on navigation, deep-links and `<A>` links; Kobalte Select opens inside a Dialog, selects, Escape closes the dialog only; IME `compositionstart`/`compositionend` with committed value; TanStack table renders 5 rows with formatted cells; TanStack virtual renders a window (< 40) of 10 000 rows |
| Build | `pnpm --filter @loreai/ui build` | Vite 8 + `vite-plugin-solid` + `@tailwindcss/vite` produce hashed `dist/assets/*` with Lore tokens compiled |

Result on the pinned set: all three pass (8/8 tests). jsdom specifics: Kobalte
opens its listbox on a primary-button `pointerdown`, and TanStack virtual
measures the scroll element with `offsetWidth/offsetHeight`, which the test
stubs because jsdom has no layout.

## Commands

```sh
pnpm install                            # root; also builds gateway dev shims
pnpm --filter @loreai/ui dev            # Vite dev server on http://127.0.0.1:5173/ui/
pnpm --filter @loreai/ui typecheck
pnpm --filter @loreai/ui test           # Vitest, jsdom
pnpm --filter @loreai/ui build          # -> packages/ui/dist (hashed assets)
pnpm --filter @loreai/ui preview        # serve dist locally

pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm test && pnpm run build   # root flows include this package
```

### Development workflow

Production never runs a frontend dev server: the gateway serves `packages/ui/dist`
(UI-02). For development:

1. Start a gateway locally: `pnpm --filter @loreai/gateway run bundle && node
   packages/gateway/dist/bin.cjs start --local` (default `127.0.0.1:3207`).
2. `pnpm --filter @loreai/ui dev` and open `http://127.0.0.1:5173/ui/`. Vite
   proxies `/api` to the gateway (`LORE_UI_GATEWAY` overrides the origin,
   default `http://127.0.0.1:3207`). The dev server binds to loopback so the
   gateway's socket-peer management check still passes.

## Data authority

- The gateway (`packages/core` SQLite via `packages/gateway/src/api.ts`) is
  authoritative for projects, knowledge, sessions and distillations.
- The browser holds **derived, disposable** state only: route, theme, pane
  layout, and (from UI-03) an IndexedDB cache of API responses and local
  drafts. Anything in IndexedDB can be deleted without loss of Lore data.
- The SPA calls the **read** routes only (`GET /api/v1/projects`,
  `GET /api/v1/projects/:id/knowledge`, `GET /api/v1/knowledge/:id`), with
  same-origin `fetch`, no credentials, and runtime validation of every
  response (`zod`). External knowledge `id`s are the **stable logical ids**
  the API already exposes; the UI never keys on per-version ids.
- The browser bundle imports nothing from `packages/gateway` or
  `packages/core`: no boot code, credentials, database, ACP or Git process
  control. Response types are re-declared as schemas in `src/api/`.

## UX → component mapping

From the design fixture (v2.2) to Solid components. UI-01 ships the primitives
and the smoke page; the fixture and shell rows land in UI-02.

| Fixture element | Component | Primitive / lib | Slice |
|---|---|---|---|
| Pane chrome (nav / list / detail), responsive collapse | `Shell`, `ListPane`, `DetailPane` | CSS grid + Tailwind breakpoints | UI-02 |
| Project rows, knowledge rows | `ProjectRow`, `KnowledgeRow` | `<A>` (router), `Badge` | UI-02 |
| Global search entry (placeholder) | `SearchEntry` | `TextField` (Kobalte) | UI-02 (real in UI-04) |
| Connection status (reachable / unreachable / unauthorized) | `ConnectionStatus` | `Badge`, `createResource` | UI-02 |
| Dark / light | `ThemeToggle` | `Button`, `.dark` class on `<html>` | UI-02 |
| Document-first detail, eyebrow labels | `KnowledgeDetail` | `.eyebrow`, `Separator` | UI-02 |
| Message + tool blocks | `MessageBlock`, `ToolBlock` | plain Solid, `Badge` | UI-02 (fixture only) |
| Selected passage, source links | `PassageTarget`, `SourceLink` | `.passage-target`, `<A>` | UI-02 (fixture only) |
| Collapsed discussion indicator, expanded inline replies | `DiscussionMarker`, `DiscussionThread` | `Button`, `Separator` | UI-02 (fixture only) |
| Focused discussion with source quote | `FocusedDiscussion` | `Dialog` (Kobalte) | UI-02 (fixture only) |
| Draft / saved / sent / unknown states, participant & scope labels | `StateBadge`, `ParticipantLabel` | `Badge` variants | UI-02 (fixture only) |
| Empty / error / locked states | `EmptyState`, `ErrorState`, `LockedState` | plain Solid | UI-02 |
| Mobile navigation | `MobileNav` | `Dialog` (sheet) or `Select` | UI-02 |
| Future actions (Save note, Ask agent, Explore separately, Start with selected context, Share finding) | `FutureAction` | `Button disabled` + "not available yet" | UI-02 (disabled) |
| Tables with sorting (sessions, knowledge) | — | `@tanstack/solid-table` | UI-04 |
| Long lists | — | `@tanstack/solid-virtual` | UI-04 / UI-06 |
| Local cache, drafts | — | `idb` | UI-03 |

## Layout

```
packages/ui/
  index.html              Vite entry (served as /ui/index.html by the gateway)
  src/index.tsx           mounts <App/>
  src/app.tsx             Router (base /ui) + route table
  src/compat/             compatibility smoke page + probes
  src/components/ui/      copied Solid UI primitives (owned source, see ATTRIBUTION.md)
  src/lib/utils.ts        cn()
  src/styles/app.css      Tailwind 4 + Lore tokens
  test/                   Vitest (jsdom) unit tests
  docs/                   api-inventory.md, baseline.md
```
