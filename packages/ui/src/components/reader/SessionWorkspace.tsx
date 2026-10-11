/**
 * Session workspace (#1924): the transcript plus its context-window pane.
 * The document container controls when the context pane sits beside the
 * transcript; narrower containers use a tablist to switch between them.
 */
import type { Component, JSX } from "solid-js";
import { children, createSignal } from "solid-js";

import { PaneHead } from "~/components/lore/Panes";
import { cn } from "~/lib/utils";

type Tab = "transcript" | "context";

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: "transcript", label: "Transcript", testId: "session-tab-transcript" },
  { id: "context", label: "Context window", testId: "session-tab-context" },
];

export const SessionWorkspace: Component<{
  transcript: JSX.Element;
  context: JSX.Element;
}> = (props) => {
  const [tab, setTab] = createSignal<Tab>("transcript");
  // Resolve each child once so switching panels preserves reader state.
  const transcript = children(() => props.transcript);
  const contextPane = children(() => props.context);

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

  return (
    <div class="flex h-[calc(100dvh-84px)] min-h-0 flex-col overflow-hidden @container">
      <div
        role="tablist"
        aria-label="Session panes"
        class="flex gap-1 border-b border-line bg-chrome px-2 py-1.5 @5xl:hidden"
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
      <div class="grid min-h-0 flex-1 grid-cols-1 @5xl:grid-cols-[minmax(0,1fr)_340px]">
        <div
          role="tabpanel"
          id="session-panel-transcript"
          aria-labelledby="session-tab-transcript"
          class={cn(
            "min-h-0 overflow-hidden [&>*]:h-full @5xl:col-start-1 @5xl:row-start-1 @5xl:block",
            tab() !== "transcript" && "hidden",
          )}
        >
          {transcript()}
        </div>
        <aside
          data-pane="context"
          aria-label="Context window"
          role="tabpanel"
          id="session-panel-context"
          aria-labelledby="session-tab-context"
          class={cn(
            "min-h-0 overflow-y-auto @5xl:col-start-2 @5xl:row-start-1 @5xl:block @5xl:border-l @5xl:bg-surface",
            tab() !== "context" && "hidden",
          )}
        >
          <PaneHead title="Context window" />
          {contextPane()}
        </aside>
      </div>
    </div>
  );
};
