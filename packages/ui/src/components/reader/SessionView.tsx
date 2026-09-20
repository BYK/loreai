/**
 * The session reader (UI-06b): a virtualised, selectable, addressable
 * document of one session's captured history.
 *
 *  - Rows come from `buildRows(buildBlocks(...))`; `@tanstack/solid-virtual`
 *    mounts only the visible ones, measuring each row's real height
 *    (`measureElement`) and keying measurements by block id so heights
 *    survive prepends.
 *  - Older history prepends: the scroll offset is shifted by the size the
 *    new rows added, so what the reader was looking at stays put.
 *  - Selection and focus are *logical* (block id, part index, offsets /
 *    row key), never DOM nodes, so they survive rows unmounting.
 *  - `?a=` deep links resolve through `resolveAnchor`: a hash mismatch is a
 *    visible "source changed" state, an unknown block "not in loaded
 *    history" (with older pages searched up to a bound), never a guess.
 *  - Copy-with-source is live; every discussion action is a labelled,
 *    disabled `FutureAction` until APP-02.
 *  - In-session search (UI-06c) scans the logical rows in time-bounded
 *    slices — mounted or not — and walks hits with a distinct mark; the
 *    coverage declaration states what the view holds (captured / partial /
 *    native transcript not available) from what the server reported.
 */
import type { Component, JSX } from "solid-js";
import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";

import { StaleBadge } from "~/components/lore/StaleBadge";
import {
  FUTURE_ACTIONS,
  FutureActionRow,
} from "~/components/lore/FutureAction";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type {
  DistillationDetail,
  DistillationSummary,
  TemporalMessage,
} from "~/contracts";
import { cn } from "~/lib/utils";
import {
  type AnchorResolution,
  type DecodedAnchor,
  type SourceAnchor,
  ANCHOR_MAPPING_VERSION,
  anchorFor,
  blockAnchor,
  decodeAnchor,
  encodeAnchor,
  resolutionLabel,
  resolveAnchor,
} from "~/reader/anchors";
import {
  type MessageBlock,
  type ReaderBlock,
  buildBlocks,
  originLabel,
} from "~/reader/blocks";
import {
  NATIVE_TRANSCRIPT_LABEL,
  coverageDeclaration,
} from "~/reader/coverage";
import { displayedText } from "~/reader/render";
import { buildRows, indexRows } from "~/reader/rows";
import { type SearchHit, queryMatcher, searchRows } from "~/reader/search";
import {
  anchorForReading,
  deepLinkFor,
  readSelection,
  sourceReferenceText,
} from "~/reader/selection";
import type { KeyStatus } from "~/state/status";

import {
  DistillationBlockView,
  HighlightContext,
  MessageBlockView,
  type PassageHighlight,
} from "./SessionBlock";

/** Older pages searched automatically for a deep-linked block. */
export const DEEP_LINK_SEARCH_PAGES = 10;
/** Estimated row height before measurement (a short message). */
export const ROW_ESTIMATE = 120;
export const ROW_OVERSCAN = 6;
/** Keystroke → search debounce, and re-scan debounce when rows change. */
export const SEARCH_DEBOUNCE_MS = 150;
/** Main-thread time one search slice may take before yielding. */
export const SEARCH_SLICE_MS = 12;
const SEARCH_STEP_ROWS = 40;

export interface SessionViewProps {
  sessionId: string;
  messages: readonly TemporalMessage[];
  distillations: readonly DistillationSummary[];
  /** Session total from the server; null while unknown. */
  messageCount: number | null;
  /** Older history beyond the loaded window: true / false / null (unknown). */
  hasOlder: boolean | null;
  loadingOlder?: boolean;
  olderError?: unknown;
  onLoadOlder?: () => Promise<void>;
  status?: KeyStatus;
  /** Raw `?a=` value. */
  anchorParam: string | null;
  /** Called when the reader's addressable state changes (URL owner). */
  onAnchorChange?: (encoded: string | null) => void;
  /** Absolute URL of this reader (without `?a=`), for copied deep links. */
  linkBase: () => string;
  loadDistillation?: (id: string) => Promise<DistillationDetail>;
  header?: JSX.Element;
  class?: string;
}

/** The reader's logical selection. */
export interface ReaderSelection {
  anchor: SourceAnchor;
  block: MessageBlock;
  quote: string;
}

