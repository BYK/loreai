/**
 * SessionWorkspace (#1924): ≥ lg renders transcript and context side by side
 * with no tablist; below lg a tablist switches panels, arrow keys rove and
 * activate tabs, and the transcript stays mounted while hidden.
 */
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, onCleanup, onMount } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionWorkspace } from "~/components/reader/SessionWorkspace";

const CONTENT = <div data-testid="context-content">context body</div>;
const TRANSCRIPT = <div data-testid="transcript-content">transcript body</div>;

function mockDesktop(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

function mount() {
  return render(() => (
    <SessionWorkspace transcript={TRANSCRIPT} context={CONTENT} />
  ));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionWorkspace", () => {
  it("renders the aside and no tablist on desktop", () => {
    mockDesktop(true);
    mount();
    expect(screen.getByTestId("transcript-content")).toBeInTheDocument();
    expect(screen.getByLabelText("Context window")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(document.getElementById("session-panel-transcript")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(document.getElementById("session-panel-context")).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("shows tabs below lg and switches panels, keeping the transcript mounted", () => {
    mockDesktop(false);
    mount();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const transcriptPanel = document.getElementById(
      "session-panel-transcript",
    )!;
    const contextPanel = document.getElementById("session-panel-context")!;
    expect(transcriptPanel.hidden).toBe(false);
    expect(contextPanel.hidden).toBe(true);
    expect(screen.getByTestId("context-content")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("session-tab-context"));
    expect(transcriptPanel.hidden).toBe(true);
    expect(contextPanel.hidden).toBe(false);
    // The transcript stays mounted — its DOM is still there, just hidden.
    expect(screen.getByTestId("transcript-content")).toBeInTheDocument();
  });

  it("tracks the rem breakpoint with a larger browser default font", () => {
    let width = 1152;
    const media: {
      matches: () => boolean;
      listeners: Set<(event: MediaQueryListEvent) => void>;
    }[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      const match = query.match(/min-width:\s*([\d.]+)(px|rem)/);
      if (!match) throw new Error(`Unsupported media query: ${query}`);
      const [, amount, unit] = match;
      // Media-query rem units use the browser's initial font, not author CSS.
      const threshold = Number(amount) * (unit === "rem" ? 20 : 1);
      const entry = {
        matches: () => width >= threshold,
        listeners: new Set<(event: MediaQueryListEvent) => void>(),
      };
      media.push(entry);
      return {
        get matches() {
          return entry.matches();
        },
        addEventListener: (
          _: string,
          listener: (event: MediaQueryListEvent) => void,
        ) => entry.listeners.add(listener),
        removeEventListener: (
          _: string,
          listener: (event: MediaQueryListEvent) => void,
        ) => entry.listeners.delete(listener),
      };
    });
    const resize = (next: number) => {
      const before = media.map((entry) => entry.matches());
      width = next;
      media.forEach((entry, index) => {
        if (before[index] !== entry.matches())
          entry.listeners.forEach((listener) =>
            listener({ matches: entry.matches() } as MediaQueryListEvent),
          );
      });
    };
    mount();
    expect(screen.getByRole("tablist")).toBeVisible();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    const transcript = screen.getByTestId("transcript-content");
    fireEvent.click(screen.getByTestId("session-tab-context"));
    resize(1280);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByTestId("context-content")).toBeVisible();
    expect(transcript).toBeVisible();
    resize(1152);
    expect(screen.getByRole("tablist")).toBeVisible();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByTestId("session-tab-context")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(transcript).not.toBeVisible();
    expect(screen.getByTestId("transcript-content")).toBe(transcript);
  });

  it("uses the available pane width instead of the viewport width", () => {
    mockDesktop(true);
    let resize = (_width: number, _target: Element) => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = (width, target) =>
            callback(
              [
                {
                  target,
                  contentRect: { width } as DOMRectReadOnly,
                } as ResizeObserverEntry,
              ],
              this as unknown as ResizeObserver,
            );
        }

        observe(target: Element) {
          resize(800, target);
        }

        disconnect() {}
      },
    );

    mount();
    expect(screen.getByRole("tablist")).toBeInTheDocument();

    resize(900, screen.getByRole("tablist"));
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("keeps the same transcript DOM node across a breakpoint flip", () => {
    let matches = false;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      get matches() {
        return matches;
      },
      addEventListener: (_type: string, l: (e: MediaQueryListEvent) => void) =>
        listeners.add(l),
      removeEventListener: (
        _type: string,
        l: (e: MediaQueryListEvent) => void,
      ) => listeners.delete(l),
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    mount();
    const before = screen.getByTestId("transcript-content");
    expect(before).toBeInTheDocument();
    matches = true;
    for (const l of listeners) l({ matches } as MediaQueryListEvent);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByTestId("transcript-content")).toBe(before);
  });

  it.each([false, true])(
    "preserves both panes and their scroll containers across tab and breakpoint changes (desktop=%s)",
    (initialDesktop) => {
      let matches = initialDesktop;
      const listeners = new Set<(e: MediaQueryListEvent) => void>();
      vi.stubGlobal("matchMedia", () => ({
        get matches() {
          return matches;
        },
        addEventListener: (
          _: string,
          listener: (e: MediaQueryListEvent) => void,
        ) => listeners.add(listener),
        removeEventListener: (
          _: string,
          listener: (e: MediaQueryListEvent) => void,
        ) => listeners.delete(listener),
      }));
      const mounts = vi.fn();
      const cleanups = vi.fn();
      function StatefulPane(props: { name: string }) {
        const [count, setCount] = createSignal(0);
        onMount(mounts);
        onCleanup(cleanups);
        return (
          <button
            data-testid={props.name}
            onClick={() => setCount(count() + 1)}
          >
            {count()}
          </button>
        );
      }
      const { unmount } = render(() => (
        <SessionWorkspace
          transcript={<StatefulPane name="stateful-transcript" />}
          context={<StatefulPane name="stateful-context" />}
        />
      ));
      const transcript = screen.getByTestId("stateful-transcript");
      const context = screen.getByTestId("stateful-context");
      const transcriptContainer = transcript.parentElement!;
      const contextContainer = context.closest("aside")!.parentElement!;
      transcriptContainer.scrollTop = 125;
      contextContainer.scrollTop = 85;
      fireEvent.click(transcript);
      fireEvent.click(context);
      function resize(desktop: boolean) {
        matches = desktop;
        for (const listener of listeners)
          listener({ matches } as MediaQueryListEvent);
      }
      resize(false);
      fireEvent.click(screen.getByTestId("session-tab-context"));
      resize(true);
      expect(screen.queryByRole("tablist")).toBeNull();
      resize(false);
      expect(screen.getByTestId("session-tab-context")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      fireEvent.click(screen.getByTestId("session-tab-transcript"));
      expect(transcript.parentElement).toBe(transcriptContainer);
      expect(context.closest("aside")!.parentElement).toBe(contextContainer);
      expect(transcriptContainer.scrollTop).toBe(125);
      expect(contextContainer.scrollTop).toBe(85);
      expect(transcript).toHaveTextContent("1");
      expect(context).toHaveTextContent("1");
      expect(mounts).toHaveBeenCalledTimes(2);
      expect(cleanups).not.toHaveBeenCalled();
      unmount();
      expect(cleanups).toHaveBeenCalledTimes(2);
      expect(listeners.size).toBe(0);
    },
  );

  it("keeps one selected tab with linked panels through keyboard navigation", () => {
    mockDesktop(false);
    mount();
    const transcriptTab = screen.getByTestId("session-tab-transcript");
    const contextTab = screen.getByTestId("session-tab-context");
    function expectSelected(selected: HTMLElement, other: HTMLElement) {
      expect(screen.getAllByRole("tab", { selected: true })).toEqual([
        selected,
      ]);
      expect(selected).toHaveAttribute("tabindex", "0");
      expect(other).toHaveAttribute("tabindex", "-1");
      const panel = screen.getByRole("tabpanel");
      expect(selected).toHaveAttribute("aria-controls", panel.id);
      expect(panel).toHaveAttribute("aria-labelledby", selected.id);
      expect(panel.hidden).toBe(false);
      expect(panel).toHaveAttribute("tabindex", "0");
      expect(
        document.querySelector<HTMLElement>(
          `[role="tabpanel"]:not(#${panel.id})`,
        )!.hidden,
      ).toBe(true);
    }
    transcriptTab.focus();
    expectSelected(transcriptTab, contextTab);
    for (const [key, expected] of [
      ["ArrowRight", contextTab],
      ["ArrowRight", transcriptTab],
      ["ArrowLeft", contextTab],
      ["Home", transcriptTab],
      ["End", contextTab],
      ["Enter", contextTab],
      [" ", contextTab],
    ] as const) {
      fireEvent.keyDown(document.activeElement!, { key });
      expect(expected).toHaveFocus();
      expectSelected(
        expected,
        expected === transcriptTab ? contextTab : transcriptTab,
      );
    }
    fireEvent.click(transcriptTab);
    expectSelected(transcriptTab, contextTab);
  });
});
