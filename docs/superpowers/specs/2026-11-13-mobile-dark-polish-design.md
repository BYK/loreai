# Mobile and dark-mode polish

Approved direction: implement all seven findings in the 13 November visual QA, in PR #2115. Retain the floating field guide, RPG journal, app palette, real screenshots and native controls.

## Approach
Refine the existing Astro components and CSS. Repair intrinsic tab sizing; use reproducible focused crops of the existing fictional-data app captures at phone widths, preserving desktop/original links. Shorten setup to one install/connect/verify path, preserving legacy anchors, manual observation and disclosures. Differentiate dark surfaces and quiet non-action metadata. Add plain-text setting descriptions and expandable results, plus better search indexing. Shorten the journal introduction and de-emphasize temporary context; keep all three stages and deep links. Align navigation wording across pages.

A new component library or redesigned homepage would add scope without addressing the observed defects. More decorative SVGs would worsen density. No dependency changes, runtime gateway changes, telemetry changes or claims of automatic verification.

## Acceptance
320/390px phones and 1024/1280px desktops in both themes; native no-JS controls; keyboard/focus, reduced motion and query/history preservation; no lost settings/anchors; no invented app state; full-size evidence available. Production search must index field prose, not duplicate directory listings.
