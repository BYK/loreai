/**
 * The reader's row order: message blocks in server order with each
 * distillation placed *after* the last message it could have summarised
 * (the newest message not later than the distillation's own timestamp).
 * Distillations stay labelled compressed context — placement only tells the
 * reader roughly which stretch of history a summary covers. A distillation
 * older than every loaded message summarises history the loaded window does
 * not show and leads the document; one with no known time cannot be placed
 * and leads it too, rather than being slotted somewhere plausible.
 * Markers (#1924) sit above the first message at-or-after their stamp; above
 * an untimed message they are placed by the next timed message's stamp, so
 * they cannot get trapped behind a message with no known time.
 */
import type { DistillationBlock, ReaderBlock, SessionBlocks } from "./blocks";
import type { MarkerBlock } from "./markers";

/**
 * One virtualised row: either a content block or a context marker (#1924).
 * `key` is the block/marker id so measurements survive prepends.
 */
export type ReaderRow =
  | { key: string; block: ReaderBlock; marker?: undefined }
  | { key: string; block?: undefined; marker: MarkerBlock };

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

export function buildRows(
  blocks: SessionBlocks,
  markers: readonly MarkerBlock[] = [],
): ReaderRow[] {
  const { timed, untimed } = partitionDistillations(blocks.distillations);
  const rows: ReaderRow[] = untimed.map((d) => ({ key: d.id, block: d }));
  const timedMarkers = [...markers].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );
  // An untimed message was written no later than its timed successor, so it
  // inherits that successor's stamp for marker placement (or +Infinity when
  // none follows).
  const effective = blocks.messages.map(() => Infinity);
  let stamp = Infinity;
  for (let i = blocks.messages.length - 1; i >= 0; i--) {
    const message = blocks.messages[i]!;
    if (isTimed(message)) stamp = message.createdAt;
    effective[i] = stamp;
  }
  let next = 0;
  let markerNext = 0;
  blocks.messages.forEach((message, i) => {
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
    // A marker lands above the first message at-or-after its own stamp, so
    // a compaction keyed to a turn's message sits right above that turn.
    for (
      let m = timedMarkers[markerNext];
      m && m.createdAt <= effective[i]!;
      m = timedMarkers[++markerNext]
    ) {
      rows.push({ key: m.id, marker: m });
    }
    rows.push({ key: message.id, block: message });
  });
  rows.push(...timed.slice(next).map((d) => ({ key: d.id, block: d })));
  rows.push(
    ...timedMarkers.slice(markerNext).map((m) => ({ key: m.id, marker: m })),
  );
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
