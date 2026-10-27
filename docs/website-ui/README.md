# Website UI and first-use journey

The website uses the local memory browser’s olive foundation, amber accents and
self-hosted fonts. The first-use flow now leads with concrete product copy,
installation and a clearly fictional memory example. Shared navigation and compact
native theme menus give every section a consistent structure.

The homepage presents the workflow, current Git-based sharing, one scoped historical
benchmark and practical FAQs. Folk Lore is explicitly early access. The setup guide
leads through client selection, installation, connection and verification; detailed
installer/telemetry/uninstall content and old reference fragments remain reachable.
The blog uses compact article rows and noninteractive topic metadata. The ticker
and scroll reveals are removed. The homepage’s adventurer camp connects three
landmarks: campfire (Conversation), scribe’s desk (Knowledge), and quest gate
(Next session). Clicking or tapping a landmark selects its native stage control
and updates the fictional example; the controls select the landmark in return.
A small traveller carries a scroll along the stone path when pointer selections
change, then stops. Keyboard selection is immediate. The camera stays fixed.

The server-rendered SVG uses the same camp meshes and camera as WebGL. Native
controls work without JavaScript; static landmarks remain clickable with reduced
motion, low device memory, or unavailable/lost WebGL. Hidden/offscreen states stop
rendering, and disposal releases GPU resources. Clipboard failure, release lookup
failure, signup timeout/retry and menu focus have explicit browser regressions.

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


The additional camp captures below use normal motion at 1280×1000 with the
same fixed release response. The scene is settled; the dark image is a direct
component screenshot after selecting Knowledge. The comparison table above uses
reduced motion and shows the SVG fallback.

![Adventurer camp, desktop light](screenshots/camp-desktop-light.png)
![Camp detail, dark](screenshots/camp-detail-dark.png)

The interaction draws on [Emil Kowalski’s pointer and easing examples](https://emilkowal.ski/ui/good-vs-great-animations)
and [NN/G’s guidance on motion for comprehension](https://www.nngroup.com/articles/animation-usability/).
These informed direct selection, finite travel and immediate example text.
Landmark picking uses the existing Three.js package’s
[raycaster](https://threejs.org/manual/en/picking.html).
