# Website UI and first-use journey

The website uses the local memory browser’s olive foundation, amber accents and
self-hosted fonts. The first-use flow now leads with concrete product copy,
installation and a clearly fictional memory example. Shared navigation and compact
native theme menus give every section a consistent structure.

The homepage presents the workflow, current Git-based sharing, one scoped historical
benchmark and practical FAQs. Folk Lore is explicitly early access. The setup guide
leads through client selection, installation, connection and verification; detailed
installer/telemetry/uninstall content and old reference fragments remain reachable.
The blog uses compact article rows and noninteractive topic metadata. The ticker and scroll reveals are removed. The homepage’s landscape has two project islands: Payments (source knowledge) and
Orders (the current task). Each has terraced refinement bands. Native stages or
terrain clicks move from conversation to curated knowledge to relevant shared
context. During refinement, transient fragments thin out and climb the source
island; retained fragments travel across a quiet arc from crest to crest and arrive
on the receiving island. Both islands use the original rolling, three-peak terrain, mirrored for the receiving project.
Project captions sit below them, without peak markers. The example shares a reusable
idempotency pattern, not project-specific history; scope and configuration qualify
cross-project reuse. The moving fragments are illustrative, not actual record counts.
Rapid choices retarget the displayed transition; interruption settles it. Reduced
motion uses the finished SVG state. Dragging rotates both islands without selecting;
there is no idle loop. Camera and fragment-clearance tests cover the full animation and drag range,
lower walls, bevels and the transfer arc.

The server-rendered SVG shares the terrain contours, camera and elevation bands
with WebGL. Native controls remain usable without JavaScript; clicking the SVG
terraces also works when reduced motion, low device memory or GPU failure keeps the
static view. Hidden/offscreen states stop rendering, and disposal releases GPU
resources. Clipboard failure, release lookup failure,
signup timeout/retry and menu focus have explicit behavior and browser regressions.

See [the website package](../../packages/website/README.md) for maintenance and tests.

These are original Chromium screenshots of the built frontends. Before uses
upstream `82e1af50`; after uses this PR. Both builds use the same viewport, system colour preference,
and reduced-motion preference.
The GitHub release response is fixed to `0.34.0` for a stable badge. No DOM, CSS,
or image edits were applied to the captures. Desktop is 1280×900; mobile is
320×844.

| Surface | Before | After |
| --- | --- | --- |
| Homepage · desktop light | ![Before](screenshots/home-desktop-light-before.png) | ![After](screenshots/home-desktop-light-after.png) |
| Homepage · mobile dark | ![Before](screenshots/home-mobile-dark-before.png) | ![After](screenshots/home-mobile-dark-after.png) |
| Docs · desktop dark | ![Before](screenshots/docs-desktop-dark-before.png) | ![After](screenshots/docs-desktop-dark-after.png) |
| Docs · mobile light | ![Before](screenshots/docs-mobile-light-before.png) | ![After](screenshots/docs-mobile-light-after.png) |
| Blog · desktop light | ![Before](screenshots/blog-desktop-light-before.png) | ![After](screenshots/blog-desktop-light-after.png) |


The additional landscape captures below use normal motion at 1280×1000 with the
same fixed release response. The terrain is settled; the dark image is a direct
component screenshot after selecting the receiving project’s Relevant stage through the terrain. The
comparison table above uses reduced motion and shows the SVG fallback.

![Interactive landscape, desktop light](screenshots/landscape-desktop-light.png)
![Landscape detail, dark](screenshots/landscape-detail-dark.png)

The interaction draws on [Emil Kowalski’s pointer and easing examples](https://emilkowal.ski/ui/good-vs-great-animations)
and [NN/G’s guidance on motion for comprehension](https://www.nngroup.com/articles/animation-usability/).
These informed direct stage selection, damped feedback and immediate example text.
Region picking uses the existing Three.js package’s
[raycaster](https://threejs.org/manual/en/picking.html).
