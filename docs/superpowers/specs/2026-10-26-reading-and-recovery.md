# Reading and recovery refinement

The user approved all six proposals and asked to include them in existing PR #2110 with refreshed screenshots. This extends the approved intentional-UI work, retaining the mini-only desktop sidebar.

## Intended behavior

1. **Project directory:** Replace tall, sparse cards with compact grouped rows. Names lead; paths, counts, and recorded activity are secondary. Preserve exact-remote grouping, separate local/unattributed sections, every checkout link, three sorts, query filter, sessions-mode destinations, and modified clicks. Long names/paths must wrap without horizontal overflow.
2. **Sessions:** Lead with conversation title and recency. Put session IDs, processing counts (distilled/undistilled), title provenance and exact range into an accessible Processing details disclosure outside the title link. Do not erase them or change search/paging/link semantics; unidentified sessions still need a usable title fallback. Keep all facts truthful.
3. **Knowledge reader:** Lead with content and a concise, honest source summary. Source & history starts collapsed, with all existing provenance, confidence, files and version/recovery information still reachable. Replace Why trust this with neutral Source & history wording; explain recorded confidence is not a probability of correctness. Retain source-state distinctions: available, summary-only, missing, checking, failed/unknown, and no source recorded. No additional evidence fetches.
4. **Sync recovery:** Default to a readable title/content difference describing what keeping the local snapshot would change. Reuse the existing bounded diffText algorithm and shared semantic added/removed rendering. Preserve accessible full local/current text, title-only and no-text-change cases, large-input fallback, missing/deleted current versions and unrecoverable records. Explain consequences of Keep mine and Discard before activation, and preserve existing confirmations, owner guards, API calls, stale-version recovery and mutation semantics.
5. **Operations:** Cache warming, Cost intelligence, and Model usage start with useful current status/scope, actionable problems and relevant controls. Move technical tables, historical breakdowns, circuit-breaker bucket details and diagnostic histograms into appropriately named native disclosures. Keep active warnings, reset/retry/edit controls and pending/error/permission states visible when necessary. Preserve cost provenance and estimates, UTC model-usage semantics, project/date/community controls, and upload privacy decisions; never imply estimates are measured savings or that idle is a successful sync.
6. **Entities:** Add recorded context using existing fields. The list can show aliases and meaningful project scope without per-row detail requests. Detail prioritizes recorded description, related knowledge and navigable relations before metadata administration. Relation direction must be accurate; related entity and knowledge links must work beneath /ui, including workspace knowledge and encoded IDs. Do not invent summaries, evidence or counts.

## Global constraints

- Keep desktop navigation mini-only; preserve labeled mobile drawer and existing context behavior.
- Use existing Solid, owned UI components, olive/amber theme, existing contracts and bounded diffText; no dependencies, backend/schema/contract changes, provider calls, or production-data mutations.
- Keep existing routes, URL values, permissions, owner/quarantine safeguards, mutation confirmations and API semantics.
- Use only recorded data. Missing values are unknown, never invented zeroes, timestamps, success or relationships.
- Maintain keyboard navigation, native links and disclosures, visible focus, 44px mobile controls, reduced motion and no horizontal overflow at 320px and 390px.
- Tests use isolated mocks or seeded disposable DBs; screenshot fixtures are fictional, run real frontend code, and use no DOM/CSS injection.
- Update PR #2110 only, keep it ready for review, do not merge. Refresh final screenshots and description, preserve relevant existing gallery evidence.

## Approach and verification

Use native disclosures and modest row/layout changes rather than add a new settings/view framework. Share only the diff text renderer needed by version and recovery views; keep domain-specific consequence handling separate. Work in two sequential batches with scoped review, then a whole-branch adversarial review and a separate security review. Each real behavioral defect gets a failing-first regression. Verify UI suite, workspace types/lint/format, production browser tests and actual screenshots; report prior whole-backend limits honestly.