type LinkState =
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "searching"; pages: number }
  | { kind: "resolved"; resolution: AnchorResolution };

type DistillationState = {
  detail?: DistillationDetail;
  loading: boolean;
  error: string | null;
};

export interface SearchState {
  query: string;
  hits: SearchHit[];
  /** Rows scanned so far; equals `total` once the scan is complete. */
  scanned: number;
  total: number;
  done: boolean;
}

const SEARCH_IDLE: SearchState = {
  query: "",
  hits: [],
  scanned: 0,
  total: 0,
  done: true,
};

const SELECTION_HINT: Record<"parts" | "outside", string> = {
  parts: "Select within a single passage to reference it.",
  outside: "Select text inside a message to reference it.",
};

function blockText(block: MessageBlock): string {
  return block.parts
    .map((part) => displayedText(block, part))
    .join("\n\n")
    .trim();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}

function writeClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error("Clipboard unavailable"));
}

const RowContent: Component<{
  block: ReaderBlock;
  distillation: (id: string) => DistillationState | undefined;
  onOpenDistillation: (id: string) => void;
}> = (props) => (
  <Switch>
    <Match when={props.block.kind === "message" && props.block}>
      {(block) => <MessageBlockView block={block()} />}
    </Match>
    <Match when={props.block.kind === "distillation" && props.block}>
      {(block) => (
        <DistillationBlockView
          block={block()}
          detail={props.distillation(block().distillationId)?.detail ?? null}
          loading={props.distillation(block().distillationId)?.loading}
          error={props.distillation(block().distillationId)?.error ?? null}
          onOpen={() => props.onOpenDistillation(block().distillationId)}
        />
      )}
    </Match>
  </Switch>
);

