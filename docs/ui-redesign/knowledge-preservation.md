# Knowledge information preservation

Audited against the original PR base `7fd66b47` and the pre-reading-refinement
revision `82675158`. The quieter screenshot is a collapsed disclosure, not a
smaller stored knowledge record.

| Information or action | Current location |
| --- | --- |
| Complete entry title and content | Reader header and full paragraph body; unchanged content renderer |
| Category, sensitivity and approval labels | Header, when recorded |
| Recorded confidence | Visible header badge; explanation remains in Source & history |
| Author, scope and update time | Header; detailed recorded writer and dates remain disclosed |
| Source session ID/link and availability | Source & history; short availability summary remains visible |
| Retained summaries and source-reader links | Source & history, including the same lazy full-summary action |
| Recorded/cited files, repository links and omitted-path notice | Source & history → Files |
| Versions, comparisons, full version text and restore | Source & history → History |
| IDs, full dates, promotion/reinforcement state and worker/source references | Source & history → Technical details; values wrap instead of relying on hover ellipses |
| Edit, delete and propose/share controls | Existing revision/permission-checked actions; aligned with the reader column |

Core/gateway production source trees, UI state modules, API client and knowledge
contracts are unchanged from the original base. Entry-detail requests still load
full content independently of bounded list previews. No storage migration or
new data write is introduced by these presentation changes. Existing backend
retention and access rules are unchanged.

The default disclosure remains closed to prioritize reading. Its description now
names the information inside, and recorded confidence is visible without opening
it. Expanded source/history and technical screenshots accompany the PR.

Verification includes the before/after field/action inventory, unchanged data-path
Git hashes, complete UI tests, and production browser checks for full first/last
paragraphs, readable long technical values, unchanged entry actions and no mutating
API calls while inspecting the reader. Screenshot data is fictional; this audit
establishes UI/data-path preservation rather than a checksum of a live database.
