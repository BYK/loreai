# Intentional UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make all nine approved UI improvements concrete and consistent in a reviewed PR with screenshots.

**Architecture:** Keep routes and API contracts stable. Improve content hierarchy and use shared pure helpers for grouping/search labels. Existing state owners retain mutation, auth and stale-response protection.

**Tech Stack:** TypeScript, Solid, Vite, owned UI components, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-10-26-intentional-ui.md

## Global Constraints

- No added dependencies, backend/schema changes or production-data mutations.
- No invented sync guarantees, timestamps, project totals or team-wide content.
- Preserve ownership/auth/generation/revision guards and explicit sharing consent.
- Solid/Vite, existing owned UI components and olive/amber semantic tokens.
- Narrow/mobile layouts, keyboard use, focus restoration and reduced motion work.
- Do not merge this PR.

## Review Focus

- Grouped checkouts remain individually discoverable when a filter matches an older child.
- Project/team changes during pending work cannot expose stale mutations or receipts.
- Connected but blocked sync must expand recovery rather than look completed.
- Search labels reflect actual API semantics and survive query/history navigation.
- Navigation and tabs remain usable at 320px and with keyboard input.

### Task 1: Content-first browsing and project discovery

**Files:** Modify KnowledgeTable.tsx, ProjectDirectory.tsx, KnowledgeDocument.tsx,
reader/SessionView.tsx under packages/ui/src/components; add a small pure project
directory grouping helper under packages/ui/src/lib; related UI tests/e2e.

**Interfaces:** Consumes ProjectSummary, byRecency, existing href/query helpers.
Produces presentation-only grouping and sort logic used by ProjectDirectory;
existing component public props stay compatible.

- [ ] Write focused failing behavioral tests for repository grouping, name collisions,
  older-child filter matches, sort determinism/nonmutation and unattributed records.
- [ ] Implement group-by-exact-nonempty-recorded-remote, local/unattributed sections,
  three usable sorts, and individual checkout links. No data merging/count invention.
- [ ] Make knowledge title/content dominate the table width; readable two-line
  previews, compact metadata, real entry links supporting modified clicks, retain
  keyboard selection and paging. Remove production FutureActionRow calls in both
  knowledge/session readers while retaining real actions and source details.
- [ ] Improve directory/filter empty-state next actions and capture guidance using
  existing capabilities; do not add a fake import button.
- [ ] Run focused tests, UI typecheck and relevant format/lint checks. New
  meaningful behavior gets regression coverage; CSS-only layout uses browser QA.
- [ ] Commit and self-review. Write report with RED/GREEN commands, file list and
  concerns; no other subagents, no push/PR, no full backend suite.

### Task 2: Everyday overview and focused team management

**Files:** Modify ProjectPage.tsx, SharingPanel.tsx, SharingSync.tsx, TeamPage.tsx,
ImportHistoryPage.tsx, lib/folk-status.ts and relevant UI tests/e2e. Extract small
presentation components if needed; preserve existing state ownership.

**Interfaces:** Consumes Task 1 readable lists and existing workspace loaders,
FolkState, sharing/membership contracts. Keeps existing routes and action guards.

- [ ] Write focused failing tests for compact connected/configured sharing,
  expanded incomplete/blocked recovery, explicit expand/collapse, overview recent
  knowledge and team Members/Invitations/Settings selection.
- [ ] Show compact sharing after setup with clear team, sharing choice and sync
  configuration; surface live errors/setup without hiding required recovery.
  Reuse SharingSync semantics; do not duplicate mutation handlers or opt in.
- [ ] Replace health claims with Memory summary. Add up to five recent knowledge
  entries via existing workspace knowledge loader; put useful activity early.
- [ ] Organize Team page into Members, Invitations and Settings with URL tab state,
  primary Invite teammate, visible member roster first, advanced organization/
  discovery/account-ID controls in Settings, and create/join recovery when no team.
  Preserve role restrictions, confirmation, focus and stale-account/team guards.
- [ ] Make status wording distinguish configured/running/result/error, without
  inventing last-success time. Add actionable empty import/history/team guidance.
- [ ] Run focused tests, UI typecheck and relevant lint/format. Check pending,
  account/team change, viewer, no-team and narrow layouts; update existing e2e
  assertions only where intended copy/interaction changed.
- [ ] Commit, self-review, report RED/GREEN evidence and concerns; no subagents,
  push/PR or full backend reruns.

### Task 3: Navigation and unambiguous search

**Files:** Modify shell/Rail.tsx, Shell.tsx, SearchEntry.tsx, navigation.ts;
KnowledgeTable.tsx, ProjectPage.tsx, SearchResults.tsx, WorkspaceSearch.tsx,
PromotionsPage.tsx, ContradictionsPage.tsx and ConflictsPage.tsx; relevant tests.
Add small shared label/description helpers under lib as necessary.

**Interfaces:** Consumes Task 1 table, Task 2 overview and team structure. Existing
route paths, query values and API semantics stay unchanged; shared labels drive
navigation and page headings consistently.

- [ ] Write focused failing tests for desktop labeled/compact navigation, safe
  preference persistence, readable recall labels with unchanged submitted values,
  clear filter/search scope and consistent review destination headings.
- [ ] Add labeled desktop navigation with a user-controlled compact mode. Preserve
  mobile drawer, context-pane behavior, modified links and focus restoration.
- [ ] Use Team proposals, Conflicting instructions and Sync recovery in shared nav
  metadata and matching headings. Include short explanations, preserve URLs.
- [ ] Share readable recall-scope labels/descriptions; inspect real backend semantics
  before naming session/project scope. Clearly label local knowledge filters,
  project memory search and workspace knowledge search; make scope visible beside
  results and give empty search a relevant reset/browse action.
- [ ] Run focused tests, full UI suite once, typecheck/lint/format, self-review and
  commit. Report evidence/concerns; no subagents or push/PR.

### Task 4: Integrated QA, screenshots and PR

**Files:** Existing changed code/tests as review finds necessary; PR description
and docs/ui-redesign/README.md for final behavior documentation.

**Interfaces:** All task reports and committed implementation. No new feature scope.

- [ ] Independently review the whole branch for correctness, security, DRY and gaps;
  resolve actionable findings with failing-first regressions and scoped re-review.
- [ ] Run required workspace checks/full suite/property stability once in final
  review; record known backend/environment failures honestly, use CI for Linux.
- [ ] Browser QA production pages with fictional fixtures at desktop/390/320px,
  light/dark, keyboard and relevant pending/error/empty/expanded states.
- [ ] Capture actual main and branch before/after pairs at identical framing;
  inspect every image, pixel-compare, upload via gh --attach, never commit images.
- [ ] Create and attach draft PR; address CI and bot feedback. Preserve screenshots
  through description edits and retake affected captures after visual fixes.
- [ ] Mark ready for review after validation/review, leave unmerged and report the
  PR, screenshot preview, checks and material limits.
