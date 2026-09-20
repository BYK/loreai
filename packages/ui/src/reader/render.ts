/**
 * Per-part render cache keyed by source identity *and* revision
 * (`blockId#partIndex#hash`), so a re-render of the same block never
 * re-parses Markdown and a changed part can never serve a stale render.
 * Bounded LRU: virtualised readers mount and unmount the same blocks many
 * times while scrolling; the fixture's 10k blocks must not pin 10k parses.
 */
import {
  renderMarkdown,
  renderPlain,
  type RenderedHtml,
} from "~/lib/safe-html";

import type { BlockPart, MessageBlock } from "./blocks";

export const RENDER_CACHE_LIMIT = 2_000;

const cache = new Map<string, RenderedHtml>();

export function renderCacheKey(block: MessageBlock, part: BlockPart): string {
  return `${block.id}#${part.index}#${part.hash}`;
}

function remember(key: string, value: RenderedHtml): RenderedHtml {
  cache.set(key, value);
  if (cache.size > RENDER_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return value;
}

/** Render a part (cached). Text parts are Markdown; tool/reasoning are plain. */
export function renderPart(block: MessageBlock, part: BlockPart): RenderedHtml {
  const key = renderCacheKey(block, part);
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency so hot blocks survive the LRU sweep.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const rendered =
    part.kind === "text" ? renderMarkdown(part.text) : renderPlain(part.text);
  return remember(key, rendered);
}

/**
 * Displayed text is kept per part object, outside the HTML LRU: in-session
 * search walks every loaded part, and a session larger than the LRU would
 * otherwise re-parse all of it on every scan. Parts are immutable and
 * replaced with their block, so the entry dies with the part.
 */
const textCache = new WeakMap<BlockPart, string>();

/** Displayed text of a part — the coordinate space of anchors into it. */
export function displayedText(block: MessageBlock, part: BlockPart): string {
  const cached = textCache.get(part);
  if (cached !== undefined) return cached;
  const text = renderPart(block, part).text;
  textCache.set(part, text);
  return text;
}

export function renderCacheSize(): number {
  return cache.size;
}

/** Test hook. */
export function clearRenderCache(): void {
  cache.clear();
}
