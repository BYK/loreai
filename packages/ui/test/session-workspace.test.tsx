/**
 * SessionWorkspace keeps both panes mounted and switches them with container
 * queries rather than viewport JavaScript.
 */
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { SessionWorkspace } from "~/components/reader/SessionWorkspace";

const CONTENT = <div data-testid="context-content">context body</div>;
const TRANSCRIPT = <div data-testid="transcript-content">transcript body</div>;

function mount() {
  return render(() => (
    <SessionWorkspace transcript={TRANSCRIPT} context={CONTENT} />
  ));
}

describe("SessionWorkspace", () => {
  it("uses container queries and keeps both panes mounted", () => {
    mount();
    expect(screen.getByRole("tablist")).toHaveClass("@5xl:hidden");
    expect(document.getElementById("session-panel-context")).toHaveClass(
      "@5xl:block",
    );
    expect(screen.getByTestId("transcript-content")).toBeInTheDocument();
    expect(screen.getByTestId("context-content")).toBeInTheDocument();
  });

  it("switches narrow-screen panels without unmounting the transcript", () => {
    mount();
    const transcriptPanel = document.getElementById(
      "session-panel-transcript",
    )!;
    const contextPanel = document.getElementById("session-panel-context")!;
    const transcript = screen.getByTestId("transcript-content");
    expect(transcriptPanel).not.toHaveClass("hidden");
    expect(contextPanel).toHaveClass("hidden");

    fireEvent.click(screen.getByTestId("session-tab-context"));
    expect(transcriptPanel).toHaveClass("hidden");
    expect(contextPanel).not.toHaveClass("hidden");
    expect(screen.getByTestId("transcript-content")).toBe(transcript);
  });

  it("roves tabs with arrow keys and activates on Enter/Space", () => {
    mount();
    const transcriptTab = screen.getByTestId("session-tab-transcript");
    const contextTab = screen.getByTestId("session-tab-context");
    transcriptTab.focus();
    fireEvent.keyDown(transcriptTab, { key: "ArrowRight" });
    expect(contextTab).toHaveAttribute("aria-selected", "true");
    expect(contextTab).toHaveFocus();
    expect(document.getElementById("session-panel-context")).not.toHaveClass(
      "hidden",
    );
    fireEvent.keyDown(contextTab, { key: "ArrowLeft" });
    expect(transcriptTab).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("session-panel-context")).toHaveClass(
      "hidden",
    );
    fireEvent.keyDown(transcriptTab, { key: "End" });
    expect(contextTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(contextTab, { key: "Home" });
    expect(transcriptTab).toHaveAttribute("aria-selected", "true");
  });
});
