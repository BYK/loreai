/**
 * The reader's row order: message blocks in server order with each
 * distillation placed *after* the last message it could have summarised
 * (the newest message not later than the distillation's own timestamp).
 * Distillations stay labelled compressed context — placement only tells the
 * reader roughly which stretch of history a summary covers. A distillation
 * older than every loaded message summarises history the loaded window does
 * not show and leads the document; one with no known time cannot be placed
 * and leads it too, rather than being slotted somewhere plausible.
 */
import type { ReaderBlock, SessionBlocks } from "./blocks";

export interface ReaderRow {
  /** Stable key — the block id — so measurements survive prepends. */
  key: string;
  block: ReaderBlock;
}

export function buildRows(blocks: SessionBlocks): ReaderRow[] {
  const rows: ReaderRow[] = [];
  const timed = blocks.distillations
    .filter((d) => d.createdAt !== null)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  for (const d of blocks.distillations) {
    if (d.createdAt === null) rows.push({ key: d.id, block: d });
  }
  let next = 0;
  for (const message of blocks.messages) {
    if (message.createdAt !== null) {
      // Summaries produced before this message was written sit above it.
      for (
        let d = timed[next];
        d && (d.createdAt ?? 0) < message.createdAt;
        d = timed[++next]
      ) {
        rows.push({ key: d.id, block: d });
      }
    }
    rows.push({ key: message.id, block: message });
  }
  for (const d of timed.slice(next)) rows.push({ key: d.id, block: d });
  return rows;
}

/** Index of a block's row, or -1. */
export function rowIndexOf(rows: readonly ReaderRow[], blockId: string) {
  return rows.findIndex((r) => r.key === blockId);
}
