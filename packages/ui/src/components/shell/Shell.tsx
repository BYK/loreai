import type { Component, JSX } from "solid-js";
import {
  children,
  createEffect,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { ResizableHandle } from "~/components/ui/resizable";
import { sidebar } from "~/state/sidebar";
import { AppBar } from "./AppBar";
import { Rail } from "./Rail";

export type MobilePane = "nav" | "list" | "detail";
export interface ShellProps {
  /** Optional content navigation used by the development fixture. */
  nav?: () => JSX.Element;
  list?: JSX.Element;
  contextLabel?: string;
  detail: JSX.Element;
  mobilePane: MobilePane;
  back?: { href: string; label: string };
  searchProjectId?: string;
  banner?: JSX.Element;
}

/** Permanent primary rail, optional context, and a stable main document. */
export const Shell: Component<ShellProps> = (props) => {
  const location = useLocation();
  const media = window.matchMedia?.("(min-width: 48rem)");
  const [wide, setWide] = createSignal(media?.matches ?? true);
  const [mobileOpen, setMobileOpen] = createSignal(false);
  const open = () =>
    hasContext() && (wide() ? !sidebar().collapsed() : mobileOpen());
  let contextPane: HTMLElement | undefined;
  const focusToggle = () =>
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="context-toggle"], [data-testid="project-picker-trigger"]',
        )
        ?.focus({ preventScroll: true });
    });
  const changeOpen = (value: boolean) => {
    const focused = contextPane?.contains(document.activeElement);
    if (wide()) sidebar().setCollapsed(!value);
    else setMobileOpen(value);
    if (!value && focused) focusToggle();
  };
  const updateWidth = () => {
    const focused = contextPane?.contains(document.activeElement);
    setWide(media?.matches ?? true);
    setMobileOpen(false);
    if (!open() && focused) focusToggle();
  };
  media?.addEventListener?.("change", updateWidth);
  onCleanup(() => media?.removeEventListener?.("change", updateWidth));
  // Route navigation closes only the narrow-screen context. The permanent rail,
  // toolbar and main document remain available; desktop context stays open.
  createEffect(
    on(
      () => location.pathname,
      () => setMobileOpen(false),
    ),
  );
  const closeOnNavigation = (event: MouseEvent) => {
    if (
      !wide() &&
      open() &&
      event.target instanceof Element &&
      contextPane?.contains(event.target) &&
      event.target.closest("a[href]") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      setMobileOpen(false);
      focusToggle();
    }
  };
  document.addEventListener("click", closeOnNavigation, true);
  onCleanup(() =>
    document.removeEventListener("click", closeOnNavigation, true),
  );
  const escape = (event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      !open() ||
      document.querySelector(
        '[role="dialog"], [role="listbox"], [data-project-picker-content]',
      )
    )
      return;
    if (!contextPane?.contains(event.target as Node)) return;
    event.preventDefault();
    changeOpen(false);
  };
  document.addEventListener("keydown", escape);
  onCleanup(() => document.removeEventListener("keydown", escape));
  const [listWidth, setListWidth] = createSignal(
    (() => {
      try {
        const width = Number(localStorage.getItem("lore.ui.listWidth"));
        return Number.isFinite(width) && width >= 260 && width <= 480
          ? width
          : 320;
      } catch {
        return 320;
      }
    })(),
  );
  const resizeList = (width: number) => {
    const next = Math.min(480, Math.max(260, Math.round(width)));
    setListWidth(next);
    try {
      localStorage.setItem("lore.ui.listWidth", String(next));
    } catch {
      /* Optional preference. */
    }
  };
  const list = children(() => props.list);
  const detail = children(() => props.detail);
  const banner = children(() => props.banner);
  const hasList = () => list() !== undefined;
  const navigation = children(() => (hasList() ? undefined : props.nav?.()));
  const hasContext = () => hasList() || navigation() != null;
  return (
    <div
      class="flex h-dvh min-h-0 flex-col overflow-hidden bg-bg text-text"
      data-mobile-pane={props.mobilePane}
    >
      {banner()}
      <div class="grid min-h-0 flex-1 grid-cols-[52px_minmax(0,1fr)] sm:grid-cols-[60px_minmax(0,1fr)]">
        <Rail projectId={props.searchProjectId} />
        <div
          data-testid="workspace-content"
          class="grid min-h-0 min-w-0 grid-rows-[48px_minmax(0,1fr)]"
        >
          <AppBar
            leading={
              <Show when={props.back}>
                {(back) => (
                  <A
                    href={back().href}
                    data-testid="mobile-back"
                    class="flex size-8 shrink-0 items-center justify-center text-xs text-accent sm:w-auto sm:max-w-20 md:hidden"
                    title={back().label}
                  >
                    <span aria-hidden="true">←</span>
                    <span class="sr-only sm:not-sr-only sm:truncate">
                      {back().label}
                    </span>
                  </A>
                )}
              </Show>
            }
            onOpenNav={hasContext() ? () => changeOpen(!open()) : undefined}
            navigationOpen={open()}
            contextLabel={props.contextLabel ?? "Knowledge"}
            searchProjectId={props.searchProjectId}
          />
          <div
            class="grid min-h-0 min-w-0"
            data-context-open={open()}
            style={{
              "grid-template-columns": !open()
                ? "0px 0px minmax(0,1fr)"
                : wide()
                  ? `${hasList() ? listWidth() : 240}px ${hasList() ? 6 : 0}px minmax(0,1fr)`
                  : "minmax(0,1fr) 0px 0px",
            }}
          >
            <aside
              ref={(element) => {
                contextPane = element;
              }}
              id="workspace-context"
              data-testid="context-pane"
              data-pane={hasList() ? "list" : "nav"}
              aria-label={hasList() ? "Browse context" : "Section navigation"}
              inert={!open()}
              aria-hidden={!open() || undefined}
              class="col-start-1 row-start-1 min-h-0 min-w-0 overflow-y-auto border-r border-line bg-nav"
              style={{ display: open() ? undefined : "none" }}
            >
              {hasList() ? list() : navigation()}
            </aside>
            <div
              class="col-start-2 row-start-1 min-h-0"
              style={{
                display: open() && wide() && hasList() ? undefined : "none",
              }}
            >
              <Show when={hasList()}>
                <ResizableHandle
                  label={`Resize ${(props.contextLabel ?? "Knowledge").toLowerCase()} list`}
                  value={listWidth()}
                  onChange={resizeList}
                />
              </Show>
            </div>
            <main
              data-pane="detail"
              class="col-start-3 row-start-1 min-h-0 min-w-0 overflow-y-auto bg-surface"
              style={{ display: !wide() && open() ? "none" : undefined }}
            >
              {detail()}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
};
