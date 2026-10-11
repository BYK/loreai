import type { Component, JSX } from "solid-js";
import {
  children,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  A,
  type RouteSectionProps,
  useMatch,
  useLocation,
  useNavigate,
  useResolvedPath,
  useSearchParams,
} from "@solidjs/router";
import * as DialogPrimitive from "@kobalte/core/dialog";
import * as PopoverPrimitive from "@kobalte/core/popover";

import { useWorkspace } from "~/routes/workspace";
import { ActivityListBody } from "~/components/shell/ActivityListBody";
import { ActivityBulkToolbar } from "~/components/shell/ActivityBulkToolbar";
import { ParticipantsPane } from "~/components/shell/ParticipantsPane";
import { ListPane } from "~/components/shell/ListPane";
import { Nav } from "~/components/shell/Nav";
import { AppBar } from "~/components/shell/AppBar";
import { cn } from "~/lib/utils";
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
import { withWorkspaceQuery } from "~/lib/href";
import { savedSearches } from "~/state/saved-searches";
import {
  DEFAULT_ACTIVITY_QUERY,
  parseActivityQuery,
} from "@loreai/core/activity-query";
import type { ActivityItem } from "~/contracts";
import { activitySearchTitle } from "~/lib/activity-search";
import { ACTIVITY_KIND_UI } from "~/lib/activity-kinds";
import {
  activityItemKey,
  clientFilter,
  unreadCount,
} from "~/state/activity-filter";
import { deriveParticipants } from "~/state/activity-participants";
import { shouldHandleSpace } from "~/state/activity-navigation";
import {
  archive,
  folderNameError,
  markRead,
  markUnread,
  pin,
  unarchive,
  unpin,
} from "~/state/activity-local";
import type { ActivityFolderRecord, ActivityStateRecord } from "~/db";

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
    <header
      class="flex h-9 flex-none items-center gap-2 px-3 text-xs"
      data-testid={props.pane === "list" ? "activity-list-header" : undefined}
    >
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
}> = (props) => (
  <PopoverPrimitive.Root>
    <PopoverPrimitive.Trigger
      data-testid={`pane-chip-${props.pane}`}
      class="rounded-md px-2 py-1 text-xs text-muted hover:bg-soft"
    >
      {props.label} ▾
    </PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content class="z-50 w-64 rounded-md border border-hairline bg-surface p-2">
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

export const Workspace: Component<RouteSectionProps> = (props) => {
  const ws = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const outlet = children(() => props.children);
  const [search, setSearch] = useSearchParams<{ q?: string }>();
  const [searchDraft, setSearchDraft] = createSignal(
    typeof search.q === "string" ? search.q : "",
  );
  const [activityCount, setActivityCount] = createSignal(0);
  const [clock, setClock] = createSignal(Date.now());
  const [folderDialog, setFolderDialog] = createSignal<{
    folder: ActivityFolderRecord | null;
    moveSelection: boolean;
  } | null>(null);
  const [folderName, setFolderName] = createSignal("");
  const [layoutState, setLayoutState] = createSignal(loadPaneLayout());
  const [mode, setMode] = createSignal<LayoutMode>(currentMode());
  const [navOpen, setNavOpen] = createSignal(false);
  let navOpener: HTMLElement | null = null;
  let dragPointerId: number | null = null;
  let dragStartX = 0;
  let dragStartWidth = 0;

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
  const query = () => (typeof search.q === "string" ? search.q : "in:inbox");
  const queryInput = searchDraft;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(() => (typeof search.q === "string" ? search.q : ""), setSearchDraft),
  );
  onCleanup(() => clearTimeout(searchTimer));
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
      projects={ws.projects.data()}
      query={query()}
      folders={ws.state.activityLocal.snapshot().folders}
      onNewFolder={() => openFolderDialog()}
      onEditFolder={(folder) => openFolderDialog(folder)}
      onDeleteFolder={(key) => ws.state.activityLocal.deleteFolder(key)}
    />
  );
  const selectParticipant = (participant: { id: string }) =>
    commitSearchQuery(`with:${participant.id}`);
  let restoreActivityScroll:
    | ((scrollTop: number, index: number | null) => void)
    | undefined;
  const backHref = () => withWorkspaceQuery("/", query());
  function commitSearchQuery(value: string) {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    setSearch(
      {
        q:
          value.trim() === "" || value.trim() === DEFAULT_ACTIVITY_QUERY
            ? undefined
            : value.trim(),
      },
      { replace: true },
    );
  }
  function setSearchQuery(value: string) {
    setSearchDraft(value);
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => commitSearchQuery(value), 250);
  }
  const activityHeaderTitle = () => {
    const current = query();
    const saved = savedSearches()
      .list()
      .find((entry) => entry.query === current);
    return activitySearchTitle(current, activityCount(), saved?.title);
  };
  const parsedActivityQuery = createMemo(() => parseActivityQuery(query()));
  const visibleActivityItems = createMemo(() =>
    ws.activityList
      .items()
      .filter((item) =>
        clientFilter(
          item,
          parsedActivityQuery().client,
          ws.state.activityLocal.snapshot(),
        ),
      ),
  );
  const currentActivityItem = createMemo(() => {
    const items = ws.activityList.items();
    const currentKey = ws.activityList.currentKey();
    return (
      items.find(
        (item) =>
          activityItemKey(item) === currentKey &&
          ACTIVITY_KIND_UI[item.kind].isCurrent(item, location.pathname),
      ) ??
      items.find((item) =>
        ACTIVITY_KIND_UI[item.kind].isCurrent(item, location.pathname),
      )
    );
  });
  const participants = createMemo(() =>
    deriveParticipants(ws.activityList.items(), clock()),
  );
  const selectedRows = createMemo(() => {
    const selected = new Set(ws.activityList.selectedKeys());
    return ws.activityList
      .items()
      .filter((item) => selected.has(activityItemKey(item)));
  });
  const allVisibleSelected = () =>
    visibleActivityItems().length > 0 &&
    visibleActivityItems().every((item) =>
      ws.activityList.selectedKeys().includes(activityItemKey(item)),
    );
  const allSelectedPinned = () =>
    selectedRows().length > 0 &&
    selectedRows().every(
      (item) =>
        ws.state.activityLocal.record(activityItemKey(item)).pinned_at !==
        undefined,
    );
  const clearSelection = () => ws.activityList.setSelectedKeys([]);

  function toggleSelectAll(checked: boolean) {
    ws.activityList.setSelectedKeys(
      checked ? visibleActivityItems().map(activityItemKey) : [],
    );
  }

  function selectedActivitySnapshot() {
    return selectedRows().map((item) => ({
      item,
      key: activityItemKey(item),
    }));
  }

  function applyToSelected(
    transition: (
      item: ActivityItem,
      record: ActivityStateRecord,
    ) => ActivityStateRecord,
  ) {
    const selected = selectedActivitySnapshot();
    ws.state.activityLocal.applyBatch(
      selected.map(({ key, item }) => ({
        key,
        transition: (record) => transition(item, record),
      })),
    );
    clearSelection();
  }

  const openFolderDialog = (
    folder: ActivityFolderRecord | null = null,
    moveSelection = false,
  ) => {
    setFolderName(folder?.name ?? "");
    setFolderDialog({ folder, moveSelection });
  };
  const folderValidation = () =>
    folderNameError(
      folderName(),
      ws.state.activityLocal.snapshot().folders,
      folderDialog()?.folder?.key,
    );
  function saveFolder() {
    const current = folderDialog();
    if (!current || folderValidation()) return;
    const selected = current.moveSelection ? selectedActivitySnapshot() : [];
    const id = current.folder
      ? current.folder.key
      : ws.state.activityLocal.createFolder(folderName());
    if (current.folder) {
      ws.state.activityLocal.renameFolder(id, folderName());
    } else if (current.moveSelection) {
      ws.state.activityLocal.moveToFolder(
        selected.map(({ key }) => key),
        id,
      );
      clearSelection();
    }
    setFolderDialog(null);
  }

  const matchingIndex = () => {
    const current = currentActivityItem();
    if (!current) return -1;
    const visible = visibleActivityItems();
    const visibleIndex = visible.findIndex(
      (item) => activityItemKey(item) === activityItemKey(current),
    );
    if (visibleIndex >= 0) return visibleIndex;
    const loaded = ws.activityList.items();
    const currentIndex = loaded.findIndex(
      (item) => activityItemKey(item) === activityItemKey(current),
    );
    const after = visible.findIndex(
      (item) =>
        loaded.findIndex(
          (candidate) => activityItemKey(candidate) === activityItemKey(item),
        ) > currentIndex,
    );
    return after >= 0 ? after - 1 : visible.length - 1;
  };
  const hasNextUnread = () =>
    !!currentActivityItem() &&
    visibleActivityItems().some(
      (item) => unreadCount(item, ws.state.activityLocal.snapshot()) > 0,
    );
  function navigateToActivity(item: ActivityItem) {
    ws.activityList.setCurrentKey(activityItemKey(item));
    navigate(
      withWorkspaceQuery(ACTIVITY_KIND_UI[item.kind].href(item), query()),
    );
    if (ACTIVITY_KIND_UI[item.kind].readMode === "item") {
      queueMicrotask(() =>
        ws.state.activityLocal.markRead(activityItemKey(item), item.total),
      );
    }
  }
  function nextUnread(): boolean {
    const inDocument = ws.activityList.nextUnread();
    if (inDocument?.()) return true;
    const items = visibleActivityItems();
    if (!items.length) return false;
    const current = matchingIndex();
    for (let step = 1; step <= items.length; step++) {
      const item = items[(current + step + items.length) % items.length]!;
      if (unreadCount(item, ws.state.activityLocal.snapshot()) > 0) {
        navigateToActivity(item);
        return true;
      }
    }
    return false;
  }
  const nextItemTarget = () => {
    const current = currentActivityItem();
    const visible = visibleActivityItems();
    const currentVisibleIndex = current
      ? visible.findIndex(
          (item) => activityItemKey(item) === activityItemKey(current),
        )
      : -1;
    const loaded = ws.activityList.items();
    const currentLoadedIndex = current
      ? loaded.findIndex(
          (item) => activityItemKey(item) === activityItemKey(current),
        )
      : -1;
    return currentVisibleIndex >= 0
      ? visible[currentVisibleIndex + 1]
      : visible.find(
          (item) =>
            loaded.findIndex(
              (candidate) =>
                activityItemKey(candidate) === activityItemKey(item),
            ) > currentLoadedIndex,
        );
  };
  const nextItem = () => {
    const next = nextItemTarget();
    if (next) navigateToActivity(next);
  };

  createEffect(
    on(currentActivityItem, (item) => {
      if (!item) return;
      if (ACTIVITY_KIND_UI[item.kind].readMode === "item") {
        ws.state.activityLocal.markRead(activityItemKey(item), item.total);
      }
    }),
  );

  onMount(() => {
    const updateClock = () => setClock(Date.now());
    const timer = globalThis.setInterval(updateClock, 60_000);
    const keydown = (event: KeyboardEvent) => {
      if (!shouldHandleSpace(event)) return;
      if (!currentActivityItem() && location.pathname !== "/") return;
      if (nextUnread()) event.preventDefault();
    };
    document.addEventListener("keydown", keydown);
    onCleanup(() => {
      globalThis.clearInterval(timer);
      document.removeEventListener("keydown", keydown);
    });
  });

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
                <ParticipantsPane
                  participants={participants()}
                  onSelectParticipant={selectParticipant}
                />
              </RestorePopover>
            </Show>
            <Show when={listChip()}>
              <button
                type="button"
                data-testid="pane-chip-list"
                class="rounded-md px-2 py-1 text-xs text-muted hover:bg-soft"
                onClick={() => dispatch({ type: "restore", pane: "list" })}
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
            <section class="flex min-h-0 max-h-[40%] flex-none flex-col overflow-y-auto border-t border-hairline">
              <PaneHeader
                title="Participants"
                pane="participants"
                layout={layoutState()}
                setLayout={dispatch}
                controls={full()}
              />
              <ParticipantsPane
                participants={participants()}
                onSelectParticipant={selectParticipant}
              />
            </section>
          </Show>
        </aside>
        <ListPane
          visible={showList()}
          full={full()}
          maximized={activeMaximized() === "list"}
          width={layoutState().listWidth}
          header={
            <PaneHeader
              title={activityHeaderTitle()}
              pane="list"
              layout={layoutState()}
              setLayout={dispatch}
              controls={full()}
            />
          }
          query={queryInput()}
          onQueryInput={setSearchQuery}
          onCommitQuery={commitSearchQuery}
          hasSelection={ws.activityList.selectedKeys().length > 0}
          selectionControl={
            <input
              type="checkbox"
              aria-label="Select all visible activity"
              checked={allVisibleSelected()}
              class="accent-accent"
              onChange={(event) => toggleSelectAll(event.currentTarget.checked)}
            />
          }
          toolbar={
            <ActivityBulkToolbar
              allSelected={allVisibleSelected()}
              folders={ws.state.activityLocal.snapshot().folders}
              unpin={allSelectedPinned()}
              onSelectAll={toggleSelectAll}
              onRead={() =>
                applyToSelected((item, record) =>
                  markRead(record, item.total, Date.now()),
                )
              }
              onUnread={() =>
                applyToSelected((_item, record) =>
                  markUnread(record, Date.now()),
                )
              }
              onArchive={() =>
                applyToSelected((_item, record) => archive(record, Date.now()))
              }
              onInbox={() =>
                applyToSelected((_item, record) => unarchive(record))
              }
              onPin={() => {
                const shouldUnpin = allSelectedPinned();
                applyToSelected((_item, record) =>
                  shouldUnpin ? unpin(record) : pin(record, Date.now()),
                );
              }}
              onMove={(folderId) => {
                ws.state.activityLocal.moveToFolder(
                  selectedActivitySnapshot().map(({ key }) => key),
                  folderId,
                );
                clearSelection();
              }}
              onNewFolder={() => openFolderDialog(null, true)}
              onClear={clearSelection}
            />
          }
          restoreVirtualizedScroll={(scrollTop, index) =>
            restoreActivityScroll?.(scrollTop, index)
          }
        >
          <ActivityListBody
            query={query()}
            onCountChange={setActivityCount}
            onVirtualizedScrollRestore={(restore) =>
              (restoreActivityScroll = restore)
            }
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
          <Show when={currentActivityItem()}>
            <footer class="flex h-9 flex-none items-center justify-end gap-2 border-t border-hairline px-3 text-xs">
              <button
                type="button"
                data-testid="workspace-next-unread"
                disabled={!hasNextUnread()}
                class="rounded px-2 py-1 text-muted hover:bg-soft disabled:opacity-40"
                onClick={nextUnread}
              >
                Next unread
              </button>
              <button
                type="button"
                data-testid="workspace-next-item"
                disabled={!nextItemTarget()}
                class="rounded px-2 py-1 text-muted hover:bg-soft disabled:opacity-40"
                onClick={nextItem}
              >
                Next item
              </button>
            </footer>
          </Show>
        </main>
      </div>
      <Show when={folderDialog()}>
        {(dialog) => (
          <DialogPrimitive.Root
            open
            onOpenChange={(open) => {
              if (!open) setFolderDialog(null);
            }}
          >
            <DialogPrimitive.Portal>
              <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
                <DialogPrimitive.Overlay class="fixed inset-0 bg-background/80" />
                <DialogPrimitive.Content
                  aria-label={dialog().folder ? "Rename folder" : "New folder"}
                  class="relative z-50 w-full max-w-sm border border-hairline bg-surface p-5 text-text"
                >
                  <DialogPrimitive.Title class="text-sm font-medium">
                    {dialog().folder ? "Rename folder" : "New folder"}
                  </DialogPrimitive.Title>
                  <form
                    class="mt-4 flex flex-col gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveFolder();
                    }}
                  >
                    <label class="flex flex-col gap-1 text-xs">
                      Name
                      <input
                        aria-label="Folder name"
                        data-testid="activity-folder-name"
                        class="h-9 border border-hairline bg-transparent px-2 text-sm"
                        value={folderName()}
                        onInput={(event) =>
                          setFolderName(event.currentTarget.value)
                        }
                      />
                    </label>
                    <Show when={folderValidation()}>
                      {(message) => (
                        <p role="alert" class="text-xs text-danger">
                          {message()}
                        </p>
                      )}
                    </Show>
                    <div class="flex justify-end gap-2">
                      <button
                        type="button"
                        class="rounded px-3 py-1.5 text-xs text-muted hover:bg-soft"
                        onClick={() => setFolderDialog(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        data-testid="activity-folder-save"
                        disabled={!!folderValidation()}
                        class="rounded bg-selected px-3 py-1.5 text-xs text-selected-text disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  </form>
                </DialogPrimitive.Content>
              </div>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>
        )}
      </Show>
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
