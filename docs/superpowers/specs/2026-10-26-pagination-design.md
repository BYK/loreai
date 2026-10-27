# Consistent pagination

The user approved compact text-and-chevron controls in main views and icon-only controls in the narrow reader session sidebar. Use the existing Solid Button, Icon and Tooltip primitives, with a shared presentational pagination component. Group controls at the right edge; visible labels are First, Previous and Next, with full accessible page labels. First remains secondary. Use 44px mobile targets and visible keyboard focus. Compact controls retain accessible labels and hover/focus tooltips.

Alternatives considered: plain links preserve current navigation but look unfinished; icon-only everywhere saves space but makes main-view actions harder to understand. The approved mixed approach keeps readable main controls and compact sidebar controls.

Apply to knowledge, sessions, reader session context, entities and import history. Preserve all existing cursor/history, filtering, sort, URL base, selected transcript and source-anchor behavior; expose only actions the caller already supports. No numbered pages, invented totals, API/dependency/backend changes, sidebar expansion or changes to append-style Load more actions. Duplicate-group navigation and invalid-link recovery actions are separate interactions.

The request to implement the shown proposal is the design approval. Add actual frontend screenshots to existing PR #2110 and keep it ready for review, without merging.
