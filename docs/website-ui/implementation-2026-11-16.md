# Website clarity and usability improvements

Approved scope: the November 16 UI/UX audit, in PR #2115. Preserve the floating navigation, RPG journal, local-app palette, accessible native controls and progressive enhancement.

Approach: improve existing shared components and generated-reference presentation. Keep the full technical reference and real app captures; give the hero, journal and app proof distinct jobs. Avoid a new visual theme or another layer of decorative controls.

- [x] Reference: shared exact-field IDs in the directory and rendered reference; readable field, metadata and explanation groups on phones and desktop. Test real search-to-field navigation, URL reload, no-JS anchors and identifier wrapping.
- [x] Installation: explicit macOS/Linux Bash and Windows/npm prerequisites; commands stay available without JavaScript. Number the Codex Desktop configure/start/reopen/verify sequence. Retain observation-only verification and data/cost disclosures.
- [x] Product story: shorten repeated explanations, reduce empty journal space and compact phone app proof while preserving its Rule/Source/History controls and independent URL state.
- [x] Evidence: publish a reproducible, explicitly controlled two-session check using real memory-engine behavior. Distinguish recording, reviewed knowledge and retrieval from LLM extraction or task success. Include any correction and limitations; invent no customer result.
- [x] Comparison: each recommendation offers a relevant next action; selecting a radio never navigates automatically.
- [x] Navigation: expose Docs directly in the desktop floating bar and label screenshot tours as tours, including secondary pages and mobile destinations.
- [x] Editorial: replace unconditional lifecycle promises with the actual versioning, deletion and context-selection boundaries, linking current operational docs.
- [x] Diagrams: render theme-aware Mermaid diagrams, update when the theme changes, and offer a keyboard-accessible large diagram view on phones. Keep conditional loading and all five architecture diagrams.

Review focus: prefixed PR URLs; delayed or disabled JavaScript; malicious/unknown URL choices; rapid theme changes while diagrams render; enlarged text and 320px layouts. Preserve existing Pagefind on-demand initialization.

Verification: fail-first meaningful regressions, website units and production browser suite, Astro check, generated docs/links, formatting, lint and typecheck. Separate correctness and security reviews, then push the existing branch and verify hosted checks for the new head. No merge or production deployment.
