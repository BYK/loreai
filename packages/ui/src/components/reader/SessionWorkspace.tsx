/**
 * Session workspace (#1924): transcript and context sit side by side at lg,
 * with Kobalte tabs below it. Both panels and their scroll containers stay
 * mounted across tab and breakpoint changes to preserve reader state.
 */
import type { Component, JSX } from "solid-js";
import { children, createSignal, onCleanup } from "solid-js";

import { PaneHead } from "~/components/lore/Panes";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";

// Match Tailwind lg in rem so browser font preferences affect both layouts.
const DESKTOP_QUERY = "(min-width: 64rem)";

function desktopQuery(): boolean {
  return globalThis.matchMedia?.(DESKTOP_QUERY)?.matches ?? false;
}

export const SessionWorkspace: Component<{
  transcript: JSX.Element;
  context: JSX.Element;
}> = (props) => {
  const [desktop, setDesktop] = createSignal(desktopQuery());
  const [tab, setTab] = createSignal("transcript");
  const transcript = children(() => props.transcript);
  const contextPane = children(() => props.context);
  const media = globalThis.matchMedia?.(DESKTOP_QUERY);
  const onChange = (event: MediaQueryListEvent) => setDesktop(event.matches);
  media?.addEventListener?.("change", onChange);
  onCleanup(() => media?.removeEventListener?.("change", onChange));

  return (
    <Tabs
      value={tab()}
      onChange={setTab}
      class="flex h-full min-h-0 flex-col overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_340px]"
    >
      <TabsList
        aria-label="Session panes"
        hidden={desktop()}
        class="h-auto justify-start gap-1 rounded-none border-b border-line px-2 py-1.5 [hidden]:hidden"
      >
        <TabsTrigger
          value="transcript"
          id="session-tab-transcript"
          data-testid="session-tab-transcript"
          class="text-[13px]"
        >
          Transcript
        </TabsTrigger>
        <TabsTrigger
          value="context"
          id="session-tab-context"
          data-testid="session-tab-context"
          class="text-[13px]"
        >
          Context window
        </TabsTrigger>
      </TabsList>
      {/* forceMount preserves each child; hidden separately hides the inactive
          mobile pane because Kobalte's forceMount keeps its panel visible. */}
      <TabsContent
        value="transcript"
        id="session-panel-transcript"
        forceMount
        hidden={!desktop() && tab() !== "transcript"}
        role={desktop() ? "presentation" : "tabpanel"}
        tabIndex={desktop() ? -1 : 0}
        aria-labelledby={desktop() ? "" : "session-tab-transcript"}
        class="mt-0 min-h-0 min-w-0 flex-1 overflow-hidden max-lg:[&>*]:h-full"
      >
        {transcript()}
      </TabsContent>
      <TabsContent
        value="context"
        id="session-panel-context"
        forceMount
        hidden={!desktop() && tab() !== "context"}
        role={desktop() ? "presentation" : "tabpanel"}
        tabIndex={desktop() ? -1 : 0}
        aria-labelledby={desktop() ? "" : "session-tab-context"}
        class="mt-0 min-h-0 flex-1 overflow-y-auto lg:h-full"
      >
        <aside
          data-pane="context"
          aria-label="Context window"
          class="h-full min-h-0 overflow-y-auto border-l border-line bg-surface"
        >
          <PaneHead title="Context window" />
          {contextPane()}
        </aside>
      </TabsContent>
    </Tabs>
  );
};
