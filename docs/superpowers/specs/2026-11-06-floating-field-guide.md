# Floating field guide navigation

User-approved reference: the Floating field guide variant at local port 4340. Replace the shared website header in PR #2115; keep the quest journal and page content intact.

Use a floating, inset, olive-bordered bar with 18px corners, a 30px logo, DM Sans wordmark, Product and Resources disclosures, Why Lore, GitHub, the existing three-theme pill, and a neutral ink Get started action with an amber arrow. Dropdowns have descriptive destinations and a featured Quiver illustration: journal for Product, tools for Resources. Reuse the existing light/dark artwork and palette.

Product links: Explore the app (`tour/?view=knowledge#product`), How memory works (`docs/memory/`), Connect your coding agent (`docs/install/`). Featured link: Open the quest journal (`#journal`). Footer: Data & costs (`docs/data-and-costs/`). Resources links: Documentation (`docs/`), Field notes (`blog/`), Troubleshooting (`docs/troubleshooting/`). Featured link: Follow the setup guide (`docs/first-session/`). Footer: Release notes (GitHub releases).

All internal paths respect BASE_URL. Navigation uses ordinary anchors and native details; JavaScript only enhances dismissal and optional pointer entrance. Keyboard interactions stay immediate; reduced motion disables entrance motion. Escape returns focus, outside click dismisses, selecting a link closes the disclosure, and opening another disclosure closes the first. Keep the phone's How it works link. Mobile navigation groups Product and Resources, includes GitHub, and ends with Get started. Docs retain Starlight search and mobile sidebar.

There must be exactly one current primary anchor on docs pages (Documentation), blog pages (Field notes), the comparison page (Why Lore), and tour pages (Explore the app). Setup actions never claim current-section semantics. Support 320px phones, short screens, intermediate docs widths, coarse pointers, both themes, no JavaScript, and prefixed previews without overlap or inaccessible destinations.

No new dependencies. No backend, release, journal state, or whole-page redesign changes. Use the same existing PR; leave it unmerged.
