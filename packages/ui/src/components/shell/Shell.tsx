import type { Component, JSX } from "solid-js";
import { children, createSignal, Show } from "solid-js";
import { A } from "@solidjs/router";
import * as DialogPrimitive from "@kobalte/core/dialog";

import { cn } from "~/lib/utils";

import { AppBar } from "./AppBar";

export type MobilePane = "nav" | "list" | "detail";

export interface ShellProps {
  /** Rendered twice (pane and drawer), hence a factory rather than an element. */
  nav: () => JSX.Element;
  /** Optional middle pane (knowledge list). Omit for nav + detail layouts. */
  list?: JSX.Element;
  detail: JSX.Element;
  /** The single pane a narrow screen shows for the current route. */
  mobilePane: MobilePane;
  /** Narrow-screen back link, shown in the app bar. */
  back?: { href: string; label: string };
  searchProjectId?: string;
  /** Banner rendered above the layout (e.g. the fixture's non-production label). */
  banner?: JSX.Element;
}

const PANE_SCROLL = "min-w-0 lg:h-[calc(100dvh-62px)] lg:overflow-y-auto";

/**
 * Three-pane shell: navigation · optional list · document.
 *  - ≥ lg: all panes side by side
 *  - md:   list + detail (or nav + detail when there is no list); the
 *          navigation opens as a drawer
 *  - < md: exactly one pane (`mobilePane`), with a back link in the app bar
 */
export const Shell: Component<ShellProps> = (props) => {
  const [navOpen, setNavOpen] = createSignal(false);
  // Resolve once: reading a JSX prop re-evaluates the caller's expression.
  const list = children(() => props.list);
  const detail = children(() => props.detail);
  const banner = children(() => props.banner);
  const hasList = () => list() !== undefined;

  return (
    <div
      class="flex min-h-dvh flex-col bg-bg text-text"
      data-mobile-pane={props.mobilePane}
    >
      {banner()}
      <AppBar
        leading={
          <Show when={props.back}>
            {(back) => (
              <A
                href={back().href}
                data-testid="mobile-back"
                class="text-sm text-accent md:hidden"
              >
                ← {back().label}
              </A>
            )}
          </Show>
        }
        onOpenNav={() => setNavOpen(true)}
        searchProjectId={props.searchProjectId}
      />

      <div
        class={cn(
          "grid flex-1 grid-cols-1",
          hasList()
            ? "md:grid-cols-[292px_minmax(0,1fr)] lg:grid-cols-[218px_292px_minmax(0,1fr)]"
            : "md:grid-cols-[218px_minmax(0,1fr)] lg:grid-cols-[218px_minmax(0,1fr)]",
        )}
      >
        <aside
          data-pane="nav"
          class={cn(PANE_SCROLL, "lg:block")}
          classList={{
            block: props.mobilePane === "nav",
            hidden: props.mobilePane !== "nav",
            "md:block": !hasList(),
            "md:hidden": hasList(),
          }}
        >
          {props.nav()}
        </aside>

        <Show when={hasList()}>
          <aside
            data-pane="list"
            class={cn(PANE_SCROLL, "border-r border-line bg-surface md:block")}
            classList={{
              block: props.mobilePane === "list",
              hidden: props.mobilePane !== "list",
            }}
          >
            {list()}
          </aside>
        </Show>

        <main
          data-pane="detail"
          class={cn(PANE_SCROLL, "bg-surface md:block")}
          classList={{
            block: props.mobilePane === "detail",
            hidden: props.mobilePane !== "detail",
          }}
        >
          {detail()}
        </main>
      </div>

      <DialogPrimitive.Root open={navOpen()} onOpenChange={setNavOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay class="fixed inset-0 z-40 bg-black/40 lg:hidden" />
          <DialogPrimitive.Content
            class="fixed inset-y-0 left-0 z-50 w-[260px] max-w-[85vw] overflow-y-auto bg-nav shadow-xl outline-none lg:hidden"
            aria-label="Navigation"
            data-testid="nav-drawer"
            onClick={(event: MouseEvent) => {
              // Any navigation from the drawer closes it.
              if ((event.target as HTMLElement).closest("a")) setNavOpen(false);
            }}
          >
            <DialogPrimitive.CloseButton class="absolute right-3 top-3 rounded-md px-2 py-1 text-sm text-muted hover:bg-soft">
              Close
            </DialogPrimitive.CloseButton>
            {props.nav()}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
};
