import type { Component, JSX } from "solid-js";
import {
  children,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import {
  A,
  type RouteSectionProps,
  useMatch,
  useNavigate,
  useResolvedPath,
  useSearchParams,
} from "@solidjs/router";
import * as DialogPrimitive from "@kobalte/core/dialog";
import * as PopoverPrimitive from "@kobalte/core/popover";

import { useWorkspace } from "~/routes/workspace";
import { ProjectListBody } from "~/components/shell/ProjectListBody";
import { ParticipantsPane } from "~/components/shell/ParticipantsPane";
import { ListPane } from "~/components/shell/ListPane";
import { Nav } from "~/components/shell/Nav";
import { AppBar } from "~/components/shell/AppBar";
import { cn } from "~/lib/utils";
import { MergeProjectsAction } from "~/components/lore/ProjectActions";
import { sectionProjects } from "~/components/shell/nav-projects";
import { pins } from "~/state/pins";
import {
  DEFAULT_LIST_WIDTH,
  loadPaneLayout,
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  reducePaneLayout,
  savePaneLayout,
  type Pane,
  type PaneLayout,
} from "~/state/pane-layout";
import { withWorkspaceFilter } from "~/lib/href";

type LayoutMode = "full" | "split" | "single";

function currentMode(): LayoutMode {
  if (typeof globalThis.matchMedia !== "function") return "full";
  if (globalThis.matchMedia("(min-width: 1100px)").matches) return "full";
  if (globalThis.matchMedia("(min-width: 760px)").matches) return "split";
  return "single";
}

const PaneHeader: Component<{
  title: string;
  pane: Pane;
  layout: PaneLayout;
  setLayout: (action: Parameters<typeof reducePaneLayout>[1]) => void;
  count?: number;
  controls?: boolean;
}> = (props) => {
  const minimized = () =>
    props.pane !== "document" && props.layout[props.pane] === "min";
  const maximized = () => props.layout.maximized === props.pane;
  const label = () =>
    props.pane === "document" || props.pane === "list"
      ? props.pane
      : props.title;
  return (
    <header class="flex h-9 flex-none items-center gap-2 px-3 text-xs">
      <span class="min-w-0 flex-1 truncate font-medium text-muted">
        {props.title}
        <Show when={props.count !== undefined}>
          <span class="ml-1 text-muted/70">· {props.count}</span>
        </Show>
      </span>
      <Show when={props.controls && props.pane !== "document"}>
        <button
          type="button"
          data-testid={`pane-min-${props.pane}`}
          aria-label={`${minimized() ? "Restore" : "Minimise"} ${label()}`}
          title={`${minimized() ? "Restore" : "Minimise"} ${label()}`}
          class="rounded px-1 text-muted hover:bg-soft"
          onClick={() =>
            props.setLayout({
              type: minimized() ? "restore" : "minimize",
              pane: props.pane as Exclude<Pane, "document">,
            })
          }
        >
          {minimized() ? "▢" : "–"}
        </button>
      </Show>
      <Show when={props.controls}>
        <button
          type="button"
          data-testid={`pane-max-${props.pane}`}
          aria-label={`${maximized() ? "Restore" : "Maximise"} ${label()}`}
          aria-pressed={maximized()}
          title={`${maximized() ? "Restore" : "Maximise"} ${label()}`}
          class="rounded px-1 text-muted hover:bg-soft"
          onClick={() =>
            props.setLayout({ type: "toggle-maximize", pane: props.pane })
          }
        >
          {maximized() ? "⤢" : "□"}
        </button>
      </Show>
    </header>
  );
};

const RestorePopover: Component<{
  pane: "nav" | "participants";
  label: string;
  children: JSX.Element;
  canRestore: boolean;
  onRestore: () => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  return (
    <PopoverPrimitive.Root open={open()} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        data-testid={`pane-chip-${props.pane}`}
        class="rounded-md px-2 py-1 text-xs text-muted hover:bg-soft"
      >
        {props.label} ▾
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          class="z-50 w-64 rounded-md border border-hairline bg-surface p-2"
          onClick={(event: MouseEvent) => {
            if ((event.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          <div class="max-h-[70vh] overflow-y-auto">{props.children}</div>
          <Show when={props.canRestore}>
            <PopoverPrimitive.CloseButton
              type="button"
              aria-label="Restore"
              class="mt-2 w-full rounded px-2 py-1 text-left text-xs text-accent hover:bg-soft"
              onClick={props.onRestore}
            >
              Restore
            </PopoverPrimitive.CloseButton>
          </Show>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};

export const Workspace: Component<RouteSectionProps> = (props) => {
  const ws = useWorkspace();
  const outlet = children(() => props.children);
  const [search, setSearch] = useSearchParams<{
    q?: string;
    list_q?: string;
  }>();
  const [queryDraft, setQueryDraft] = createSignal(
    typeof search.list_q === "string" ? search.list_q : "",
  );
  createEffect(() =>
    setQueryDraft(typeof search.list_q === "string" ? search.list_q : ""),
  );
  const navigate = useNavigate();
  const [layoutState, setLayoutState] = createSignal(loadPaneLayout());
  const [mode, setMode] = createSignal<LayoutMode>(currentMode());
  const [navOpen, setNavOpen] = createSignal(false);
  let navOpener: HTMLElement | null = null;
  let dragPointerId: number | null = null;
  let dragStartX = 0;
  let dragStartWidth = 0;

  createEffect(() => {
    if (mode() !== "single") {
      // The drawer unmounts outside single mode, so clear its state before returning.
      setNavOpen(false);
      navOpener = null;
    }
  });

  const media = [
    globalThis.matchMedia?.("(min-width: 1100px)"),
    globalThis.matchMedia?.("(min-width: 760px)"),
  ].filter((item): item is MediaQueryList => !!item);
  const updateMode = () => setMode(currentMode());
  for (const item of media) item.addEventListener?.("change", updateMode);
  onCleanup(() => {
    for (const item of media) item.removeEventListener?.("change", updateMode);
  });

  const dispatch = (
    action: Parameters<typeof reducePaneLayout>[1],
    { persist = true }: { persist?: boolean } = {},
  ) => {
    const next = reducePaneLayout(layoutState(), action);
    setLayoutState(next);
    if (persist) savePaneLayout(next);
  };
  const finishDividerDrag = (pointerId: number) => {
    if (dragPointerId !== pointerId) return;
    dragPointerId = null;
    if (layoutState().listWidth !== dragStartWidth) {
      savePaneLayout(layoutState());
    }
  };
  // Keep the project-list filter separate from route-level content `q` values.
  const query = () =>
    typeof search.list_q === "string" ? search.list_q : "in:inbox";
  const rootPath = useResolvedPath(() => "/");
  const projectPattern = useResolvedPath(() => "/projects/:projectId/*");
  const projectExactPattern = useResolvedPath(() => "/projects/:projectId");
  const projectMatch = useMatch(() => projectPattern() ?? "");
  const projectExactMatch = useMatch(() => projectExactPattern() ?? "");
  const projectRoute = () => projectMatch() ?? projectExactMatch();
  const globalEntryPattern = useResolvedPath(() => "/knowledge/:knowledgeId");
  const globalEntryMatch = useMatch(() => globalEntryPattern() ?? "");
  const rootMatch = useMatch(() => rootPath() ?? "");
  const decodeRouteParam = (value: string | undefined) => {
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const globalEntryId = () =>
    decodeRouteParam(globalEntryMatch()?.params.knowledgeId ?? undefined);
  const activeProjectId = createMemo(() => {
    const projectId = decodeRouteParam(
      projectRoute()?.params.projectId ?? undefined,
    );
    if (projectId) return projectId;
    const entryId = globalEntryId();
    return entryId
      ? (ws.state.knowledge.store.select(entryId)?.project_id ?? null)
      : null;
  });
  const projectCount = () => {
    const projects = ws.projects.data() ?? [];
    const filter = query() === "in:inbox" ? "" : query();
    const result = sectionProjects(
      projects,
      pins().pinned(),
      filter,
      activeProjectId(),
    );
    return result.matches?.length ?? projects.length;
  };
  const itemSelected = () => !rootMatch();
  const full = () => mode() === "full";
  const narrow = () => mode() !== "full";
  const activeMaximized = () => (full() ? layoutState().maximized : null);
  const hiddenByMaximize = (pane: Pane) => {
    const maximized = activeMaximized();
    return maximized !== null && maximized !== pane;
  };
  const navVisibleOutsidePopover = () =>
    layoutState().nav === "open" &&
    !hiddenByMaximize("nav") &&
    (full() || mode() === "split");
  const participantsVisibleOutsidePopover = () =>
    full() &&
    layoutState().participants === "open" &&
    !hiddenByMaximize("participants");
  const showLeft = () =>
    navVisibleOutsidePopover() || participantsVisibleOutsidePopover();
  const showList = () =>
    layoutState().list === "open" &&
    !hiddenByMaximize("list") &&
    (full() || (!itemSelected() && mode() !== "full"));
  const showDocument = () =>
    activeMaximized() === "document" ||
    (activeMaximized() === null && (full() || itemSelected() || !showList()));
  const showDivider = () =>
    full() && showList() && showDocument() && activeMaximized() === null;
  const navChip = () => layoutState().nav === "min" || hiddenByMaximize("nav");
  const participantsChip = () =>
    layoutState().participants === "min" ||
    hiddenByMaximize("participants") ||
    mode() !== "full";
  const listChip = () =>
    layoutState().list === "min" || hiddenByMaximize("list");

  const nav = () => (
    <Nav
      activeProjectId={activeProjectId()}
      stale={ws.state.projects.status()}
      workspaceFilter={query()}
      footer={<MergeProjectsAction />}
    />
  );
  const participants = [{ id: "you", kind: "user" as const, label: "You" }];
  const backHref = () => withWorkspaceFilter("/", query());
  function setSearchQuery(value: string) {
    setQueryDraft(value);
    setSearch(
      {
        list_q: value === "" || value === "in:inbox" ? undefined : value,
      },
      { replace: true },
    );
  }

  const restoreList = () => {
    dispatch({ type: "restore", pane: "list" });
    if (mode() !== "full" && itemSelected()) {
      // Narrow layouts cannot show the list beside a selected document.
      navigate(backHref());
    }
  };

  function resizeFromKeyboard(event: KeyboardEvent) {
    if (!showDivider()) return;
    let width: number | null = null;
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") width = layoutState().listWidth - step;
    if (event.key === "ArrowRight") width = layoutState().listWidth + step;
    if (event.key === "Home") width = MIN_LIST_WIDTH;
    if (event.key === "End") width = MAX_LIST_WIDTH;
    if (event.key === "Enter") width = DEFAULT_LIST_WIDTH;
    if (width === null) return;
    event.preventDefault();
    dispatch({ type: "set-list-width", width });
  }

  const setDrawerOpen = (open: boolean) => {
    if (open) {
      setNavOpen(true);
      return;
    }
    setNavOpen(false);
    const opener = navOpener;
    navOpener = null;
    let attempts = 0;
    const focusOpener = () => {
      const target = document.querySelector<HTMLElement>(
        '[data-testid="open-nav"]',
      );
      if (target?.isConnected) {
        target.focus();
        return;
      }
      if (attempts++ < 10) requestAnimationFrame(focusOpener);
    };
    if (opener?.isConnected) {
      opener.focus();
      requestAnimationFrame(() => {
        if (!opener.isConnected || document.activeElement !== opener)
          focusOpener();
      });
    } else requestAnimationFrame(focusOpener);
  };

  return (
    <div class="flex h-dvh min-h-0 flex-col overflow-hidden bg-bg text-text">
      <AppBar
        leading={
          <Show when={narrow() && itemSelected()}>
            <A
              href={backHref()}
              data-testid="mobile-back"
              class="whitespace-nowrap text-xs text-accent"
            >
              ← Back to list
            </A>
          </Show>
        }
        chips={
          <div class="flex min-w-0 items-center gap-1">
            <Show when={navChip()}>
              <RestorePopover
                pane="nav"
                label="Navigation"
                canRestore={full() || mode() === "split"}
                onRestore={() => dispatch({ type: "restore", pane: "nav" })}
              >
                {nav()}
              </RestorePopover>
            </Show>
            <Show when={participantsChip()}>
              <RestorePopover
                pane="participants"
                label="Participants"
                canRestore={full()}
                onRestore={() =>
                  dispatch({ type: "restore", pane: "participants" })
                }
              >
                <ParticipantsPane participants={participants} />
              </RestorePopover>
            </Show>
            <Show when={listChip()}>
              <button
                type="button"
                data-testid="pane-chip-list"
                class="rounded-md px-2 py-1 text-xs text-muted hover:bg-soft"
                onClick={restoreList}
              >
                List ▾
              </button>
            </Show>
          </div>
        }
        onOpenNav={() => {
          navOpener = document.activeElement as HTMLElement | null;
          setNavOpen(true);
        }}
        searchProjectId={activeProjectId() ?? undefined}
      />
      <div
        class={cn("flex min-h-0 flex-1", mode() === "single" && "relative")}
        data-layout-mode={mode()}
      >
        <aside
          data-pane="nav"
          aria-hidden={!showLeft()}
          class={cn(
            "flex min-h-0 w-[240px] flex-none flex-col overflow-hidden border-r border-hairline bg-nav",
            !showLeft() && "hidden",
            (hiddenByMaximize("nav") || hiddenByMaximize("participants")) &&
              "w-full",
          )}
        >
          <Show when={navVisibleOutsidePopover()}>
            <section class="flex min-h-0 flex-1 flex-col">
              <PaneHeader
                title="Navigation"
                pane="nav"
                layout={layoutState()}
                setLayout={dispatch}
                controls={full()}
              />
              <div class="min-h-0 flex-1 overflow-y-auto">{nav()}</div>
            </section>
          </Show>
          <Show when={participantsVisibleOutsidePopover()}>
            <section
              class={cn(
                "flex min-h-0 flex-col overflow-y-auto border-t border-hairline",
                activeMaximized() === "participants"
                  ? "flex-1"
                  : "max-h-[40%] flex-none",
              )}
            >
              <PaneHeader
                title="Participants"
                pane="participants"
                layout={layoutState()}
                setLayout={dispatch}
                controls={full()}
              />
              <ParticipantsPane participants={participants} />
            </section>
          </Show>
        </aside>
        <ListPane
          visible={showList()}
          full={full()}
          fillRemaining={mode() === "split" && showLeft()}
          maximized={activeMaximized() === "list"}
          width={layoutState().listWidth}
          header={
            <PaneHeader
              title={
                query() === "in:inbox" || query() === ""
                  ? "Inbox"
                  : `Search "${query()}"`
              }
              pane="list"
              count={projectCount()}
              layout={layoutState()}
              setLayout={dispatch}
              controls={full()}
            />
          }
          query={queryDraft()}
          onQueryInput={setSearchQuery}
        >
          <ProjectListBody
            projects={ws.projects.data()}
            activeProjectId={activeProjectId()}
            query={query()}
            loading={ws.projects.loading()}
            error={ws.projects.error()}
            onRetry={ws.projects.reload}
            connectionUnauthorized={ws.connection.state() === "unauthorized"}
            connectionDetail={ws.connection.detail()}
          />
        </ListPane>
        <Show when={showDivider()}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize list"
            aria-valuenow={layoutState().listWidth}
            aria-valuemin={MIN_LIST_WIDTH}
            aria-valuemax={MAX_LIST_WIDTH}
            tabindex={0}
            data-testid="list-divider"
            class="z-10 -mx-1 w-2 flex-none cursor-col-resize touch-none bg-transparent outline-none hover:bg-accent-soft focus-visible:bg-accent-soft"
            onKeyDown={resizeFromKeyboard}
            onDblClick={() =>
              dispatch({ type: "set-list-width", width: DEFAULT_LIST_WIDTH })
            }
            onPointerDown={(event) => {
              dragPointerId = event.pointerId;
              dragStartX = event.clientX;
              dragStartWidth = layoutState().listWidth;
              if (typeof event.currentTarget.setPointerCapture === "function") {
                event.currentTarget.setPointerCapture(event.pointerId);
              }
            }}
            onPointerMove={(event) => {
              if (dragPointerId === event.pointerId) {
                dispatch(
                  {
                    type: "set-list-width",
                    width: dragStartWidth + event.clientX - dragStartX,
                  },
                  { persist: false },
                );
              }
            }}
            onPointerUp={(event) => finishDividerDrag(event.pointerId)}
            onPointerCancel={(event) => finishDividerDrag(event.pointerId)}
            onLostPointerCapture={(event) => finishDividerDrag(event.pointerId)}
          />
        </Show>
        <main
          data-pane="document"
          data-testid="document-pane"
          aria-label="Document"
          hidden={!showDocument()}
          class={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface @container",
            !showDocument() && "hidden",
          )}
        >
          <Show
            when={full()}
            fallback={
              <div class="flex h-9 flex-none items-center px-3 text-xs text-muted">
                Document
              </div>
            }
          >
            <PaneHeader
              title="Document"
              pane="document"
              layout={layoutState()}
              setLayout={dispatch}
              controls
            />
          </Show>
          <div class="min-h-0 flex-1 overflow-auto">{outlet()}</div>
        </main>
      </div>
      <Show when={mode() === "single"}>
        <DialogPrimitive.Root open={navOpen()} onOpenChange={setDrawerOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay class="fixed inset-0 z-40 bg-black/40" />
            <DialogPrimitive.Content
              class="fixed inset-y-0 left-0 z-50 w-[260px] max-w-[85vw] overflow-y-auto bg-nav shadow-xl outline-none"
              aria-label="Navigation"
              data-testid="nav-drawer"
              onClick={(event: MouseEvent) => {
                if ((event.target as HTMLElement).closest("a"))
                  setDrawerOpen(false);
              }}
            >
              <DialogPrimitive.CloseButton class="absolute right-3 top-3 rounded-md px-2 py-1 text-sm text-muted hover:bg-soft">
                Close
              </DialogPrimitive.CloseButton>
              {nav()}
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      </Show>
    </div>
  );
};