export const SessionView: Component<SessionViewProps> = (props) => {
  let scrollEl: HTMLDivElement | undefined;
  let listEl: HTMLDivElement | undefined;

  const blocks = createMemo(() =>
    buildBlocks({
      messages: [...props.messages],
      distillations: [...props.distillations],
    }),
  );
  const rows = createMemo(() => buildRows(blocks()));
  const rowIndex = createMemo(() => indexRows(rows()));
  const rowIndexOf = (blockId: string) => rowIndex().get(blockId) ?? -1;
  const [listOffset, setListOffset] = createSignal(0);
  const [toolbarHeight, setToolbarHeight] = createSignal(0);
  let toolbarEl: HTMLDivElement | undefined;

  // A stable key function: measurements re-derive only when the count or a
  // measured size changes, not on every content update.
  const itemKey = (index: number) =>
    untrack(rows)[index]?.key ?? `row-${index}`;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLElement>({
    get count() {
      return rows().length;
    },
    getItemKey: itemKey,
    get scrollMargin() {
      return listOffset();
    },
    // The sticky toolbar covers the top of the viewport.
    get scrollPaddingStart() {
      return toolbarHeight();
    },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => ROW_ESTIMATE,
    overscan: ROW_OVERSCAN,
  });

  // Rows are keyed by block id, not by virtual-item object: an update that
  // touches one block re-renders that row alone, and the others keep their
  // DOM (and measurements) while their positions shift.
  const virtualKeys = createMemo(() =>
    virtualizer.getVirtualItems().map((item) => String(item.key)),
  );
  const virtualByKey = createMemo(() => {
    const map = new Map<string, { index: number; start: number }>();
    for (const item of virtualizer.getVirtualItems()) {
      map.set(String(item.key), { index: item.index, start: item.start });
    }
    return map;
  });

  // The header scrolls with the document and the toolbar sticks, so the
  // list starts below them; the virtualizer needs that offset. Everything
  // above the list is observed because banners and the empty state resize it.
  onMount(() => {
    const list = listEl;
    const scroll = scrollEl;
    if (!list || !scroll) return;
    const measure = () => {
      setListOffset(list.offsetTop);
      setToolbarHeight(toolbarEl?.offsetHeight ?? 0);
    };
    measure();
    createEffect(on(() => rows().length === 0, measure, { defer: true }));
    if (typeof ResizeObserver !== "undefined") {
      // Measuring inside the observer callback would move the rows while
      // notifications are still being delivered; defer it to the next frame.
      let frame: number | null = null;
      const ro = new ResizeObserver(() => {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          measure();
        });
      });
      ro.observe(scroll);
      for (const above of Array.from(scroll.children)) {
        if (above !== list) ro.observe(above);
      }
      onCleanup(() => {
        ro.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
      });
    }
  });

  // -- selection -----------------------------------------------------------
  const [selection, setSelection] = createSignal<ReaderSelection | null>(null);
  const [selectionHint, setSelectionHint] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal<"reference" | "link" | null>(null);
  const [copyError, setCopyError] = createSignal<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  const highlight = createMemo<PassageHighlight | null>(() => {
    const s = selection();
    if (!s || s.anchor.partIndex === undefined) return null;
    return {
      blockId: s.anchor.blockId,
      partIndex: s.anchor.partIndex,
      start: s.anchor.start,
      end: s.anchor.end,
    };
  });

  /** The encoded anchor this reader last put in the URL (or saw there). */
  let publishedAnchor: string | null = null;
  function publish(anchor: SourceAnchor | null) {
    const encoded = anchor ? encodeAnchor(anchor) : null;
    if (encoded === publishedAnchor) return;
    publishedAnchor = encoded;
    props.onAnchorChange?.(encoded);
  }

  function select(next: ReaderSelection | null) {
    batch(() => {
      setSelection(next);
      setSelectionHint(null);
      setCopied(null);
      setCopyError(null);
    });
    publish(next?.anchor ?? null);
  }

  function selectFromDom() {
    if (!scrollEl) return;
    const reading = readSelection(scrollEl, document.getSelection());
    if (reading.kind === "none") return;
    if (reading.kind === "ambiguous") {
      setSelectionHint(SELECTION_HINT[reading.reason]);
      return;
    }
    const block = blocks().byId.get(reading.blockId);
    if (!block || block.kind !== "message") return;
    const anchor = anchorForReading(reading, block);
    if (!anchor) return;
    setLinkState({ kind: "none" });
    select({ anchor, block, quote: reading.quote });
  }

  function selectBlock(block: ReaderBlock) {
    if (block.kind !== "message") return;
    setLinkState({ kind: "none" });
    select({ anchor: blockAnchor(block), block, quote: blockText(block) });
  }

  function clearSelection() {
    document.getSelection()?.removeAllRanges();
    setLinkState({ kind: "none" });
    select(null);
  }

  async function copy(kind: "reference" | "link") {
    const s = selection();
    if (!s) return;
    const link = deepLinkFor(props.linkBase(), s.anchor, s.quote);
    const text =
      kind === "link"
        ? link
        : sourceReferenceText({
            quote: s.quote,
            block: s.block,
            sessionId: props.sessionId,
            link,
          });
    try {
      await writeClipboard(text);
      setCopyError(null);
      setCopied(kind);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      setCopyError(
        err instanceof Error && err.message
          ? `Copy failed: ${err.message}`
          : "Copy failed",
      );
    }
  }

  // -- deep links ----------------------------------------------------------
  const [linkState, setLinkState] = createSignal<LinkState>({ kind: "none" });
  const [olderInFlight, setOlderInFlight] = createSignal(false);
  let scrollTarget: string | null = null;
  let scrolledBlock: string | null = null;
  let pendingMarkScroll = false;

  const scrollToBlock = (blockId: string) => {
    const index = rowIndexOf(blockId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center" });
  };

  const resolveLink = (decoded: DecodedAnchor) => {
    const block = blocks().byId.get(decoded.anchor.blockId);
    const text =
      block?.kind === "message" && decoded.anchor.partIndex !== undefined
        ? (() => {
            const part = block.parts[decoded.anchor.partIndex];
            return part ? displayedText(block, part) : null;
          })()
        : null;
    return { block, resolution: resolveAnchor(decoded, block, text) };
  };

  // Resolve the URL anchor whenever it changes or more history arrives.
  createEffect(
    on(
      () => props.anchorParam,
      (raw) => {
        if (raw === publishedAnchor) return; // our own publication
        publishedAnchor = raw;
        if (raw === null) {
          setLinkState({ kind: "none" });
          setSelection(null);
          return;
        }
        const decoded = decodeAnchor(raw);
        if (!decoded) {
          setLinkState({ kind: "malformed" });
          setSelection(null);
          return;
        }
        setLinkState({ kind: "searching", pages: 0 });
        scrollTarget = decoded.anchor.blockId;
      },
    ),
  );

  createEffect(() => {
    const state = linkState();
    if (state.kind !== "searching") return;
    const decoded = decodeAnchor(props.anchorParam);
    if (!decoded) return;
    const { block, resolution } = resolveLink(decoded);
    const busy = props.loadingOlder || olderInFlight();
    if (resolution.status === "missing" && resolution.reason === "block") {
      if (
        props.hasOlder === true &&
        !busy &&
        !props.olderError &&
        props.onLoadOlder &&
        state.pages < DEEP_LINK_SEARCH_PAGES
      ) {
        setLinkState({ kind: "searching", pages: state.pages + 1 });
        void loadOlder();
        return;
      }
      if (props.hasOlder === null || busy) return; // wait
      setLinkState({ kind: "resolved", resolution });
      return;
    }
    setLinkState({ kind: "resolved", resolution });
    // Only a verified anchor becomes a selection/highlight; a changed or
    // missing source is reported, never re-anchored to similar text.
    if (resolution.status === "ok" && block?.kind === "message") {
      untrack(() =>
        setSelection({
          anchor: decoded.anchor,
          block,
          quote: resolution.quote || blockText(block),
        }),
      );
    } else {
      setSelection(null);
    }
    if (block && scrollTarget === block.id) {
      scrollTarget = null;
      scrolledBlock = block.id;
      pendingMarkScroll =
        resolution.status === "ok" && decoded.anchor.partIndex !== undefined;
      queueMicrotask(() => scrollToBlock(block.id));
    }
  });

  // A selection made here is re-verified as the loaded history changes: when
  // the selected block's text no longer matches its anchor (a streamed edit,
  // a refetched snapshot), the highlight is dropped and the change reported
  // rather than re-anchored. When the block itself left the loaded window
  // (a server page replacing a wider cached window) the bounded older-history
  // search resumes for the anchor the URL still carries.
  createEffect(
    on(
      blocks,
      (current) => {
        const s = untrack(selection);
        if (!s || current.byId.size === 0) return;
        if (untrack(linkState).kind === "searching") return;
        const { resolution } = resolveLink({
          anchor: s.anchor,
          mapping: ANCHOR_MAPPING_VERSION,
        });
        if (resolution.status === "ok") return;
        const linked = decodeAnchor(props.anchorParam);
        if (
          resolution.status === "missing" &&
          resolution.reason === "block" &&
          linked?.anchor.blockId === s.anchor.blockId
        ) {
          batch(() => {
            scrollTarget = s.anchor.blockId;
            setSelection(null);
            setLinkState({ kind: "searching", pages: 0 });
          });
          return;
        }
        batch(() => {
          setLinkState({ kind: "resolved", resolution });
          setSelection(null);
        });
      },
      { defer: true },
    ),
  );

  // -- older history -------------------------------------------------------
  async function loadOlder() {
    if (
      !props.onLoadOlder ||
      props.loadingOlder ||
      olderInFlight() ||
      !scrollEl
    ) {
      return;
    }
    const before = {
      top: scrollEl.scrollTop,
      total: virtualizer.getTotalSize(),
      count: rows().length,
      forLink: scrollTarget !== null,
    };
    setOlderInFlight(true);
    try {
      await props.onLoadOlder();
    } catch {
      return; // the owner reports the failure through `olderError`
    } finally {
      setOlderInFlight(false);
    }
    const added = rows().length - before.count;
    if (added <= 0) return;
    // A deep link that found its block in this page owns the scroll position.
    if (before.forLink && scrollTarget === null) return;
    // The prepended rows are unmeasured, so they enter at the estimate; the
    // first-measure compensation in the virtualizer corrects the rest as
    // they scroll into view.
    const delta = virtualizer.getTotalSize() - before.total;
    if (delta > 0) scrollEl.scrollTop = before.top + delta;
  }

  // -- focus ---------------------------------------------------------------
  const [focusKey, setFocusKey] = createSignal<string | null>(null);
  let pendingFocus = false;

  /** Move DOM focus onto the pending row if the virtualizer has mounted it. */
  function focusMounted(key: string | null) {
    if (!pendingFocus || !key || !listEl) return;
    const el = listEl.querySelector<HTMLElement>(
      `[data-row-key="${CSS.escape(key)}"]`,
    );
    if (el) {
      pendingFocus = false;
      el.focus({ preventScroll: true });
    }
  }

  function focusRow(index: number) {
    const row = rows()[index];
    if (!row) return;
    pendingFocus = true;
    setFocusKey(row.key);
    virtualizer.scrollToIndex(index, { align: "auto" });
    focusMounted(row.key);
  }

  // A row scrolled into the window after the key press is focused once it
  // mounts.
  createEffect(() => {
    virtualizer.getVirtualItems().map((item) => item.index);
    focusMounted(focusKey());
  });

  function onKeyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (
      event.key === "Escape" &&
      (selection() || selectionHint() || linkState().kind !== "none")
    ) {
      event.preventDefault();
      clearSelection();
      return;
    }
    const rowEl = target.closest<HTMLElement>("[data-row-key]");
    if (!rowEl || target !== rowEl) return; // keys inside rows are theirs
    const key = rowEl.dataset.rowKey ?? "";
    const index = rowIndexOf(key);
    if (index < 0) return;
    switch (event.key) {
      case "ArrowDown":
      case "j":
        event.preventDefault();
        focusRow(Math.min(rows().length - 1, index + 1));
        break;
      case "ArrowUp":
      case "k":
        event.preventDefault();
        focusRow(Math.max(0, index - 1));
        break;
      case "Home":
        event.preventDefault();
        focusRow(0);
        break;
      case "End":
        event.preventDefault();
        focusRow(rows().length - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const row = rows()[index];
        if (row) selectBlock(row.block);
        break;
      }
    }
  }

  // -- distillations -------------------------------------------------------
  const [distillationStates, setDistillationStates] = createSignal<
    ReadonlyMap<string, DistillationState>
  >(new Map());
  const distillationState = (id: string) => distillationStates().get(id);
  async function openDistillation(id: string) {
    if (!props.loadDistillation || distillationState(id)) return;
    const update = (state: DistillationState) =>
      setDistillationStates((prev) => new Map(prev).set(id, state));
    update({ loading: true, error: null });
    try {
      const detail = await props.loadDistillation(id);
      update({ detail, loading: false, error: null });
    } catch (err) {
      update({ loading: false, error: errorMessage(err) });
    }
  }

  // -- in-session search ---------------------------------------------------
  const [query, setQuery] = createSignal("");
  const [search, setSearch] = createSignal<SearchState>(SEARCH_IDLE);
  const [hitIndex, setHitIndex] = createSignal(-1);
  const [searchHit, setSearchHit] = createSignal<PassageHighlight | null>(null);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let rescanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanGeneration = 0;
  onCleanup(() => {
    clearTimeout(searchTimer);
    clearTimeout(rescanTimer);
    clearTimeout(scanTimer);
  });

  /** Scan every row for the query in slices, yielding between them. */
  function startScan(q: string) {
    const generation = ++scanGeneration;
    clearTimeout(scanTimer);
    const matcher = queryMatcher(q);
    const current = untrack(rows);
    if (!matcher) {
      batch(() => {
        setSearch({ ...SEARCH_IDLE, query: q });
        setHitIndex(-1);
        setSearchHit(null);
      });
      return;
    }
    // A re-scan of the same query (rows changed) keeps the finished hit list
    // on screen until the new one is complete, so the summary and current
    // hit do not flicker under a live stream.
    const previous = untrack(search);
    const kept = previous.query === q && previous.done ? previous.hits : null;
    const hits: SearchHit[] = [];
    let from: number | null = 0;
    setSearch({
      query: q,
      hits: kept ?? [],
      scanned: 0,
      total: current.length,
      done: false,
    });
    const step = () => {
      if (generation !== scanGeneration) return;
      const started = performance.now();
      while (from !== null && performance.now() - started < SEARCH_SLICE_MS) {
        const slice = searchRows(current, matcher, from, SEARCH_STEP_ROWS);
        for (const hit of slice.hits) hits.push(hit);
        from = slice.next;
      }
      const done = from === null;
      setSearch({
        query: q,
        hits: done || !kept ? [...hits] : kept,
        scanned: done ? current.length : (from ?? current.length),
        total: current.length,
        done,
      });
      if (!done) scanTimer = setTimeout(step, 0);
    };
    step();
  }

  createEffect(
    on(query, (q) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => startScan(q), SEARCH_DEBOUNCE_MS);
    }),
  );
  // Rows changed (older page, live update): re-scan an active query so hit
  // row indexes stay honest. Throttled, not debounced — a stream that
  // changes rows every frame must not postpone the re-scan forever.
  createEffect(
    on(
      rows,
      () => {
        if (queryMatcher(untrack(query)) === null) return;
        if (rescanTimer !== undefined) return;
        rescanTimer = setTimeout(() => {
          rescanTimer = undefined;
          if (queryMatcher(untrack(query)) !== null) startScan(untrack(query));
        }, SEARCH_DEBOUNCE_MS);
      },
      { defer: true },
    ),
  );

  /** Keep the current hit pointing at the same passage across re-scans. */
  createEffect(
    on(search, (state) => {
      const current = untrack(searchHit);
      if (!current) return;
      const index = state.hits.findIndex(
        (h) =>
          h.blockId === current.blockId &&
          h.partIndex === current.partIndex &&
          h.start === current.start,
      );
      if (index >= 0) setHitIndex(index);
      else if (state.done) {
        setHitIndex(-1);
        setSearchHit(null);
      }
    }),
  );

  function goToHit(index: number) {
    const hit = search().hits[index];
    if (!hit) return;
    batch(() => {
      setHitIndex(index);
      setSearchHit({
        blockId: hit.blockId,
        partIndex: hit.partIndex,
        start: hit.start,
        end: hit.end,
      });
    });
    scrolledBlock = hit.blockId;
    pendingMarkScroll = true;
    scrollToBlock(hit.blockId);
  }

  function stepHit(direction: 1 | -1) {
    const count = search().hits.length;
    if (count === 0) return;
    const current = hitIndex();
    const next =
      current < 0
        ? direction === 1
          ? 0
          : count - 1
        : (current + direction + count) % count;
    goToHit(next);
  }

  function clearSearch() {
    clearTimeout(searchTimer);
    clearTimeout(rescanTimer);
    rescanTimer = undefined;
    scanGeneration++;
    batch(() => {
      setQuery("");
      setSearch(SEARCH_IDLE);
      setHitIndex(-1);
      setSearchHit(null);
    });
  }

  /** Turn the current hit into the reader's selection (anchor + panel). */
  function selectHit() {
    const hit = search().hits[hitIndex()];
    if (!hit) return;
    const block = blocks().byId.get(hit.blockId);
    const part = block?.kind === "message" ? block.parts[hit.partIndex] : null;
    if (!block || block.kind !== "message" || !part) return;
    const text = displayedText(block, part);
    setLinkState({ kind: "none" });
    select({
      anchor: anchorFor(block, part, hit.start, hit.end),
      block,
      quote: text.slice(hit.start, hit.end),
    });
  }

  const searchSummary = () => {
    const state = search();
    if (queryMatcher(state.query) === null) return null;
    const n = state.hits.length;
    const matches = `${n.toLocaleString()} ${n === 1 ? "match" : "matches"}`;
    if (!state.done) {
      return `${matches} so far · scanning ${state.scanned.toLocaleString()} of ${state.total.toLocaleString()} blocks`;
    }
    const position = hitIndex() >= 0 ? `${hitIndex() + 1} of ${n}` : matches;
    return n === 0
      ? "No matches in loaded history"
      : `${position} in loaded history`;
  };

  // -- coverage ------------------------------------------------------------
  const loaded = () => blocks().messages.length;
  const coverage = createMemo(() =>
    coverageDeclaration({
      loaded: loaded(),
      total: props.messageCount,
      hasOlder: props.hasOlder,
      cachedWindow: props.status?.partial === true,
    }),
  );

  const linkBanner = (): { tone: "info" | "warn"; text: string } | null => {
    const state = linkState();
    switch (state.kind) {
      case "none":
        return null;
      case "malformed":
        return {
          tone: "warn",
          text: "This link's passage reference is not understood.",
        };
      case "searching":
        return {
          tone: "info",
          text: "Looking for the linked passage in older history…",
        };
      case "resolved": {
        const r = state.resolution;
        if (r.status === "ok") return null;
        if (r.status === "missing" && r.reason === "block") {
          return {
            tone: "warn",
            text:
              props.hasOlder === true
                ? "Linked source was not found in the loaded history. Load older history to keep looking."
                : resolutionLabel(r),
          };
        }
        return { tone: "warn", text: resolutionLabel(r) };
      }
    }
  };

  return (
    <HighlightContext.Provider
      value={{
        highlight,
        searchHit,
        onApplied: (mark, h) => {
          // A deep link or search hit scrolls to its passage once the mark
          // exists.
          if (pendingMarkScroll && h.blockId === scrolledBlock) {
            pendingMarkScroll = false;
            mark.scrollIntoView?.({ block: "center" });
          }
        },
      }}
    >
      <div
        class={cn("flex h-[calc(100dvh-62px)] min-h-0 flex-col", props.class)}
        data-testid="session-view"
        onKeyDown={onKeyDown}
      >
        <div
          ref={(el) => (scrollEl = el)}
          class="relative min-h-0 flex-1 overflow-y-auto"
          data-testid="session-scroll"
          onPointerUp={() => queueMicrotask(selectFromDom)}
          onKeyUp={(e) => {
            if (e.shiftKey || e.key === "Shift") queueMicrotask(selectFromDom);
          }}
        >
          {props.header}
          <div
            ref={(el) => (toolbarEl = el)}
            class="sticky top-0 z-10 bg-surface"
            data-testid="reader-toolbar"
          >
            <div
              class="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2 text-xs text-muted sm:px-7.5"
              data-testid="reader-coverage"
              data-coverage={coverage().kind}
              data-coverage-reason={coverage().reason ?? ""}
            >
              <Badge
                variant={coverage().kind === "captured" ? "teal" : "outline"}
                title="What this view contains, as reported by Lore"
              >
                {coverage().label}
              </Badge>
              <span data-testid="reader-coverage-line">
                {coverage().detail}
              </span>
              <Badge
                variant="outline"
                title="No harness exposes its own transcript to Lore yet; only Lore's capture is shown"
                data-testid="native-transcript"
              >
                {NATIVE_TRANSCRIPT_LABEL}
              </Badge>
              <Show when={props.status}>
                {(status) => <StaleBadge status={status()} />}
              </Show>
              <Show when={props.status?.partial}>
                <span
                  class="rounded-full border border-line bg-soft px-2 py-0.5 text-[10px] font-medium"
                  data-testid="partial-indicator"
                >
                  Partial · cached window
                </span>
              </Show>
              <span class="ml-auto flex items-center gap-2">
                <Show when={props.hasOlder === true}>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="load-older"
                    disabled={props.loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    {props.loadingOlder ? "Loading…" : "Load older history"}
                  </Button>
                </Show>
                <Show when={props.hasOlder === false && loaded() > 0}>
                  <span data-testid="history-start">
                    Start of captured history
                  </span>
                </Show>
              </span>
              <Show when={props.olderError}>
                {(err) => (
                  <span class="basis-full text-danger" role="alert">
                    Older history unavailable: {errorMessage(err())}
                  </span>
                )}
              </Show>
            </div>
            <form
              role="search"
              aria-label="Search this session"
              class="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2 text-xs sm:px-7.5"
              onSubmit={(e) => {
                e.preventDefault();
                stepHit(1);
              }}
            >
              <input
                type="search"
                data-testid="search-input"
                aria-label="Find in session"
                placeholder="Find in session…"
                autocomplete="off"
                class="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 text-[13px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-xs"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    if (query()) clearSearch();
                    else e.currentTarget.blur();
                  } else if (e.key === "Enter" && e.shiftKey) {
                    e.preventDefault();
                    stepHit(-1);
                  }
                }}
              />
              <Show when={searchSummary()}>
                {(summary) => (
                  <>
                    <span
                      data-testid="search-summary"
                      role="status"
                      aria-live="polite"
                      class="text-muted"
                    >
                      {summary()}
                    </span>
                    <span class="flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="search-prev"
                        aria-label="Previous match"
                        disabled={search().hits.length === 0}
                        onClick={() => stepHit(-1)}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="search-next"
                        aria-label="Next match"
                        disabled={search().hits.length === 0}
                        onClick={() => stepHit(1)}
                      >
                        ↓
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="search-select"
                        disabled={hitIndex() < 0}
                        onClick={selectHit}
                      >
                        Select match
                      </Button>
                      <button
                        type="button"
                        class="text-xs text-accent underline"
                        data-testid="search-clear"
                        onClick={clearSearch}
                      >
                        Clear
                      </button>
                    </span>
                    <Show when={search().done && coverage().kind === "partial"}>
                      <span
                        class="basis-full text-muted"
                        data-testid="search-coverage"
                      >
                        Searched the loaded history only · {coverage().detail}
                      </span>
                    </Show>
                  </>
                )}
              </Show>
            </form>
            <Show when={linkBanner()}>
              {(banner) => (
                <div
                  role="status"
                  data-testid="link-state"
                  data-tone={banner().tone}
                  class={cn(
                    "border-b px-5 py-2 text-xs sm:px-7.5",
                    banner().tone === "warn"
                      ? "border-mark-edge bg-mark/40 text-text"
                      : "border-line bg-soft text-muted",
                  )}
                >
                  {banner().text}
                </div>
              )}
            </Show>
          </div>
          <Show when={rows().length === 0}>
            <p class="px-5 py-8 text-sm text-muted sm:px-7.5" role="status">
              No captured messages in this session.
            </p>
          </Show>
          <div
            ref={(el) => (listEl = el)}
            role="feed"
            aria-label="Session history"
            aria-busy={props.loadingOlder ? "true" : "false"}
            data-testid="session-rows"
            class="relative w-full px-5 sm:px-7.5"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            <For each={virtualKeys()}>
              {(key) => {
                const item = () => virtualByKey().get(key);
                const row = () => {
                  const index = item()?.index;
                  return index === undefined ? undefined : rows()[index];
                };
                return (
                  <Show when={row()}>
                    {(row) => (
                      <div
                        ref={(el) =>
                          queueMicrotask(() => virtualizer.measureElement(el))
                        }
                        data-index={item()?.index}
                        data-row-key={row().key}
                        data-search-current={
                          searchHit()?.blockId === row().key ? "" : undefined
                        }
                        tabIndex={-1}
                        aria-posinset={(item()?.index ?? 0) + 1}
                        aria-setsize={rows().length}
                        class={cn(
                          "absolute left-0 top-0 w-full px-5 pt-1 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-7.5",
                          selection()?.anchor.blockId === row().key &&
                            "reader-row-selected",
                        )}
                        style={{
                          transform: `translateY(${(item()?.start ?? 0) - listOffset()}px)`,
                        }}
                      >
                        <RowContent
                          block={row().block}
                          distillation={distillationState}
                          onOpenDistillation={(id) => void openDistillation(id)}
                        />
                      </div>
                    )}
                  </Show>
                );
              }}
            </For>
          </div>
        </div>

        <Show when={selectionHint() && !selection()}>
          <div
            role="status"
            data-testid="selection-hint"
            class="border-t border-line bg-soft px-5 py-2 text-xs text-muted sm:px-7.5"
          >
            {selectionHint()}
          </div>
        </Show>

        <Show when={selection()}>
          {(s) => (
            <section
              data-testid="selection-panel"
              aria-label="Selected passage"
              class="max-h-[45dvh] overflow-y-auto border-t border-thread bg-surface px-5 py-3 text-sm shadow-[0_-6px_18px_-12px_rgba(0,0,0,0.35)] sm:px-7.5"
            >
              <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span class="eyebrow">Selected passage</span>
                <span>
                  {originLabel(s().block)}
                  {s().anchor.partIndex === undefined
                    ? " · whole message"
                    : ` · ${s().anchor.end - s().anchor.start} characters`}
                </span>
                <button
                  type="button"
                  class="ml-auto text-xs text-accent underline"
                  onClick={clearSelection}
                  data-testid="selection-clear"
                >
                  Clear
                </button>
              </div>
              <Show when={s().quote}>
                <blockquote
                  class="my-2 max-h-24 overflow-hidden border-l-[3px] border-quote-edge bg-bg px-3 py-2 text-[13px] whitespace-pre-wrap"
                  data-testid="selection-quote"
                >
                  {s().quote.length > 400
                    ? `${s().quote.slice(0, 400)}…`
                    : s().quote}
                </blockquote>
              </Show>
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  data-testid="copy-with-source"
                  onClick={() => void copy("reference")}
                >
                  {copied() === "reference" ? "Copied" : "Copy with source"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="copy-link"
                  onClick={() => void copy("link")}
                >
                  {copied() === "link" ? "Link copied" : "Copy link"}
                </Button>
                <Show when={copyError()}>
                  {(err) => (
                    <span class="text-xs text-danger" role="alert">
                      {err()}
                    </span>
                  )}
                </Show>
              </div>
              <FutureActionRow
                actions={FUTURE_ACTIONS}
                primary="Ask agent"
                class="mt-2"
              />
            </section>
          )}
        </Show>
      </div>
    </HighlightContext.Provider>
  );
};
