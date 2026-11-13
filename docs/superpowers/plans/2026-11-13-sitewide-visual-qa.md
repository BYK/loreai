# Sitewide visual QA and reading hierarchy

Approved: audit and improve the whole website in PR #2115, retaining the floating nav and RPG journal language.

**Evidence:** Reviewed first viewports for all 36 content routes at 390px dark; spot-checked deeper first-session content. Found an unreadable desktop verification capture on phones, repeated docs task labels/links, inconsistent guide next steps, and undifferentiated blog category metadata.

- [x] Fix phone verification with a reproducible crop and full original capture link; demonstrate failure before fix.
- [x] Carry meaningful icons into shared docs chapter headers/help actions, reference lookup, memory diagrams, comparison benefits and availability. Keep labels, native framework navigation and technical reference prose.
- [x] Simplify docs landing/task copy; give all five integrations a consistent native next-action component. Make team knowledge sharing a three-step review workflow with explicit identity/deletion caveats.
- [x] Give blog categories distinct icons; separate author/date metadata, remove redundant topic strings, clarify article back/RSS actions and diagram stages.
- [x] Audit every generated route at phone/desktop widths and both themes. Run website unit/browser/static/prefixed-link checks; independently review the delta and push to the same draft PR.

No new client dependency or controller. Preserve URL/anchor contracts, provider/cost/telemetry boundaries, recorded-session versus knowledge distinction, reviewable source evidence, native/no-JS behavior and manual verification. The previous interrupted full-root suite remains a separate limitation, not a website pass.

Final validation: 762 browser passes / 8 conditional skips, 19 units, 74 clean Astro files, workspace typecheck/lint/format, reference parity, 37-page prefix audit, 1,137 resolved fragments and 14 picture sources. Independent source reviews passed; both source crops are pixel-exact. Delivery stays in draft PR #2115.
