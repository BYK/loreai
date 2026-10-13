# Measuring delivered knowledge

Evaluate the outgoing request, not the selector's return value. A selected
entry may reach the agent only as a recall hint, or never reach it at all.

`packages/gateway/src/knowledge-delivery.ts` provides
`measureKnowledgeDelivery(messages, entries, sessionToken, model)`. Pass the
final upstream message array, the candidate entries, and the session token
from `loreSessionToken(sessionID)`. For a provider-specific wire capture,
parse it through that provider's request adapter first.

The result contains aggregate counts and a state for each input candidate:

- `full`: the exact rendered entry appears under its canonical category heading in a knowledge note's full-text section.
- `hint`: its canonical `k:`, `d:`, `t:`, or `lat:` recall token appears only in the recall-hint section.
- `absent`: neither representation appears in a delivered note.
- `ambiguous`: colliding short handles prevent attribution of an otherwise identical bullet within the same category.

The helper recognizes paired user knowledge notes for the requested session.
It counts replayed notes too, because replay still occupies context. It never
logs entry IDs, titles, bodies, request content, or model names. This is an
evaluation helper, not the authority for injection credit or confidence.

Candidates include their category. When a versioned edit retains an old
surfaced handle, pass that handle in `surfacedIds`. Verify every alias against
the current entry's logical identity in the active tenant and project first.
The helper matches exact current text under those handles and the rendered
category heading. A category-only edit makes an old-category replay stale.
It rejects colliding bullets within a category and never infers identity
from similar content. It measures visible
text; message framing and caller-supplied aliases do not authenticate provenance.
Both full-text and recall-hint sections end at the next H1 or H2 heading.
Sibling content never counts as delivery or as either section's token estimate.
Full-section discovery stops before the first recall-hint heading, including in
hints-only notes; a newline-bearing hint title never creates full delivery.

`deltaTextTokens`, `fullTextTokens`, and `hintTextTokens` are text estimates.
They exclude the frozen project catalog, pinned preferences, tool schemas,
provider serialization, and other conversation text. Record actual provider
input, output, reasoning, cache-read, and cache-write usage separately. Never
report a reduction in these estimates as a reduction in total billed cost.

## Packing and retrieval

New knowledge deltas pack entries in the current selector's order, then render
the admitted set canonically. UUID-sorted set fingerprints never define
packing rank. Existing replay blocks retain their bytes and positions even
when ranking changes. During a rebuild, tenant-scoped logical identities
preserve the selection snapshot's rank across versioned edits; old surfaced
version IDs still identify the delivered text. Synthetic sources keep their
own identities.

Passive ranking first prefers exact file and symbol references named in the
current task, then the existing confidence-weighted hybrid score and ID
tiebreak. It uses the existing reference extractor; line numbers do not
change file identity, and symbol names never prefix-match. Tasks without
code references retain the existing ordering. This changes ranking, not
candidate eligibility: FTS, vector, and project safety-net matches remain
eligible, including implicit conventions without a named code target.

The optional reference pass parses at most 4,096 UTF-16 code units per task or
entry, 65,536 units in total, and 128 candidates. It bounds source text before
concatenation. Exhaustion discards partial evidence and restores hybrid
ordering for the whole eligible pool.

## Outcome evaluation

Use fresh isolated fixtures and hidden executable checks. Compare the base
and candidate through actual gateway requests, with the same task, agent,
model, context cap, and tool budget. Include tasks with explicit code targets
and tasks whose required fact has no lexical link to the request.

Record delivered states on first and later turns, completions, provider usage,
all model/tool/recall calls, and elapsed time. Grade after the agents exit.
Keep hidden requirements and private knowledge out of reports. Catalog size
and selector recall are diagnostics; neither establishes a completion or
end-to-end cost improvement.
