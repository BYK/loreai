# Quest journal and website design

The user approved the interactive quest-journal preview and Quiver artwork on
6 November 2026, and requested replacing the 3D camp and applying the same
direction across the website in PR #2115. This records that approved design.

## Intent

Explain how conversation becomes reviewable project knowledge and how relevant
knowledge helps a later task. Use an RPG field-journal interface with the local
app's functional typography, olive surfaces, amber selection, and compact controls.

## Approaches

The conversation considered a quest journal, knowledge inventory, branching
dialogue, agent-party handoff, and guild noticeboard. The user selected and tried
the quest journal with knowledge cards, then approved its Quiver illustrations.
The 3D camp is replaced, including its renderer and dependencies.

## Interaction

- Three freely selectable chapters: conversation, knowledge, next task.
- Three illustrated knowledge cards: webhook decision, settings pattern, SQLite
  import gotcha. Each has a readable rule and native expandable source note.
- Selecting a next task highlights its relevant card and changes the example
  response; selecting a card opens its knowledge chapter.
- Native radios and CSS preserve chapter/card/task selection without JavaScript.
  Enhanced state is shareable with allowlisted `chapter`, `entry`, and `task`
  query parameters. One interaction creates one history entry. Reload and
  Back/Forward restore all three choices without dropping other query/hash data.
- Valid URL choices override defaults; without them an early native choice
  survives delayed module initialization. Keyboard focus remains visible and
  usable when navigation hides its previous control.
- Explicit fictional-example labels. No live agent connection, guaranteed
  immediate extraction, or automatic team-sync claim.

## Website application

- Home: clear existing product headline and install action above a full-width
  journal; actual app screenshot remains separate evidence.
- Tour: chapter-style native navigation, existing real app screenshots and URLs.
- Setup: compact field-guide frame and step markers; existing six clients,
  commands, URL/history state, copy behavior, telemetry and provider details stay.
- Docs: shared illustrated title treatment, readable field-guide sidebar and
  pagination; keep search, native headings, fragments, and generated parity.
- Blog: journal masthead, editorial rows, small illustrated takeaway; retain
  article outline, metadata, content, and next steps.
- Why Lore, workflow, FAQ, and footer: consistent margins, panels, selection
  marks, and a restrained amount of the same artwork. Keep familiar labels.

## Constraints

- Use existing Astro/Starlight and DM Sans; preserve the compact Light/System/Dark
  icon pill, mobile navigation, signup semantics, and actual-app captures.
- Ship the four static Quiver SVGs locally, with provenance. No external assets,
  script-bearing SVGs, new account flow, or Quiver runtime dependency.
- No idle animations; short user-triggered movement only. Reduced-motion and
  keyboard interactions do not move content unnecessarily.
- Fit 320px and desktop in both themes; use native focus and touch controls.
- Remove unused camp source, unit/browser tests, Three.js and its types.
- Keep the same PR and branch; do not merge or mark ready without instruction.

## Verification

Browser regressions cover chapters, cards/source, relevance, native/no-JS use,
URL/history, delayed initialization, malformed parameters, keyboard focus,
reduced motion, local image loading, all public surfaces, and preview prefixes.
Run website units/browser suite, typecheck/lint/format, Astro, builds, generated
docs, metadata and links. Obtain separate correctness and security reviews,
update screenshots and PR description, push and inspect hosted CI.
