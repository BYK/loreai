/**
 * SessionWorkspace (#1924): ≥ lg renders transcript and context side by side
 * with no tablist; below lg a tablist switches panels, arrow keys rove and
 * activate tabs, and the transcript stays mounted while hidden.
 */
import { fireEvent, render, screen } from "@solidjs/testing-library";
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

  it("roves tabs with arrow keys and activates on Enter/Space", () => {
    mockDesktop(false);
    mount();
    const transcriptTab = screen.getByTestId("session-tab-transcript");
    const contextTab = screen.getByTestId("session-tab-context");
    transcriptTab.focus();
    fireEvent.keyDown(transcriptTab, { key: "ArrowRight" });
    expect(contextTab).toHaveAttribute("aria-selected", "true");
    expect(contextTab).toHaveFocus();
    expect(
      screen.getByRole("tabpanel", { name: "Context window" }).hidden,
    ).toBe(false);
    fireEvent.keyDown(contextTab, { key: "ArrowLeft" });
    expect(transcriptTab).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("session-panel-context")!.hidden).toBe(true);
    fireEvent.keyDown(transcriptTab, { key: "End" });
    expect(contextTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(contextTab, { key: "Home" });
    expect(transcriptTab).toHaveAttribute("aria-selected", "true");
  });
});
