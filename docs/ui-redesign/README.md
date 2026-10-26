# UI workspace redesign

The current theme uses Tailwind amber accents and an olive foundation in both
light and dark mode. Owned Solid/shadcn components continue to consume semantic
roles, so pages do not name palette colors directly.

## Changing the palette

Edit the two scales at the top of `packages/ui/src/styles/app.css`:

- `--palette-base-50` through `--palette-base-950` reference Tailwind olive.
- `--palette-accent-50` through `--palette-accent-950` reference Tailwind amber.

Replace the family references throughout a scale to select another family.
The light/dark role mappings below those scales select the appropriate shades.
Buttons, links, focus rings, native controls, selections, passage highlights,
syntax accents, and avatars derive from those roles. Card, popover, sidebar,
input, secondary, border, text, and elevation roles derive from the base scale.

| Role | Light | Dark |
| --- | --- | --- |
| Outer background | Olive 100 | Olive 950 |
| Document/card surface | Olive 50 | Olive 900 |
| Raised/secondary surface | Olive 100 | Olive 800 |
| Default text | Olive 900 | Olive 200 |
| Secondary text | Olive 600 | Olive 400 |
| Actions, links, focus | Amber 700 | Amber 400 |
| Hovered accent | Amber 800 | Amber 300 |
| Selected background | Amber 50 | Amber 950 |
| Selected text | Amber 800 | Amber 200 |

The logo SVGs, categorical model chart palette, and green/red version diffs
remain unchanged. Cost bars, warming histograms, and quota bars use independent
`--chart-accent` / `--chart-emphasis` tokens with their previous green values.
Destructive states retain their red tokens.

## Layout and verification

Desktop opens with labeled navigation. The Compact navigation button switches to
icons and persists this optional preference separately from context-pane collapse.
Missing, invalid or blocked browser storage keeps navigation usable, defaulting to
labels. Desktop account controls keep their popover; compact mode does not change
the mobile drawer or context-pane behavior. Below 768px, a
logo-free toolbar button opens a labeled sliding drawer and the document uses
the full viewport width. The mobile account row is fully tappable, its panel
aligns with the drawer, and theme controls have 44px touch targets.

Knowledge tables give titles and two-line content previews most of the width;
category, visibility, dates and confidence remain available. The project directory
groups checkouts only when they share a nonempty recorded git remote. Each checkout
keeps its own destination; unattributed projects stay separate. Recent activity,
Name and Knowledge count sorts are presentation controls, not project merges.

The knowledge reader keeps Filter this list above a compact Filters/sort row. A labeled
filter panel applies category and scope together, with explanations for project,
shared, and global visibility. Desktop shows applied filters as removable chips;
clearing them preserves the selected entry and sort order. On mobile, chips are hidden
and Clear all lives inside the filter sheet, leaving the toolbar compact. The
badge still reports applied filters. Both directions are available
for updated/created date, title, and confidence. Existing multi-column sorts from
the table remain intact. Desktop keeps its anchored popover. Below 768px, Filters
opens a full-width bottom sheet with a backdrop, a 44px close control, scrollable
fields, and a fixed action row with safe-area padding. Sheet motion follows the
reduced-motion preference. Nested selectors use modal accessibility scopes, and
closing/resizing restores focus to the current visible control. Short-screen
coverage includes 320×480 portrait and 568×320 landscape viewports.

On mobile, the reader's Filters trigger is a 44px icon button with an applied
filter count. Both layouts show a high-contrast amber number badge for applied
filters, including search, and announce the count to screen readers. Shared sheet
close icons are centered in 44px targets, inset 4px from the top-right corner.
Sorting opens a choice sheet, marks the current sort, and applies only after a
choice is activated; arrow navigation and dismissal preserve the
query. The same owned `ResponsiveSelect` is used for knowledge table category,
scope, and project filters, project search scope, entity type, and model usage
project selection. Desktop dropdowns keep their existing layout.
`BottomSheetContent` centralizes motion, safe areas, and scrolling, while the shared responsive overlay restores focus when a menu closes
or changes presentation across the breakpoint. The searchable project switcher
and controls already inside dialogs retain their specialized interactions.

