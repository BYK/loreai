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
code references retain the existing ordering. The reference pass changes
ranking, not candidate eligibility: FTS, vector, and project safety-net
matches enter the same candidate pool, including implicit conventions.

The optional reference pass parses at most 4,096 UTF-16 code units per task or
entry, 65,536 units in total, and 128 candidates. It bounds source text before
concatenation. Exhaustion discards partial evidence and restores hybrid
ordering for the whole eligible pool.

## Default task filter

`knowledge.taskFilter` defaults to `true`. After budget packing, the
checkpoint-time lexical rule admits contextual knowledge as follows:

- Gotchas need a distinctive task word in the title, two in the body, or
  15–34 distinct non-stopwords in the body.
- Architecture needs a distinctive task word in the title or two in the body.
- Contextual decisions and patterns are omitted.

Preferences, explicit recall, recalled conversation context, and `lat.md`
remain available. Omission never deletes or changes a knowledge entry.
Rejected slots never refill, and rejected packed entries never reappear
as overflow hints. The frozen project catalog remains available for recall.

The filter uses the current user task, not distilled fallback text or later
work. It parses at most 4,096 UTF-16 units per title or body, 65,536 units
in total, and 128 entries per pool. Long tasks use a head-and-tail excerpt
within the same 4,096-unit bound. Missing tasks, unsupported non-ASCII task
words, and work-limit exhaustion preserve the whole pool and its ordering.

This rule can omit a needed implicit convention. The earlier offline replay
retained 46 of 50 judged-needed entries and removed 80 of 232 judged-irrelevant
selections. Those are selection counts, not delivery, completion, or cost
results. The original labelled corpus is no longer available, so these are
historical results for the exploratory rule, not a fresh retention result for
this bounded implementation. Disable the filter to retain semantic-only
matches and contextual decisions and patterns:

```json
{
  "knowledge": {
    "taskFilter": false
  }
}
```

Changing the setting recomputes a warm session's selection. Newly admitted
facts use a new durable delta; the setting never rewrites the existing system
prefix or replayed blocks. Filtering never retracts previously delivered text
or suppresses updates to entries already surfaced in the session.

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
