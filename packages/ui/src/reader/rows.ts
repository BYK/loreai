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
import type { DistillationBlock, ReaderBlock, SessionBlocks } from "./blocks";

export interface ReaderRow {
  /** Stable key — the block id — so measurements survive prepends. */
  key: string;
  block: ReaderBlock;
}

type Timed<T extends ReaderBlock> = T & { createdAt: number };

function isTimed<T extends ReaderBlock>(block: T): block is Timed<T> {
  return block.createdAt !== null;
}

function partitionDistillations(distillations: readonly DistillationBlock[]) {
  const timed: Timed<DistillationBlock>[] = [];
  const untimed: DistillationBlock[] = [];
  for (const d of distillations) (isTimed(d) ? timed : untimed).push(d);
  timed.sort((a, b) => a.createdAt - b.createdAt);
  return { timed, untimed };
}

export function buildRows(blocks: SessionBlocks): ReaderRow[] {
  const { timed, untimed } = partitionDistillations(blocks.distillations);
  const rows: ReaderRow[] = untimed.map((d) => ({ key: d.id, block: d }));
  let next = 0;
  for (const message of blocks.messages) {
    if (isTimed(message)) {
      // Summaries produced before this message was written sit above it.
      for (
        let d = timed[next];
        d && d.createdAt < message.createdAt;
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

/** Row index by block id, for the reader's key → index lookups. */
export function indexRows(
  rows: readonly ReaderRow[],
): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  rows.forEach((row, i) => index.set(row.key, i));
  return index;
}
