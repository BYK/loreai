# Website clarity and first-use journey

Approved scope: the user accepted all twelve critique ideas in this chat and
asked to include them in existing PR #2115. Implementation stays in the existing
Astro/Starlight website, with the current olive/amber palette and bundled fonts.

1. Put explanation and installation before decorative content on mobile.
2. Replace the orbit with a clearly fictional decision → saved knowledge → recall example.
3. Use concrete, qualified product copy rather than absolute promises.
4. Make installation the primary path, with explicit copy behavior and next steps.
5. Shorten the homepage into introduction, example, workflow, setup, evidence and FAQ.
6. Distinguish current git-based memory from Folk Lore early access.
7. Scope benchmark results to the published five-day session and link methodology.
8. Lead docs through choosing a client, installing, connecting and verifying; preserve
   all existing installation/telemetry/cleanup reference content and old anchors.
9. Use compact blog typography/rows; render noninteractive tags as metadata.
10. Share primary navigation and active states; compact native theme disclosure.
11. Handle clipboard denial, release lookup failure and signup outcomes honestly.
12. Remove the ticker, orbit and scroll reveals; retain motion only for useful feedback.

Build-time components own shared navigation, footer, install snippet and signup copy.
Client code retains a single theme controller, native details enhancements, fixed
clipboard strings and the existing newsletter endpoint. No API/backend or permission
changes. Example content must not imply a live session or a guaranteed recall.

Preserve public URLs, referenced legacy fragments, RSS, social metadata and docs
reference access. No new dependencies. No deployment or merge is requested.


## Graph revision approved later in the same chat

The user asked to restore the graph treatment, specifically referencing the
interactive 3D voxel “I” in the Hackweek project. This supersedes the earlier
removal of the orbit. The user clarified that this must preserve the live Lore graph: a round central
Lore hub, rounded satellite nodes, orbital rings and curved connections. Do not
create an L or other letter sculpture. Give that familiar craft real WebGL depth,
pointer-responsive motion, a pause control, and a matching static SVG. Keep the first action above the artwork on mobile.
Retain the clearly fictional example through native, keyboard/touch stage controls.
Respect reduced motion, hidden/offscreen pages, failed loading and WebGL loss.
Use the pinned Three.js and type versions from the reference; no React runtime.
The Hackweek repository is a read-only visual/behavioral reference.
