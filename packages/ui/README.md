# `@loreai/ui` — Lore memory browser

Solid single-page app served by the gateway at `/ui`. It is a **read
projection** of the gateway's `/api/v1` surface: the gateway's SQLite store is
the only authority for projects, knowledge and sessions; the browser never owns
data in this slice and never talks to a provider. UI-01 (#1796) adds this
package as a compatibility smoke project plus documentation; UI-02 (#1797) adds
the shell, gateway static serving and removes the legacy server-rendered
dashboard.

Routes (all under `/ui`, history-API fallback served by the gateway):

| Route | What |
|---|---|
| `/ui` | Workspace: project navigation + "choose a project" document |
| `/ui/projects/:projectId` | Knowledge list for a project (list pane) |
| `/ui/projects/:projectId/knowledge/:knowledgeId` | Knowledge entry as a document; `:knowledgeId` is the **stable logical id** |
| `/ui/knowledge/:knowledgeId` | Entry-only deep link; the project is derived from the entry |
| `/ui/fixture` (`?view=focus`, `?view=blocks`) | **Dev/test only** — design specimen (labelled **NOT PRODUCTION**): invented content, every P3/P4 state; `?view=blocks` runs an invented session through the UI-06a block model and renderer |
| `/ui/_compat` | **Dev/test only** — UI-01 compatibility smoke page |

Dev/test-only routes are mounted when `import.meta.env.DEV` is set (Vite dev
server, Vitest); production builds drop them and their chunks from the route
table, so the gateway's shipped bundle answers them with the SPA's
not-found screen.

Reference documents:

- [API inventory and gateway baseline](https://github.com/BYK/loreai/issues/1796#issuecomment-5736848368)
  (comment on #1796, not committed) — every `/api/v1` route, response shape,
  service ownership, gaps, the management boundary the SPA must preserve, and
  the reproducible startup / RSS / proxy-latency measurements before and after
  the UI (`scripts/ui-baseline.mjs`).
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
| Local cache | `idb` | 8.0.3 | 2025-05-07 | `src/db/` repositories and migrations (UI-03) |
| Response validation | `arktype` | 2.2.3 | 2026-07-07 | jitless (CSP); see [Schema library](#schema-library-ui-03-decision); replaces `zod` 4.5.4 from UI-02 |
| Relative timestamps | `date-fns` | 4.4.0 | 2026-05-29 | `formatRelative` in `src/lib/format.ts`; en-US locale until UI has a locale setting |
| IndexedDB in tests | `fake-indexeddb` | 6.2.5 | 2025-11-07 | dev only; see [Tests](#tests) |
| Class helpers | `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.6.0 | | 2024-11-26 / 2024-04-23 / 2026-05-10 | used by the copied Solid UI components |
| Unit tests | `@solidjs/testing-library` 0.8.10, `@testing-library/jest-dom` 7.0.1, `jsdom` 30.0.1 | | 2024-09-25 / 2026-08-09 / 2026-07-29 | run by Vitest |
| Browser tests | `@playwright/test` | 1.63.0 | 2026-09-04 | separate CI workflow only (UI-02) |
| Markdown | `marked` | 18.0.12 | 2026-09-07 | GFM tokens → HTML, raw HTML escaped; only used inside `src/lib/safe-html.ts` (UI-06a) |
| HTML sanitiser | `dompurify` | 3.4.15 | 2026-09-06 | explicit tag/attribute allowlist + link policy hook; only used inside `src/lib/safe-html.ts` |
| Code highlighting | `highlight.js` | 11.12.0 | 2026-08-12 | `lib/core` + 14 registered grammars, no auto-detect; regex-based, no `eval`, so `script-src 'self'` holds |
| Charts (not installed yet) | `@observablehq/plot` | 0.6.17 | 2026-04-06 | framework-agnostic DOM library, no Solid peer; added by the first slice that charts (UI-05) behind an owned container wrapper |

### Schema library (UI-03 decision)

UI-02 shipped its three response schemas with `zod` 4.5.4 (classic API). Before
growing that to the ~15 contracts UI-03 needs, the owner asked for a measured
choice between Zod v4, Valibot, TypeBox and ArkType, **decided on runtime
performance and memory footprint first**, bundle size second. The benchmark
lives in [`bench/`](bench/) (`npm install`, then `npm run bench`,
`npm run bench:browser`, `npm run bench:ts`, `npm run bundle` inside that
directory; it is a standalone npm package, not a workspace member, and is
**not** run in CI). All five adapters declare the *same* 15 schemas
(`bench/schemas/*.mjs`) over the same deterministic fixtures
(`bench/fixtures.mjs`). Unknown keys are tolerated in every adapter to match
the contract rule.

Versions measured (all published ≥ 7 days before 2026-09-18): `zod` 4.6.2
(`zod` and `zod/mini` entry points), `valibot` 1.5.0, `@sinclair/typebox`
0.34.52 (`Value.Check`), `arktype` 2.2.3. Node v24.19.0; Chromium 153.0.8010.12
via Playwright 1.63.0; `esbuild` 0.28.2 for the bundles.

**CSP first.** The SPA is served with `script-src 'self'` (no
`'unsafe-eval'`). Zod 4's object fast path and ArkType's compiled validators
both use `new Function`, and TypeBox's `TypeCompiler` does too, so every
adapter is measured on the path that can actually run in our tab:
`z.config({ jitless: true })`, `configure({ jitless: true })` for ArkType,
`Value.Check` for TypeBox. (With JIT, Zod parses the page 2.9× faster and
ArkType 11× faster than the rows below — irrelevant under our CSP.)

Payloads: `entry` = one knowledge entry, `page` = 200-entry knowledge cursor
page, `session` = session detail with 2 000 messages. Every parse gets a
fresh input from a pool of 32–64 distinct payloads. Throughput tables are
from the first full run; allocation and retention are from the re-run after
the retention harness fix (fresh `JSON.parse` per op). Throughput in the
re-run was within −22 %/+9 % of the first run (the process now carries a
~100 MB retained LRU from the previous payload, so GC is costlier); the
ordering held everywhere except Node `session`, where Valibot (687 ops/s)
edged ArkType (653) — Chromium `session` still had ArkType ahead (837 vs
765). Raw rows: `bench/` output, run 1 and run 2, are quoted in PR #1833.

**Sustained throughput, Node** (`bench/bench.mjs`, `node --expose-gc`, 2 s
warm-up then 10 s timed per payload, per-op latency percentiles):

| Library | entry ops/s · p50 · p99 | page ops/s · p50 · p99 | session ops/s · p50 · p99 |
|---|---|---|---|
| `zod` (jitless) | 530 361 · 1.8 µs · 2.3 µs | 2 511 · 0.390 ms · 0.510 ms | 514 · 1.886 ms · 3.326 ms |
| `zod/mini` (jitless) | 405 348 · 2.4 µs · 3.9 µs | 2 024 · 0.481 ms · 0.771 ms | 423 · 2.228 ms · 3.441 ms |
| `valibot` | 291 015 · 3.3 µs · 4.8 µs | 1 479 · 0.664 ms · 0.870 ms | 683 · 1.434 ms · 2.002 ms |
| `@sinclair/typebox` | 643 332 · 1.5 µs · 2.5 µs | 3 288 · 0.298 ms · 0.429 ms | 539 · 1.791 ms · 2.451 ms |
| **`arktype` (jitless)** | **876 043 · 1.1 µs · 2.1 µs** | **4 955 · 0.198 ms · 0.334 ms** | **840 · 1.160 ms · 1.504 ms** |

**Sustained throughput, Chromium** (`bench/browser.mjs`, same workload
bundled with esbuild and run in headless Chromium with `--js-flags=--expose-gc`):

| Library | entry ops/s · p50 · p99 | page ops/s · p50 · p99 | session ops/s · p50 · p99 |
|---|---|---|---|
| `zod` (jitless) | 595 817 · 1.7 µs · 2.0 µs | 2 827 · 0.345 ms · 0.455 ms | 563 · 1.730 ms · 2.465 ms |
| `zod/mini` (jitless) | 566 650 · 1.7 µs · 2.1 µs | 2 750 · 0.360 ms · 0.440 ms | 557 · 1.735 ms · 2.615 ms |
| `valibot` | 390 675 · 2.5 µs · 3.3 µs | 1 963 · 0.500 ms · 0.635 ms | 743 · 1.315 ms · 1.815 ms |
| `@sinclair/typebox` | 823 476 · 1.2 µs · 1.5 µs | 4 050 · 0.240 ms · 0.355 ms | 704 · 1.390 ms · 1.730 ms |
| **`arktype` (jitless)** | **1 074 147 · 0.9 µs · 1.3 µs** | **5 261 · 0.185 ms · 0.280 ms** | **916 · 1.075 ms · 1.255 ms** |

**Allocation per parse and GC pressure** (Node: heap delta per op with forced
GCs before/after, N = 1 000 distinct inputs, results retained; GC events from
`PerformanceObserver` `gc` entries over 1 000 further parses with results
dropped — all minor, no major GC for any library):

| Library | heap/op entry · page · session | GCs (count · ms) page | GCs (count · ms) session |
|---|---|---|---|
| `zod` (jitless) | 0.89 kB · 178.2 kB · 282.9 kB | 16 · 3.3 ms | 71 · 58.8 ms |
| `zod/mini` (jitless) | 0.89 kB · 178.2 kB · 282.9 kB | 20 · 5.4 ms | 93 · 82.3 ms |
| `valibot` | 0.84 kB · 178.5 kB · 290.4 kB | 9 · 3.0 ms | 30 · 24.8 ms |
| `@sinclair/typebox` | 0 · 0 · 0 | 4 · 1.5 ms | 13 · 18.2 ms |
| **`arktype` (jitless)** | **0 · 0 · 0** | 12 · 3.0 ms | 53 · 42.5 ms |

Chromium heap/op (pointer compression halves object sizes): `zod`/`zod/mini`
0.46 · 91.5 · 149 kB, `valibot` 0.46 · 91.6 · 153 kB, `typebox` and `arktype`
0 · 0 · 0. Zod and Valibot return a *copy* of the validated object — every
parse allocates a second page/session that then has to be collected;
TypeBox `Value.Check` and ArkType (no morphs) validate in place and return
the input. **Caveat on the zeros:** heap/op = 0 means "no allocation beyond
the input", not "free" — the response object itself still exists and is
what the store keeps (see retention below). ArkType's GC events in the
drop-results loop are the short-lived inputs the harness creates, not
library allocations.

**Retained heap after a long-lived loop** keeping results in a 50-slot LRU
(the SPA store shape): 100 000 parses for `entry` and `page`, 10 000 for
`session` (10× the objects per parse), forced GCs before/after. Every op
`JSON.parse`s a fresh response body, as a real `fetch` would, so the input
is reachable only through the LRU: an in-place validator retains the parsed
input, a copying validator retains its copy and the input becomes garbage.
Baseline = the same loop with plain `JSON.parse` and no validator; "excess"
is what the library retains beyond that.

| Library | retained · excess (Node) entry · page · session | retained · excess (Chromium) entry · page · session |
|---|---|---|
| `zod` (jitless) | 79 · +6 kB · 18.3 · +7.5 MB · 104.7 · +1.6 MB | 81 · +23 kB · 13.6 · +3.3 MB · 95.9 · +0.8 MB |
| `zod/mini` (jitless) | 91 · +29 kB · 18.3 · +6.6 MB · 104.7 · +1.6 MB | 82 · +24 kB · 13.6 · +3.3 MB · 95.9 · +0.8 MB |
| `valibot` | 142 · +80 kB · 22.4 · +10.7 MB · 105.1 · +2.0 MB | 72 · +14 kB · 13.6 · +3.3 MB · 96.0 · +0.9 MB |
| `@sinclair/typebox` | 62 · 0 kB · 11.7 · +0.04 MB · 103.2 · +0.03 MB | 54 · 0 kB · 10.3 · 0 MB · 95.1 · 0 MB |
| **`arktype` (jitless)** | 75 · +13 kB · 11.7 · +0.5 MB · 103.2 · +0.03 MB | 53 · 0 kB · 10.3 · 0 MB · 95.1 · 0 MB |

`JSON.parse` baseline: 62–72 kB · 10.9–11.7 MB · 103 MB in Node, 58 kB ·
10.3 MB · 95 MB in Chromium. As expected, retention is dominated by the 50
cached responses whichever library produced them — no library grows with the
parse count, and the retained heap for the session payload is within 2 % for
all five. The copying libraries do retain more than the `JSON.parse` objects
they replace on the page payload (Zod/Valibot copies are 1.6–1.9× the size
of V8's `JSON.parse` output in Node, 1.3× in Chromium — property-by-property
construction vs. `JSON.parse`'s compact literals), but that is a second-order
effect. **The real memory advantage of ArkType/TypeBox is allocation and GC
pressure per parse — no second copy of every page/session — not retained
heap.** An earlier revision of this section measured retention with a shared
input pool, which made in-place validators look like they retained ~0; that
was an artifact of the harness and is superseded by the numbers above.
`performance.measureUserAgentSpecificMemory()` in full Chromium reports the
same ordering but is dominated by not-yet-collected garbage (≈ 27–33 MB after
the page loop for every library), so it is recorded in `bench/browser.mjs`
output but not used for the decision.

**TypeScript cost** (`bench/ts-cost.mjs`: `tsc --noEmit --extendedDiagnostics`
over the adapter plus a probe materialising the inferred output type of all
15 schemas; median of 3 runs):

| Library | types | instantiations | check time | memory |
|---|---|---|---|---|
| `zod` | 2 284 | 5 581 | 0.10 s | 73 MB |
| `zod/mini` | 2 311 | 2 288 | 0.08 s | 72 MB |
| `valibot` | 5 830 | 19 109 | 0.16 s | 116 MB |
| `@sinclair/typebox` | 1 642 | 7 704 | 0.10 s | 73 MB |
| `arktype` | 7 355 | 64 741 | 0.25 s | 141 MB |

**Bundle contribution** (secondary; `bench/bundle-size.mjs`: esbuild,
`bundle + minify + treeShaking`, browser platform, only the 15 schemas
imported):

| Library | minified | gzip |
|---|---|---|
| `zod` (classic) | 443.5 kB | 90.3 kB |
| `zod/mini` | 23.3 kB | 7.7 kB |
| `valibot` | 9.8 kB | 3.0 kB |
| `@sinclair/typebox` | 105.6 kB | 25.8 kB |
| `arktype` | 158.7 kB | 49.7 kB |

**Standard Schema** (`"~standard"`): `zod`, `zod/mini`, `valibot`, `arktype`
yes; `@sinclair/typebox` 0.34 no.

**Decision: ArkType 2.2.3 (jitless)**, pinned exactly. Rationale, in order:

1. Runtime: fastest on every payload in both runtimes — 3.3× Valibot and 2×
   jitless Zod on the 200-entry page (0.198 ms vs 0.664 / 0.390 ms), 1.2× /
   1.6× on the 2 000-message session, with the tightest p99 (0.334 ms page,
   1.50 ms session in Node; 0.28 / 1.26 ms in Chromium).
2. Memory: zero allocation per parse because valid data is returned in
   place (the response object the store keeps is the one `JSON.parse`
   produced). Zod and Valibot allocate a full copy per parse (178 kB page,
   283–290 kB session in Node) that immediately becomes garbage-plus-copy —
   2–7× the minor-GC count and time of ArkType/TypeBox on the page, and
   1.3–1.9× larger retained page objects. Retained heap for a bounded store
   is otherwise near-identical across libraries; the win is GC pressure, not
   footprint.
3. It fits the contract rules: undeclared keys are ignored by default (forward
   compatibility), no coercion, structured `ArkErrors` with `path`, `expected`
   and `actual` that map straight onto `ContractError.issues`, Standard Schema.
4. Costs accepted: +49.7 kB gzip over Valibot's 3.0 kB (the SPA is served by
   the local gateway; the owner ranked this below runtime/memory), and the
   heaviest TS inference (0.25 s check for 15 schemas — negligible next to the
   Solid/JSX check of this package). `src/contracts/config.ts` sets
   `jitless: true` and is imported before `arktype` in every contract module;
   a unit test asserts the resolved config and the e2e run exercises the real
   CSP.

Not chosen: TypeBox (`Value.Check` is second on runtime/memory but 1.5–1.7×
slower than ArkType on page/session, no Standard Schema, JSON-Schema surface
unused), `valibot` (smallest bundle but 3.3× slower on the page and allocates a
copy per parse), `zod` classic (a copy per parse, slowest p99 on the session,
90 kB gzip), `zod/mini` (slowest overall here).

`packages/core` keeps its own `zod` dependency; that is an independent
decision for a Node process where none of the browser constraints apply.

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

`src/compat/CompatSmoke.tsx`, mounted at `/ui/_compat` in the Vite dev server
only (`import.meta.env.DEV`; production builds drop the route and its code)
and labelled "not a product screen". It is exercised three ways, all in the
normal CI job — no browser:

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
pnpm --filter @loreai/ui test:e2e       # Playwright against the BUILT gateway (see below)
node scripts/ui-deep-link-smoke.mjs     # browser-free deep-link smoke against the built gateway

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

### How the gateway serves the SPA

`pnpm --filter @loreai/gateway build` / `bundle` run
`packages/gateway/script/ui-assets.ts`, which builds this package in-process
through Vite's programmatic `build()` (resolved from `packages/ui`) when
`packages/ui/dist` is missing (`bundle` always rebuilds) and **stages** it
into `packages/gateway/dist/ui/` (git-ignored, in the npm publish allowlist):
every file of the Vite output (`index.html`, hashed `assets/*`, `public/`
files such as `favicon.svg`) copied as-is, plus precompressed `.br` / `.gz`
siblings for compressible types (`.js`, `.css`, `.html`,
`.svg`, `.json`, `.webmanifest` — not fonts or images) made at build time with
`node:zlib` only: brotli (quality 11, text mode, size hint) and gzip
(level 9). A variant is dropped when it is not smaller than the identity
bytes. zstd is deliberately not emitted: measured at its level-22 ceiling it
was 5–8 % larger than brotli on every asset (brotli's built-in dictionary
wins on small text), so shipping it would only grow the artifact. Next to the
files, `dist/ui/ui-manifest.json` (`packages/gateway/src/ui-manifest.ts`)
lists every servable path with its MIME type, identity size, the sizes of the
variants that exist, and a build ID that digests identity bytes only (so it
does not depend on the build host's zlib). Only paths in the manifest are ever
served; the manifest is validated (version, safe relative paths, known
encodings) before the first response and a missing or invalid one makes the
UI a JSON `503`, never a crash.

At runtime `packages/gateway/src/ui-static.ts` reads the staged tree through
one `UiAssetSource`, resolved once and lazily:

- **SEA binary** (`sea.isSea()`): `script/build-binary-sea.ts` hands the
  staged tree to [fossilize](https://github.com/BYK/fossilize) as a directory
  asset (`<staging>/ui=ui/`, fossilize 0.11.0), which embeds every file under
  the key `ui/<path>` (e.g. `ui/index.html`, `ui/assets/index-*.js.br`), and
  the source is `sea.getRawAsset("ui/<path>")` — no filesystem, no extraction.
- **everything else** (`npm` CJS bundle, the Bun ESM bundle that
  `@loreai/opencode` runs in-process, `tsx` dev, tests): `dist/ui/` on disk
  next to the bundle (`./ui/` relative to `dist/index.cjs`, `../dist/ui/`
  relative to `src/`), read with `readFileSync`.

Bodies are read on first use and cached in memory; the manifest (not the
URL) decides which file is read, so no request can address a path outside
the staged tree. `setUiAssetSource()` swaps in an explicit source for tests.
`ui-static.ts` answers `/ui`, `/ui/` and `/ui/*`:

- `/ui/assets/<hash>.js|css` → the staged file, `Cache-Control: public,
  max-age=31536000, immutable`, correct MIME type, `ETag` / `304`.
- any other `/ui/...` path → `index.html`, `Cache-Control: no-cache`
  (history fallback for client routes); unknown `/ui/assets/*` is a 404, never
  HTML. `ui-manifest.json` and the `.br`/`.gz` siblings are not routes.
- `Accept-Encoding` is negotiated per request from the staged variants:
  the acceptable encoding with the highest client q-value wins, ties broken by
  the server preference br > gzip > identity (every current browser advertises
  `br`, so they all get brotli; `zstd` in a request is simply ignored). `identity;q=0`
  and `*` (incl. `*;q=0`) are honoured; an encoding the client did not list is
  never sent; a malformed header (bad q-value, unknown parameter, invalid
  token) or an absent/empty header means identity. If the client excludes
  every encoding we have, identity is served rather than a 406. Every response
  for a compressible asset — including identity and `304` — carries `Vary:
  Accept-Encoding`; the ETag is suffixed per encoding
  (`"<build>-<path>-br"`), so a validator only revalidates its own
  encoding; `Content-Length` is the encoded length (also on `HEAD`). Fonts
  and images have no variants and no `Vary`. Nothing is compressed at
  request time; a variant the manifest promises but the source lacks falls
  back to identity.
- every response carries a strict `Content-Security-Policy`
  (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'
  data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri
  'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`. No
  inline scripts or styles: Vite emits `<script type="module" src>` and a
  linked stylesheet only.
- the SPA and its assets sit behind the **same management authorization as
  `/api`** (`server.ts`): non-loopback peers get the bodyless 404 unless
  `LORE_ALLOW_REMOTE_MANAGEMENT` is set, `Origin` is checked the same way and
  `LORE_GATEWAY_AUTH_TOKEN` applies. `/` keeps redirecting to `/ui`.

### Tests

| Layer | Command | Where it runs |
|---|---|---|
| Unit (jsdom) | `pnpm --filter @loreai/ui test` — `test/api-client.test.ts` (typed client: validation, error classification, abort), `test/contracts.test.ts` (fixture round-trips + violation battery), `test/db.test.ts` (IndexedDB layer on fake-indexeddb: upgrade, recovery, TTL/LRU), `test/state.test.ts` (cached-first loader, cursor merging, store identity), `test/shell.test.tsx` (shell, real-data routes, cached-first rendering), `test/compat-smoke.test.tsx`, reader tests (see [Tests (UI-06a)](#tests-ui-06a) and [Tests (UI-06b)](#tests-ui-06b)) | root `pnpm test`, regular CI job |
| UI contract fixtures | `pnpm exec vitest run packages/gateway/test/ui-contracts.test.ts` — real gateway responses normalised (uuids/epochs/paths) and snapshotted into `packages/ui/test/fixtures/` | root `pnpm test`, regular CI job |
| Gateway static serving | `pnpm exec vitest run packages/gateway/test/ui-static.test.ts packages/gateway/test/review-actions.test.ts` | root `pnpm test`, regular CI job |
| Deep-link smoke (no browser) | `node scripts/ui-deep-link-smoke.mjs` — spawns the built gateway in a throw-away data dir, plain HTTP: `/` → `/ui`, deep link → `index.html` + CSP + no-cache, hashed assets → MIME + immutable, unknown asset → non-HTML 404 | regular CI job, after the bundle step |
| Browser e2e | `pnpm --filter @loreai/ui test:e2e` — Playwright (`e2e/`), desktop + mobile Chromium, against the **built** gateway (`e2e/gateway.mjs` seeds a temp DB through `@loreai/core` and runs `packages/gateway/dist/bin.cjs`). `fixture.spec.ts` covers a dev-only screen, so its `dev-*` projects run against a Vite dev server (`LORE_E2E_DEV_PORT`, default 5174) proxying `/api` to that same seeded gateway. Requires `pnpm --filter @loreai/core build && pnpm --filter @loreai/gateway bundle` and `pnpm --filter @loreai/ui exec playwright install chromium` | `.github/workflows/ui-e2e.yml` only: PRs touching `packages/ui/**` or the gateway's UI-serving files, nightly on `main`, `workflow_dispatch`; browsers cached |

## Session reader (UI-06)

The session reader is a **document**, not a chat feed: history is a list of
addressable blocks the reader can select, link to and (in P3/P4) annotate or
continue from. UI-06a (#1801, #1508) ships the model and rendering; UI-06b
the virtualised route (`/ui/projects/:id/sessions/:sid`), server paging,
selection and deep links; the busy fixture, in-session search and coverage
labels follow in UI-06c.

### Block model (`src/reader/blocks.ts`)

`buildBlocks(sessionDetail)` turns the `GET /api/v1/sessions/:id` body into
`ReaderBlock`s without inventing anything the server did not send:

| Block | Id | Source |
|---|---|---|
| `MessageBlock` | `m.<temporal message id>` | one `temporal_messages` row |
| `DistillationBlock` | `d.<distillation id>` | one distillation summary |

Ids derive from **server ids only** — never from array position — so they
are stable across reloads, paging and virtualisation. Duplicate ids from
overlapping pages collapse to the first occurrence.

A message's `content` is split on core's chunk separator (`"\n\x1f"`) into
**parts** — `text`, `reasoning` (`[reasoning] …`) or `tool` (`[tool:<name>] …`,
name bounded to 200 non-space characters). Each part carries `index`, `kind`,
`tool` and `hash` (`contentHash(text)`). Empty content is one empty text
part, so every block has at least one part.

`origin` labels who produced the block: `user`, `agent`, `lore` (metadata
`synthetic: true`, `lore: true` or `agent: "lore"`), `system` (role
`system`) or `unknown` (any other stored role, shown with an "unrecognised
role" badge and the raw role). Lore-injected messages and the system prompt
render with their own badge and tint (#1508). Metadata is parsed
defensively: malformed JSON yields an empty `MessageMeta`, never a crash.

`createdAt` is `null` unless the server sent a finite positive epoch;
`BlockTime` then renders the literal text **time unknown** — timestamps and
ids are never manufactured.

Distillations are kept in a **separate** list (`blocks.distillations`,
ordered by generation, time, id) and render as an `<aside>` labelled
"Compressed context — Lore's summary of the surrounding messages, not what
anyone said". The compressed text itself is shown only on demand (a
`<details>`, loaded through `GET /api/v1/distillations/:id`), as plain
escaped text. They are never interleaved as speech.

### Source anchors (`src/reader/anchors.ts`)

```ts
interface SourceAnchor {
  blockId: string;      // m.<id> | d.<id>
  partIndex?: number;   // omitted = whole block
  start: number;        // offsets into the part's *displayed text*
  end: number;
  contentHash: string;  // part hash (or whole-block hash)
}
```

Anchors are **logical**, not DOM positions: offsets index the `text` of the
sanitised render (`RenderedHtml.text === element.textContent`), so they
survive virtualisation (the element need not be mounted), re-rendering and
streaming. Wire form (`encodeAnchor` / `decodeAnchor`):
`<mapping>~<blockId>~<partIndex|''>~<start>~<end>~<hash>` — URL-safe without
percent-encoding, bounded (`MAX_ANCHOR_OFFSET`), strictly validated;
anything malformed decodes to `null`.

`resolveAnchor(decoded, block, displayedText)` answers honestly:

| Result | Meaning |
|---|---|
| `ok` + `quote` | same block, same part, same content hash, span inside the text |
| `changed` (`hash`) | the passage's source text differs from when the link was made |
| `changed` (`range`) | hash matches but the span runs past the text (a forged or truncated link) |
| `changed` (`mapping`) | the link was made with an older offset mapping version |
| `missing` (`block` / `part`) | the block or part is not in the loaded history |

There is **no** text-similarity fallback: a changed source is reported as
changed, never silently re-anchored. `contentHash` is `cyrb53` in base-36
(`src/lib/hash.ts`) — fast, deterministic, pinned by tests; it detects
edits, it is not a security primitive.

**Standard text fragments.** `textFragmentFor(quote)` produces the
[WICG scroll-to-text](https://wicg.github.io/scroll-to-text-fragment/)
fragment directive (`:~:text=textStart[,textEnd]`, both terms
percent-encoded including the directive's own `-` and `,` delimiters;
quotes longer than `TEXT_FRAGMENT_BUDGET` = 96 characters become a
whole-word `textStart,textEnd` range) so a copied passage link also works as
a plain text fragment in browsers that implement it (Chromium, Safari 16.1+,
Firefox 131+ — <https://caniuse.com/url-scroll-to-text-fragment>). It is a
*hint*, not the anchor: a text fragment has no block identity or revision
(a repeated phrase matches its first occurrence; an edited passage silently
matches nothing), the browser strips the directive before scripts see the
URL (`location.hash` never contains it), and it is applied only on a full
page load. `?a=` therefore stays the authoritative, verified anchor; the
directive is appended to the copied link (UI-06b's `deepLinkFor`) and
never read back.

### Safe rendering (`src/lib/safe-html.ts`)

The single boundary between transcript text and the DOM; `RichText` in
`components/reader/SessionBlock.tsx` is the only `innerHTML` sink in the app
and accepts only a `RenderedHtml` from this module.

Pipeline: strip bidi controls (U+202A–U+202E, U+2066–U+2069) → `marked`
(GFM; raw HTML **escaped** and shown as text; images rendered as
`[image: alt]` + an ordinary link, never fetched; checkboxes as text) →
`highlight.js` for fences whose info string resolves to a registered grammar
(bash, css, diff, go, javascript, json, markdown, python, rust, shell, sql,
typescript, xml, yaml + common aliases; unknown languages are escaped) →
`DOMPurify` with an explicit allowlist (`p br hr strong em del code pre
blockquote ul ol li h1–h6 a span table thead tbody tr th td`; attributes
`href title class start align`; `class` values restricted to `hljs*`, highlight.js sub-scopes (`function_`, `class_`),
`language-*`, `md-image`, `md-checkbox`) → link policy: only `http:`,
`https:` and `mailto:` keep their `href`, and get `rel="noopener
noreferrer"`, `target="_blank"` and a `data-external` marker (CSS draws the
↗ indicator). Everything else (`javascript:`, `data:`, `vbscript:`,
relative, fragment) becomes inert text.

Parts over `MAX_MARKDOWN_CHARS` (200 000) skip Markdown and render as
escaped plain text (`plain: true`); tool output and reasoning always render
plain. All three libraries are regex/DOM based — no `eval`, no `Function` —
so the gateway's CSP (`script-src 'self'`) is unchanged.

`src/reader/render.ts` caches rendered output per `blockId#partIndex#hash`
in an LRU of `RENDER_CACHE_LIMIT` (2000) entries; a content change is a
different key, so stale HTML is never served for edited text.

**Bundle impact.** The engines initialise lazily and every screen that
renders blocks is loaded with `lazy()`, so they never enter the product
entry. UI-06a left `index-*.js` at 386.00 kB / 121.88 kB gzip (CSS
+2.73 kB / +0.70 kB gzip for the Markdown/code/highlight styles); statically
linking the engines into the entry measured +144 kB / +47.6 kB gzip (marked
≈ 44 kB, dompurify ≈ 133 kB, highlight.js core + 14 grammars ≈ 117 kB of
source). UI-06b ships the reader as its own chunk — `Session-*.js`
195.55 kB / 64.27 kB gzip (engines + `@tanstack/solid-virtual` +
`virtual-core` ≈ 22 kB minified + the reader) — and the entry **shrinks**
to 325.68 kB / 104.15 kB gzip: the dev-only compatibility smoke used to be
a static import in `app.tsx`, which kept its modules in the entry's graph
and, once the reader chunk shared `virtual-core` with it, would have hoisted
the virtualiser into the entry (+22 kB). Both dev-only routes are now
`lazy()` and production builds emit neither chunk.

### Reader route, paging and virtualisation (UI-06b)

`routes/Session.tsx` owns `/ui/projects/:projectId/sessions/:sessionId`
(the path UI-04/05 link to) and renders `components/reader/SessionView.tsx`
over `createSessionReader()` from `src/state/sessions.ts`.

**Server paging (opt-in).** `GET /api/v1/sessions/:id?path=…` is unchanged
for existing callers. With `page=cursor` (`limit` 1–1000, default 100) or a
`cursor=` token the gateway answers `{ messages, distillations, next_cursor,
message_count }` (`packages/gateway/src/api-lists.ts`,
`handleShowSessionCursor`; core `listSessionMessagesPage`): the first page
is the **newest** `limit` messages, each following page the older ones,
every page in chronological order. Ordering is a stable keyset on
`(created_at, id)` (`created_at < ? OR (created_at = ? AND id < ?)`), so
equal timestamps neither skip nor repeat across pages. Cursors are opaque,
versioned, and bound to the project + session they were issued for — a
cursor replayed against another session is a 400, never someone else's
history. `message_count` is the count at query time; `next_cursor: null`
marks the start of captured history. Contract: `src/contracts/session.ts`
`sessionPage`; fixture `test/fixtures/session-page.json`; gateway tests in
`packages/gateway/test/api-session-paging.test.ts`.

**Reader state.** `createSessionReader()` reuses the session detail loader
(cached-first, `messageBlocks` collection, partial/stale semantics) for the
first page and keeps older pages in a per-session prepend list; `hasOlder`
is `null` until a non-stale server response says otherwise, so the view
never claims "start of captured history" from the cache alone. Session
changes abort in-flight page requests and reset paging.

**Rows.** `src/reader/rows.ts` builds one `ReaderRow` per block
(`key = block.id`); distillations with a known `createdAt` slot into the
chronological position of the messages they summarise, those without a
timestamp stay at the end — no time is invented to place them.

**Virtualisation.** `SessionView` uses `@tanstack/solid-virtual@3.13.38`
(`createVirtualizer`, `estimateSize` 120 px, `overscan` 6, `getItemKey` =
row key) with owned dynamic measurement (`measureElement` on each mounted
row, so expanding a tool part or loading Markdown re-measures). Loading
older history prepends rows and restores the scroll offset by the
virtualiser's total-size delta, so the passage under the reader's eye does
not move. Focus is logical (`focusKey`): arrow keys move it across rows
that may not be mounted; the DOM focus lands when the virtualiser mounts
the row.

**Selection and deep links.** `src/reader/selection.ts` reads the DOM
`Selection` into a `SelectionReading`: a `part` reading (block, part,
start/end into the displayed text, quote) when the range lies inside one
`[data-block][data-part]` element, `ambiguous` when it spans parts or
blocks or falls outside — the reader shows a hint instead of guessing.
A reading becomes a `SourceAnchor` published as `?a=<encoded>` on the
route; reload decodes it, finds the row, scrolls it into view and highlights
the passage by wrapping text nodes in `<mark data-passage-mark>` (DOM
operations, never HTML strings). Resolution states surface as banners:
`changed` ("Source changed since this link was made", the passage is not
highlighted), `missing` (older pages are searched up to
`DEEP_LINK_SEARCH_PAGES` = 10, then "not found in the loaded history" /
"not in this session's captured history"), malformed ("passage reference is
not understood"). Selecting a passage
opens the passage panel: the quote, **Copy with source** (quote + block
origin/time — `time unknown` stays literal — + deep link) and **Copy link**
are live; `Save note`, `Ask agent`, `Explore separately`, `Start with
selected context`, `Share finding` render disabled with the visible
"not available yet" label (`FutureAction`). The copied link is
`deepLinkFor(base, anchor, quote)`: `?a=` plus the standard `#:~:text=`
directive for the quote (see [Source anchors](#source-anchors-srcreaderanchorsts)),
so it also scrolls to the passage as a plain text fragment where the browser
supports that; the reader itself only ever reads `?a=`.

**Coverage line.** The header states `N of M captured messages loaded`
(server count known), `M messages` when everything is loaded, or `N
messages loaded` when the count is unknown; a `partial` cache shows the
partial indicator until the server answers. The three-way
captured/partial/native-transcript declaration is UI-06c.

### Tests (UI-06b)

`test/reader-state.test.ts` (newest-first page, prepend, cursor
termination, no paging before the first response, session switch aborts,
older-page failure, cache partial/complete semantics),
`test/reader-selection.test.tsx` (row building and unknown-time order,
logical selection with inline markup, cross-part/outside/collapsed
ambiguity, DOM-safe highlight apply/clear, invalid ranges, source-reference
text, deep-link round trip), `test/session-view.test.tsx` (deep-link
highlight, changed / out-of-range / malformed / missing source, older-page
search, pointer selection → anchor, copy with source / copy link, copy
failure, disabled future actions, cross-passage hint, coverage line,
load-older + prepended rows, unknown completeness, keyboard focus + Enter,
distillation rendering), `test/contracts.test.ts` (`sessionPage` fixture),
`packages/gateway/test/api-session-paging.test.ts` (legacy shape untouched,
cursor shape, page order, equal-timestamp tie-break, limit clamping and
400s, malformed / cross-project / cross-session cursors, unknown session).

### Tests (UI-06a)

`test/reader-blocks.test.ts` (ids, parts, envelopes, metadata, origins,
unknown time, overlap de-duplication, distillation ordering, real fixture),
`test/reader-anchors.test.ts` (round-trip, URL safety, hostile decode
battery, ok / changed / missing resolution, no re-anchoring),
`test/safe-html.test.ts` (27-payload hostile battery — `<script>`, `onerror`,
`javascript:`/`data:`/`vbscript:` links, `srcdoc`, SVG/MathML, `<base>`,
`<meta>`, forms, `target=_top`, code-fence info-string injection, comments,
bidi overrides, 200 kB and 2000-item blocks — plus link policy, image
policy, class allowlist, text/DOM parity, cache keying and LRU eviction),
`test/session-block.test.tsx` (roles, badges, time unknown, Lore/system
labels, expandable tool/reasoning parts, distillation labelling).

## Baseline (before / after UI-02)

From the [baseline posted on #1796](https://github.com/BYK/loreai/issues/1796#issuecomment-5736848368), `node scripts/ui-baseline.mjs
--runs 5 --requests 40` on the same VM (Xeon 8559C ×8, Node v24.19.0), p50s:

| Metric | clean `main` (`a4e6af5b`) | after UI-02 |
|---|---|---|
| Gateway bundle `dist/index.cjs` | 17,565,653 B | 18,125,556 B (+3.2 %, incl. self-hosted fonts + logos) |
| Startup → `200 /health` | 1297 ms | 1144 ms |
| RSS after start | 361.8 MB | 356.1 MB |
| Proxy `POST /v1/messages` (mock upstream) | 32.7 ms | 30.5 ms |
| `GET /health` | 0.86 ms | 0.58 ms |
| `GET /api/v1/projects` | 0.62 ms | 0.57 ms |

The SPA is staged next to the bundle (or as SEA assets) and loaded lazily on
the first `/ui` request; the proxy path is unchanged. (The bundle size above
predates the move from an embedded module to staged files, which took
`dist/index.cjs` back to ≈17.45 MB.)

## Data authority

- The gateway (`packages/core` SQLite via `packages/gateway/src/api.ts`) is
  authoritative for projects, knowledge, sessions and distillations.
- The browser holds **derived, disposable** state only: route, theme, pane
  layout, an IndexedDB cache of API responses (`src/db/`, database
  `lore-ui` v2) and local working state (`drafts`, `pendingChanges` —
  per-device, never merged into entity stores). Anything in IndexedDB can
  be deleted without loss of Lore data; a reset never touches the server.
- The SPA calls the **read** routes only (`GET /api/v1/projects`,
  `GET /api/v1/projects/:id/knowledge` (+ `?page=` cursor variant),
  `GET /api/v1/knowledge/:id` (+ `/versions`), sessions, distillations and
  the folk status routes), with same-origin `fetch`, no credentials, and
  runtime validation of every response (`arktype`, `src/contracts/`;
  timestamps are epoch milliseconds). A 2xx body that fails its contract
  throws `ContractError` (an `ApiError` of kind `invalid`) — never a silent
  coercion.
- Every loader races the cache read against the server fetch: a cached
  answer renders immediately as `stale` (the `StaleBadge`), the server
  answer replaces it; a server failure keeps the cached rows and flips the
  badge to "gateway unavailable" rather than an error card. A cached
  collection is complete only when `complete && rows.length === count`
  (each scope records the server's row count); rows lost to TTL/LRU
  eviction still render but are marked `partial` until the server answers.
  Session detail applies the same rule through a per-session `collections`
  record for `messageBlocks`: a missing block (or a missing record from a
  legacy write) marks the cached history `partial`.
- `src/lib/api.ts` classifies failures for the shell: network error →
  `unreachable`; 401/403 or a **bodyless** 404 (the gateway's way of hiding
  management routes from non-loopback peers) → `unauthorized`; a JSON 404 →
  `not_found`; a 2xx body that fails validation → `invalid`.
- `src/db/open.ts` degrades instead of failing: missing IndexedDB, a
  `blocked` open (3 s timeout), a corrupted/missing-store database or a
  `VersionError` all reset-or-skip the cache so the shell still renders
  server-only.
- The browser bundle imports nothing from `packages/gateway` or
  `packages/core`: no boot code, credentials, database, ACP or Git process
  control. Response types are re-declared as contracts in `src/contracts/`.
  (The Playwright *seed* script under `e2e/` is Node-only tooling and does
  load `@loreai/core`; it is not part of the bundle.)

## UX → component mapping

From the design fixture (v2.2) to Solid components. UI-01 ships the primitives
and the smoke page; the fixture and shell rows land in UI-02.

| Fixture element / §0 primitive | Component | Primitive / lib | Slice |
|---|---|---|---|
| Pane chrome (nav / list / detail), responsive collapse | `Shell` (`components/shell`), `PaneHead` | CSS grid + Tailwind `md`/`lg` breakpoints; one pane below `md`, nav drawer (`Dialog`) below `lg` | UI-02 |
| Project rows, knowledge rows | `Nav` items, `ListRow` | `<A>` (router, `aria-current`), `Badge` | UI-02 |
| Global search entry (placeholder) | `SearchEntry` | button + `Dialog` (Kobalte) explaining UI-04; icon-only below `md` | UI-02 (real in UI-04) |
| Connection status (checking / reachable / unreachable / unauthorized) | `ConnectionStatus` | `lib/connection.ts` store fed by the API client | UI-02 |
| Dark / light | `ThemeToggle` | `lib/theme.ts`: `.dark` on `<html>`, `color-scheme`, `localStorage` `lore.ui.theme`, follows the OS until toggled | UI-02 |
| Document-first detail, eyebrow labels | `KnowledgeDocument`, `DocHeader`, `Crumb`, `Tabs` | `.eyebrow`, `Badge` | UI-02 |
| Source block (message + tool blocks) | `Message`, `ToolBlock` | plain Solid, `Badge` | UI-02 (fixture only) |
| Anchor (stable passage id, `#anchor` in URL) | `Passage` (`id` prop) | `id` attribute + `SourceLink href="#…"` | UI-02 (fixture only) |
| Selection (selected passage), source links | `Passage selected`, `SourceLink`, `Quote` | `.passage-target`, `<A>` | UI-02 (fixture only) |
| Discussion indicator (collapsed), inline discussion (expanded replies) | `Passage marker`, `InlineDiscussion`, `Reply`, `Draft` | plain Solid | UI-02 (fixture only) |
| Focused discussion with source quote | `FocusSide` (`/ui/fixture?view=focus`) | side pane ≥ `lg`, full pane below; `Quote` + back-to-source link | UI-02 (fixture only) |
| Action menu (per passage / per finding) | `FutureActionRow` | `Button` group (all disabled) | UI-02 (fixture only, all disabled) |
| Coverage label (which sources a finding rests on) | `DocHeader trailing` ("Native transcript · linked") | text | UI-02 (fixture only) |
| Draft / saved / sent / unknown states, participant & scope labels | `NoteStateBadge`, `AuthorLine`, `ScopeLabel`, `Avatar` | `Badge` variants | UI-02 (fixture; `AuthorLine`/`ScopeLabel` also on real documents) |
| Empty / error / locked states | `StateCard kind="empty" \| "error" \| "locked"` | plain Solid, `role="alert"` for error/locked | UI-02 |
| Mobile navigation | `Shell` (`mobilePane`, back link, nav drawer) | Kobalte `Dialog` as a left sheet | UI-02 |
| Future actions (Save note, Ask agent, Explore separately, Start with selected context, Share finding) | `FutureAction` | `Button disabled` + "not available yet" | UI-02 (disabled) |
| Tables with sorting (sessions, knowledge) | — | `@tanstack/solid-table` | UI-04 |
| Long lists | — | `@tanstack/solid-virtual` | UI-04 / UI-06 |
| Local cache, drafts | — | `idb` | UI-03 |
| Charts (cost / compression / latency) | `PlotContainer` (Solid owns the container, Plot owns descendants) | `@observablehq/plot` | UI-05 (lazy) |

## Design tokens: website → UI mapping

The app shares the marketing website's design language. Token **names** are
the design-fixture v2.2 names (`--bg`, `--chrome`, `--mark`, …); token
**values** are copied from the website theme —
`packages/website/public/theme.css` (`:root` light palette and
`[data-theme="dark"]` dark palette) and `src/styles/starlight.css` (fonts,
header). Only semantic token values are copied, never the website's layout
or component CSS. Everything lives in `src/styles/app.css` (`:root`, `.dark`,
`@theme inline`) and `src/styles/fonts.css`. Keep this table and that file in
sync.

Raw brand palette (identical in both themes, exactly as on the website):
`--c0 #f7f2e8`, `--c1 #ede5d0`, `--c2 #dfd5bb` (cream); `--g0 #1a3320` …
`--g6 #e8f2e9` (greens); `--ink #1a2e1b`, `--mid #4a5f4c`.

| Website variable (`theme.css`) | Light value | Dark value | UI token (`app.css`) | Tailwind utility |
|---|---|---|---|---|
| `--bg` | `--c0` | `#0d1913` | `--bg` | `bg-bg`, `bg-background` |
| `--surface` | `--c0` | `#14251b` | `--surface` | `bg-surface`, `bg-card`, `bg-popover` |
| `--surface-alt` | `--c1` | `#1a3124` | `--chrome` | `bg-chrome`, `bg-secondary` |
| `--bg-alt` | `--c1` | `#101f17` | `--nav`, `--shade` | `bg-nav`, `bg-shade` |
| `--border` | `--c2` | `#26402f` | `--line` | `border-line`, `border-border`, `border-input` (and the base `*` border colour) |
| `--text` | `--ink` | `#e8f1e6` | `--text` | `text-text`, `text-foreground` |
| `--text-muted` | `--mid` | `#9fbaa6` | `--muted` | `text-muted`, `text-muted-foreground` |
| `--heading` | `--g0` | `#f2f7ee` | `--heading` | `text-heading` (base `h1`, `h2`) |
| `--link` | `--g2` | `#a6d6ae` | `--accent` | `text-accent`, `ring-ring` (base `a`) |
| `--link-hover` | `--g0` | `#dcecdd` | `--accent-hover` | `text-accent-hover` (base `a:hover`) |
| `--link-border` | `--g4` | `#4a7a55` | `--thread` | `border-thread` (discussion thread line) |
| `--inverse-text` (light) / `--bg` (dark) | `--c0` | `#0d1913` | `--accent-contrast` | `text-accent-contrast`, `text-accent-foreground` |
| `--highlight-bg` | `--g6` | `#172c20` | `--soft`, `--accent-soft`, `--mark`, `--avatar-bg` | `bg-soft`, `bg-accent-soft`, `bg-mark`; `.passage-target` |
| `--highlight-text` | `--g2` | `#bfe0c4` | `--accent-soft-text`, `--avatar-text` | `text-accent-soft-text` |
| `--eyebrow` | `--g3` | `#79ab84` | `--mark-edge`, `--quote-edge` | `text-mark-edge`, `border-quote-edge`; `.eyebrow` |
| `--emphasis` | `--g1` | `#9ad3a4` | `--emphasis`, `--gold` | `text-emphasis`, `text-gold` |
| `--inverse-bg` | `--g0` | `#1e3a29` | `--inverse-bg`, `--avatar-agent-bg` | `bg-inverse`, `bg-primary` (filled buttons, fixture banner) |
| `--inverse-bg-hover` | `--g1` | `#26492f` | `--inverse-bg-hover` | `bg-inverse-hover` |
| `--inverse-text` | `--c0` | `#f2f7ee` | `--inverse-text`, `--avatar-agent-text` | `text-inverse-text`, `text-primary-foreground` |
| `--inverse-text-dim` | `--g5` | `#c4ddc7` | `--inverse-text-dim` | `text-inverse-text-dim` |
| `--error` | `#8b3a3a` | `#e39393` | `--danger` (+ derived `--danger-soft`, 10 % mix over `--surface`) | `text-danger`, `bg-danger-soft`, `bg-destructive` |
| `.card` shadow `0 4px 14px rgba(26,51,32,.06)` | as is | `0 4px 14px rgba(0,0,0,.28)` | `--shadow-soft` | `shadow-xs`, `shadow-sm`, `shadow-md` |
| `.feature` shadow `0 16px 48px rgba(26,51,32,.08)` / `.modal` shadow `0 14px 34px rgba(0,0,0,.38)` | `.feature` | `.modal` | `--shadow-lifted` | `shadow-lg`, `shadow-xl` |
| `--sans` `"DM Sans", sans-serif` | | | `--font-sans` (`"DM Sans Variable", "DM Sans", sans-serif`) | `font-sans` (base `html`) |
| `--serif` `'Playfair Display', Georgia, serif` | | | `--font-serif` | `font-serif` (logo wordmark) |
| `starlight.css --sl-font-mono` | | | `--font-mono` | `font-mono` |
| radii: website buttons/cards 3–6 px, pills 20 px | | | `--radius-sm 4px`, `--radius-md 6px`, `--radius-lg 10px`, `--radius-xl 14px` | `rounded-sm/md/lg/xl` |

Not mapped on purpose: `--nav-bg` (the website's dark marketing header — the
app keeps a light chrome bar so the pane hierarchy stays quiet), gradients,
hero/orbit illustrations, and every layout rule.

**Fonts** are self-hosted from `@fontsource-variable/dm-sans` and
`@fontsource/playfair-display` (OFL-1.1) via hand-written `@font-face` rules
in `src/styles/fonts.css` (latin + latin-ext woff2 only, ≈190 kB) so the
strict CSP (`font-src 'self'`) holds and the UI works offline; Vite hashes
the files into `dist/assets/` and the gateway stages them with the rest.

**Logo / favicon**: `src/assets/logo/loreai.svg` (light) and
`loreai-dark.svg` (dark) plus `public/favicon.svg` are byte-for-byte copies
of `packages/website/src/assets/logo/*` — no cross-package import. The
`Logo` component (`components/shell/Logo.tsx`) picks the file from the
resolved theme, and `index.html` links `/ui/favicon.svg`.

## Layout

```
packages/ui/
  index.html              Vite entry (served as /ui/index.html by the gateway)
  src/index.tsx           mounts <App/>
  src/app.tsx             Router (base /ui) + route table
  src/routes/             Browse.tsx (real data), Fixture.tsx (/ui/fixture), workspace.tsx (provider)
  src/components/shell/   Shell, AppBar, Nav, SearchEntry
  src/components/shell/Logo.tsx  theme-aware Lore logo (copied website SVGs in src/assets/logo)
  src/components/lore/    document primitives (Document.tsx), KnowledgeDocument, Panes, StateCard, FutureAction, Avatar
  src/components/reader/  SessionBlock.tsx — message / part / distillation rendering (the only innerHTML sink)
  src/reader/             blocks.ts (block model), anchors.ts (source anchors), render.ts (per-part LRU), specimen.ts (dev fixture data)
  src/components/ui/      copied Solid UI primitives (owned source, see ATTRIBUTION.md)
  src/compat/             compatibility smoke page + probes
  src/lib/                api.ts (typed client), loader.ts, connection.ts, theme.ts, format.ts, utils.ts, hash.ts, safe-html.ts (Markdown/code sanitising boundary)
  src/contracts/          ArkType response contracts (relative imports only) + ContractError
  src/db/                 IndexedDB: schema/open/repository (+TTL/LRU)/local stores/limits
  src/state/              Solid state: entity store, cursor pages, projects/knowledge/sessions, cache status
  src/styles/app.css      Tailwind 4 + Lore tokens (values from the website theme, see mapping above)
  src/styles/fonts.css    self-hosted DM Sans / Playfair Display @font-face
  public/favicon.svg      copied from the website
  test/                   Vitest (jsdom) unit tests
  e2e/                    Playwright specs + gateway.mjs / seed.mjs (built-gateway harness)
```
