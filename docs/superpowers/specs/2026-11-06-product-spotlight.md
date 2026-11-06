# Compact product spotlight

The user rejected the homepage's large framed, split text/screenshot section and asked to improve it. Replace that section in the same PR with a compact product walkthrough. Keep the floating header, hero, RPG journal, and existing product-before-journal order.

Put a short heading and Explore the app link above a single workbench. Its Rule / Source / History native controls choose a readable close-up of the actual knowledge-detail capture and a concise explanation beside it. Show source-session versus exact-message limitations and truthful recorded revision metadata; do not invent live app actions or revision contents. Keep an original-capture link and clearly identify the sample project. Remove the oversized outer panel, accent stripe and vertically centered empty text column.

The existing detail image is cropped with CSS, retaining unmodified light/dark assets. Source/history crops emphasize the relevant area; phone crops retain readable scale and stack the explanation below. `preview=rule|source|history` uses the existing allowlisted URL helper, independent of hero/journal state, with native fallback and history restoration. Whole-capture links open the corresponding full tour state. Controls stay44px, selected state has contrast, and changing views is immediate for keyboard/reduced motion. No animation or dependency is needed.

Preserve #product, its accessible title, all other fragments and original asset availability. Test compact desktop height, image clipping/containment, phone sizes, no-JS controls, malformed values, early native input, independent URL/history and prefixed links. Capture actual light/dark/phone results, source-review the delta, and update draftPR2115. No merge.
