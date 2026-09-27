/**
 * Constants shared between the pipeline's prompt-delta writer and the
 * management API's session-context reader (which must not import pipeline.ts).
 */

/**
 * Window (ms) during which a new mutation merges into the LATEST block instead
 * of appending a new one. Bounds rapid-fire curator batches (e.g. 3 entries
 * curated back-to-back) to a single `[memory refreshed]` cycle. 60s — long
 * enough to absorb a curator batch, short enough that an idle session's next
 * mutation (after the user resumes) gets its own block.
 */
export const KNOWLEDGE_DELTA_DEBOUNCE_MS = 60_000;
