/** Shared token-area batching for document writes and backfills. */

const MAX_BACKFILL_CHUNK = 8;

const MAX_BATCH_TOKEN_AREA = 4096;

const CHARS_PER_TOKEN = 4;

/** Partition `rows` into batches that respect both MAX_BACKFILL_CHUNK and MAX_BATCH_TOKEN_AREA. */
export function nextEmbeddingBatch<T extends { text: string }>(
  rows: T[],
  start: number,
): T[] {
  const batch: T[] = [];
  let maxTokens = 0;

  for (
    let i = start;
    i < rows.length && batch.length < MAX_BACKFILL_CHUNK;
    i++
  ) {
    const estTokens = Math.ceil(rows[i].text.length / CHARS_PER_TOKEN);
    const newMax = Math.max(maxTokens, estTokens);
    const newArea = (batch.length + 1) * newMax;

    if (batch.length > 0 && newArea > MAX_BATCH_TOKEN_AREA) break;

    batch.push(rows[i]);
    maxTokens = newMax;
  }

  return batch;
}
