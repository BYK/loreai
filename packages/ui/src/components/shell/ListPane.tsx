import {
  createRenderEffect,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";

import { cn } from "~/lib/utils";

type ListScrollSnapshot = {
  key: string | null;
  offset: number | null;
  scrollTop: number;
};

function captureListScroll(scroller: HTMLElement): ListScrollSnapshot {
  const top = scroller.getBoundingClientRect().top;
  const row = [
    ...scroller.querySelectorAll<HTMLElement>("[data-list-key]"),
  ].find((candidate) => candidate.getBoundingClientRect().bottom > top);
  return {
    key: row?.dataset.listKey ?? null,
    offset: row ? row.getBoundingClientRect().top - top : null,
    scrollTop: scroller.scrollTop,
  };
}

function restoreListScroll(
  scroller: HTMLElement,
  snapshot: ListScrollSnapshot,
) {
  const row = snapshot.key
    ? [...scroller.querySelectorAll<HTMLElement>("[data-list-key]")].find(
        (candidate) => candidate.dataset.listKey === snapshot.key,
      )
    : undefined;
  if (!row || snapshot.offset === null) {
    scroller.scrollTop = snapshot.scrollTop;
    return;
  }
  const offset =
    row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += offset - snapshot.offset;
}

export const ListPane: Component<{
  visible: boolean;
  full: boolean;
  maximized: boolean;
  width: number;
  header: JSX.Element;
  query: string;
  onQueryInput: (value: string) => void;
  children: JSX.Element;
}> = (props) => {
  let section: HTMLElement | undefined;
  let previousVisible: boolean | undefined;
  let snapshot: ListScrollSnapshot | null = null;
  let restoreFrame: number | undefined;

  const cancelRestore = () => {
    if (restoreFrame !== undefined) {
      cancelAnimationFrame(restoreFrame);
      restoreFrame = undefined;
    }
  };
  const scroller = () =>
    section?.querySelector<HTMLElement>("[data-list-scroller]");

  createRenderEffect(() => {
    const visible = props.visible;
    if (previousVisible === true && !visible) {
      cancelRestore();
      const element = scroller();
      snapshot = element ? captureListScroll(element) : null;
    } else if (previousVisible === false && visible && snapshot) {
      const saved = snapshot;
      cancelRestore();
      const restore = () => {
        restoreFrame = undefined;
        const element = scroller();
        if (props.visible && element) {
          restoreListScroll(element, saved);
          if (snapshot === saved) snapshot = null;
        }
      };
      if (typeof requestAnimationFrame === "function") {
        restoreFrame = requestAnimationFrame(restore);
      } else {
        restore();
      }
    }
    previousVisible = visible;
  });
  onCleanup(cancelRestore);

  return (
    <section
      ref={(element) => {
        section = element;
      }}
      data-pane="list"
      aria-label="List"
      aria-hidden={!props.visible}
      hidden={!props.visible}
      class={cn(
        "flex min-h-0 flex-none flex-col overflow-hidden border-r border-hairline bg-surface",
        !props.full && "w-full",
        props.maximized && "flex-1",
      )}
      style={
        props.full && !props.maximized
          ? { width: `${props.width}px` }
          : undefined
      }
    >
      {props.header}
      <label class="mx-2 mb-2 flex h-8 items-center rounded-md border border-hairline bg-transparent px-2">
        <span class="sr-only">Search list</span>
        <input
          type="search"
          aria-label="Search list"
          placeholder="in:inbox"
          data-testid="nav-project-filter"
          class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted"
          value={props.query}
          onInput={(event) => props.onQueryInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onQueryInput("");
          }}
        />
      </label>
      {props.children}
    </section>
  );
};
