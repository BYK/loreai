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


## Sculpture redesign after visual feedback

The user rejected the initial glossy hub-and-spoke rendering and explicitly gave
freedom to change the form to make it more appealing. Replace that treatment with
a woven, three-lobed 3D memory path built from small jade/ivory tiles and connected
faceted anchors. Keep the graph concept, pointer depth, stage exploration, static
fallback and motion safeguards. This supersedes the earlier requirement to retain
literal concentric rings and a large round central hub. No letter sculpture.


## Research-led interaction refinement

The user requested online research and further improvement. Make the sculpture
select actual example stages through a click/tap, with the matching native radio
focused after touch compatibility events. Keep keyboard/static stage choices.
Add bounded, damped local tile lift, softer edges and settling stage colours.
Dragging or cancellation must preserve the current stage, and paused rendering
must stop after feedback settles. Motion clarifies the selected example; content
updates immediately on input.


## Approved interactive landscape

The user selected the refined memory landscape after comparing visual previews.
This supersedes the sculpture directions above. Keep the three terraced hills,
sage/jade/ivory palette, brass trail and landmark labels. Clicking or tapping a
whole terrain region activates its corresponding Conversation, Knowledge or Recall
stage and highlights that region. Native stage controls update the terrain in
return. Dragging rotates without selecting, with keyboard rotation and reset
controls. Use a brief trail for user-driven forward stage changes; no idle loop.
The matching SVG and native controls cover reduced motion, low memory, unavailable
WebGL and no JavaScript. Add this approved design to existing PR #2115.

The user subsequently requested removing the Rotate slider and Reset view button.
Keep drag rotation and region/stage selection; remove the extra view controls.

## Elevation as refinement

The user requested removing peak checkpoints and using lower, middle and upper
terrain to explain refinement and task relevance. Preserve the approved landscape
silhouette and drag interaction. My implementation choice is three elevation bands
across all hills (below 25, 25–50, and 50+ scene units), rather than assigning a
stage to each hill. Lower layers represent conversation, middle layers distilled
knowledge, and upper layers context relevant to a current task. Click/tap a band
to select its native stage; native controls highlight the band in return.
Remove pins, floating peak labels and the inter-peak route. Show refinement in the
example text, including an unrelated tangent that is absent from the selected
stored knowledge. Describe relevance ranking and a context budget without claiming
perfect filtering of every prompt or removal of recent raw conversation.

## Animated refinement and a continuous terrain

The user requested animated transitions that show conversation refining into relevant
knowledge, and a different terrain shape. Replace the three-hill form with one
asymmetric, terraced landform: broad lower contours taper into a single summit.
On user selection, sweep the highlight between elevation bands and carry small
abstract fragments upward; progressively fewer survive toward the summit. Fragments
are illustrative and transient, not checkpoint markers or real record counts.
No idle loop. Selection/content updates immediately; rapid selections retarget from
the visible transition. Reduced motion is immediate. Hidden/offscreen states and
context loss settle to the selected stage and release/cancel temporary motion.

The user requested changing the terrain again. Replace the mound with a winding
ridge: broad, bent lower terraces taper to an elongated upper crest. Keep elevation
selection and the refinement animation. Shared inverse coordinates keep moving
fragments on the reshaped terraces; full camera-envelope checks still apply.

## Two project islands

The user requested two islands with terrain showing knowledge moving between
projects. Use distinct Payments and Orders landforms separated by a visible gap.
Keep elevation refinement; when Relevant is selected, carry the retained fragments
from Payments across a quiet arc to Orders. Labels sit below the islands, without
peak checkpoints. The fictional example shares an idempotency pattern, not a claim
that one project's private transcript or code is copied into another. Cross-project
reuse depends on knowledge scope and configuration. Preserve native/static controls,
reduced motion, interruption handling and full camera-envelope coverage.

The user preferred the original rolling, multi-peak terrain. Restore that exact
height profile on both islands (mirrored for the receiving project), preserving
the two-project transfer story. Use front-slope surface paths and mesh-derived
upper crests for launch/arrival; keep camera and footprint-clearance checks.
