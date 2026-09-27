/**
 * Collapsible in-session quick-search bar (#1922): the compact form that
 * replaces the always-visible search strip. The reader owns the state —
 * this component only renders it and reports gestures back. Coverage and
 * whole-session search rows are passed in as children so this file stays
 * about the bar itself.
 */
import { Show, type Component, type JSX } from "solid-js";

import { Button } from "~/components/ui/button";
import { formatCount } from "~/reader/quick-search";

export const QuickSearchBar: Component<{
  query: string;
  onQuery: (q: string) => void;
  /** Position/total for `search-count`; null while no query is active. */
  count: { index: number; total: number } | null;
  /** The loaded-window scan is still running. */
  scanning: boolean;
  /** The `search-summary` text, or null while there is nothing to say. */
  summary: string | null;
  /** Prev/next/select enabled state comes precomputed from the hits. */
  canStep: boolean;
  canSelect: boolean;
  onStep: (direction: 1 | -1) => void;
  onSelect: () => void;
  onClear: () => void;
  onClose: () => void;
  inputRef: (el: HTMLInputElement) => void;
  /** Coverage / whole-session search rows, rendered below the controls. */
  children?: JSX.Element;
}> = (props) => (
  <form
    role="search"
    aria-label="Search this session"
    class="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2 text-xs sm:px-7.5"
    data-testid="quick-search"
    onSubmit={(e) => {
      e.preventDefault();
      props.onStep(1);
    }}
  >
    <input
      ref={props.inputRef}
      type="search"
      data-testid="search-input"
      aria-label="Find in session"
      placeholder="Find in session…"
      autocomplete="off"
      class="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 text-[13px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-xs"
      value={props.query}
      onInput={(e) => props.onQuery(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        } else if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          props.onStep(-1);
        }
      }}
    />
    <span
      data-testid="search-count"
      class="min-w-9 text-muted tabular-nums"
      aria-hidden={props.count === null}
    >
      {props.count
        ? formatCount(props.count.index, props.count.total, props.scanning)
        : ""}
    </span>
    <Show when={props.summary}>
      {(summary) => (
        <span
          data-testid="search-summary"
          role="status"
          aria-live="polite"
          class="text-muted"
        >
          {summary()}
        </span>
      )}
    </Show>
    <span class="flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="search-prev"
        aria-label="Previous match"
        disabled={!props.canStep}
        onClick={() => props.onStep(-1)}
      >
        ↑
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="search-next"
        aria-label="Next match"
        disabled={!props.canStep}
        onClick={() => props.onStep(1)}
      >
        ↓
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="search-select"
        disabled={!props.canSelect}
        onClick={props.onSelect}
      >
        Select match
      </Button>
      <button
        type="button"
        class="text-xs text-accent underline"
        data-testid="search-clear"
        onClick={props.onClear}
      >
        Clear
      </button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-testid="search-close"
        aria-label="Close search"
        onClick={props.onClose}
      >
        ✕
      </Button>
    </span>
    {props.children}
  </form>
);
