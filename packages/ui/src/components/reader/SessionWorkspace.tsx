/**
 * Session workspace (#1924): the transcript plus its context-window pane.
 * At ≥ lg (1024px, Tailwind's default `lg` breakpoint) they sit side by
 * side; below that a tablist switches between them. The transcript stays
 * mounted while hidden — unmounting would drop `SessionView`'s selection
 * and virtualiser state — so panels toggle the `hidden` attribute, and tab
 * switching follows the roving-tabindex / arrow-key pattern.
 */
import type { Component, JSX } from "solid-js";
import { createSignal, onCleanup, Show } from "solid-js";

import { PaneHead } from "~/components/lore/Panes";
import { cn } from "~/lib/utils";

type Tab = "transcript" | "context";

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: "transcript", label: "Transcript", testId: "session-tab-transcript" },
  { id: "context", label: "Context window", testId: "session-tab-context" },
];

function desktopQuery(): boolean {
  return globalThis.matchMedia?.("(min-width: 1024px)")?.matches ?? false;
}

export const SessionWorkspace: Component<{
  transcript: JSX.Element;
  context: JSX.Element;
}> = (props) => {
  const [desktop, setDesktop] = createSignal(desktopQuery());
  const [tab, setTab] = createSignal<Tab>("transcript");

  const media = globalThis.matchMedia?.("(min-width: 1024px)");
  const onChange = (event: MediaQueryListEvent) => setDesktop(event.matches);
  media?.addEventListener?.("change", onChange);
  onCleanup(() => media?.removeEventListener?.("change", onChange));

  function onTabKeyDown(event: KeyboardEvent, current: Tab) {
    const index = TABS.findIndex((t) => t.id === current);
    let next = -1;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % TABS.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + TABS.length) % TABS.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = TABS.length - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        setTab(current);
        return;
      default:
        return;
    }
    event.preventDefault();
    const target = TABS[next]!;
    setTab(target.id);
    (event.currentTarget as HTMLElement).parentElement
      ?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)
      ?.focus();
  }

  const contextPanel = (
    <aside
      data-pane="context"
      aria-label="Context window"
      class="border-l border-line bg-surface lg:h-[calc(100dvh-62px)] lg:overflow-y-auto"
    >
      <PaneHead title="Context window" />
      {props.context}
    </aside>
  );

  return (
    <Show
      when={desktop()}
      fallback={
        <div class="flex h-[calc(100dvh-62px)] min-h-0 flex-col">
          <div
            role="tablist"
            aria-label="Session panes"
            class="flex gap-1 border-b border-line bg-chrome px-2 py-1.5"
          >
            {TABS.map((t) => (
              <button
                type="button"
                role="tab"
                data-tab={t.id}
                data-testid={t.testId}
                id={`session-tab-${t.id}`}
                aria-controls={`session-panel-${t.id}`}
                aria-selected={tab() === t.id}
                tabIndex={tab() === t.id ? 0 : -1}
                class={cn(
                  "rounded-md px-3 py-1.5 text-[13px] font-medium text-muted outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tab() === t.id && "bg-surface text-text",
                )}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onTabKeyDown(e, t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="session-panel-transcript"
            aria-labelledby="session-tab-transcript"
            class="min-h-0 flex-1"
            hidden={tab() !== "transcript"}
          >
            {props.transcript}
          </div>
          <div
            role="tabpanel"
            id="session-panel-context"
            aria-labelledby="session-tab-context"
            class="min-h-0 flex-1 overflow-y-auto"
            hidden={tab() !== "context"}
          >
            {contextPanel}
          </div>
        </div>
      }
    >
      <div class="grid lg:grid-cols-[minmax(0,1fr)_340px]">
        <div class="min-w-0">{props.transcript}</div>
        {contextPanel}
      </div>
    </Show>
  );
};