## Search and everyday workflows

Filter this list narrows the current knowledge table or reader list. Its visibility
choices (This project, Project-only, Shared knowledge and Project + shared) are
independent of recall scopes. Workspace tables name their broader coverage.
Search this project's memory uses recall; Search knowledge across projects searches
stored knowledge only, and directs users to project memory for conversations and
summaries. Readable recall labels preserve their raw query values:

| Query value | Label | Coverage |
| --- | --- | --- |
| `all` | All memory | Project memory plus other-project knowledge/repository discovery |
| `session` | Conversation history | Messages and summaries across project sessions; this UI selects no session |
| `project` | Project memory | Conversations, summaries, visible knowledge/entities and recorded memory files |
| `knowledge` | Knowledge and memory files | Visible knowledge and recorded memory files, without conversations or entities |

Search results identify their submitted scope, and empty search/filter views offer
browse or reset actions. Navigation and review headings use Team proposals,
Conflicting instructions and Sync recovery while keeping the existing routes.
Review queues describe the current view rather than claiming all work is complete.

Project overviews lead with recent knowledge and sessions. Configured sharing uses
a compact summary with an expansion control; incomplete or blocked setup remains
visible. Sync labels distinguish configuration, running, completion and blocked
states without inventing a last-success time. Count-derived information is labeled
Memory summary. Team management starts with Members and Invite teammate, with
Invitations and Settings sections retaining account/discovery tools. Knowledge and
session readers expose implemented actions; roadmap placeholders are removed.

## Not-found recovery

Unknown client routes use the same workspace shell, keeping the desktop rail and
mobile drawer available. The page provides Browse projects and Search knowledge
links using owned shadcn buttons, and shows a project return card only after the
workspace confirms the project from the route. Invalid, unknown, or pending
project IDs retain global recovery links. Rejected addresses and query values
are not echoed. Authentication and deleted-knowledge states retain their own
existing handling. Both variants use the semantic olive/amber theme and have
44px actions, wrapping labels, and internally scrollable short-screen layouts.

## Action feedback and icons

The owned shadcn `Button` accepts `icon` and `pending`. Pending buttons disable
activation, expose `aria-busy`, and replace their leading icon with the shared
loading glyph. Motion is limited to pending indicators and follows reduced
motion. Features still own their requests, errors, and confirmed receipts.

`createClipboard` provides shared pending, copied, and error feedback. Pass a
reactive source identity so selection, session, account-dialog, and invite changes
invalidate old results. Duplicate pending writes are ignored; completion is
announced only after `writeText` resolves. Errors retain a manual-copy fallback,
and disposal clears timers and suppresses late feedback. The icon registry supplies
consistent decorative SVGs for copy/link/save/sync actions, sort direction,
search controls, dialog close buttons, and loading/empty/locked/error states.

## Screenshot comparison

The accompanying PR contains before/after comparisons for desktop and mobile in
both themes, including navigation, readers, tables, overview and team workflows.
Screenshots are attached to the PR rather than committed as build artifacts.

Screenshots use the disposable database seeded by the UI browser tests.
`responsive-layout.spec.ts` audits 24 routes at 1440, 390, and 320px in both
themes. `palette.spec.ts` verifies actual component colors, text contrast,
live palette propagation, and independent chart colors on desktop and mobile.
`folk03.spec.ts` covers populated team, promotion, and conflict layouts.
`folk-status.spec.ts` covers light/dark account and navigation panels.
`workspace-shell.spec.ts` and `model-usage.spec.ts` capture readers and charts.
Rebuild the gateway bundle before regenerating production-route screenshots.

The team captures include organization/invitation forms. All captures use a
throw-away seeded database and synthetic account/team data; no personal account,
credentials, or production database is used. Before and after use the same
fixtures, viewport, and theme, with real builds of the base and redesign UI.
