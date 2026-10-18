import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { VersionDiff } from "~/components/lore/VersionDiff";
import type { KnowledgeVersion } from "~/contracts";

const version = (
  n: number,
  title: string,
  content: string,
): KnowledgeVersion => ({
  version_id: `v${n}`,
  version: n,
  created_at: n,
  superseded_at: n === 1 ? 2 : null,
  is_current: n === 2,
  is_deleted: false,
  title,
  content,
  category: "decision",
  confidence: 0.8,
  scope: "project",
  cross_project: false,
  source_refs: {
    session_id: null,
    entry_id: "k",
    user_id: null,
    created_by: null,
    updated_by: null,
    worker_provider_id: null,
    worker_model_id: null,
  },
});

function renderComparison() {
  return render(() => (
    <VersionDiff
      previous={version(1, "Old title", "Use SQLite.\n\tKeep café <old>.")}
      version={version(2, "New title", "Use Postgres.\n\tKeep café <new>.")}
    />
  ));
}

describe("VersionDiff view selection", () => {
  it("keeps exactly one view selected when repeatedly clicking either option", () => {
    renderComparison();
    const changes = screen.getByRole("button", { name: "Changes" });
    const full = screen.getByRole("button", { name: "Full text" });
    for (const option of [changes, full, full, changes, changes]) {
      fireEvent.click(option);
      expect(option).toHaveAttribute("aria-pressed", "true");
      expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
    }
    expect(screen.getByRole("group", { name: "Version 2 view" })).toBeVisible();
  });

  it("navigates with arrows and Home/End, then activates views with Space/Enter", async () => {
    renderComparison();
    const changes = screen.getByRole("button", { name: "Changes" });
    const full = screen.getByRole("button", { name: "Full text" });
    changes.focus();
    fireEvent.keyDown(changes, { key: "ArrowRight" });
    await waitFor(() => expect(full).toHaveFocus());
    expect(changes).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(full, { key: " " });
    expect(full).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(full, { key: " " });
    expect(full).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(full, { key: "Home" });
    await waitFor(() => expect(changes).toHaveFocus());
    fireEvent.keyDown(changes, { key: "Enter" });
    expect(changes).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(changes, { key: "End" });
    await waitFor(() => expect(full).toHaveFocus());
    fireEvent.keyDown(full, { key: "ArrowLeft" });
    await waitFor(() => expect(changes).toHaveFocus());
    expect(changes).toHaveAttribute("aria-pressed", "true");
  });

  it("preserves exact content and inert markup in both views", () => {
    const view = renderComparison();
    const title = screen.getByTestId("version-title");
    const content = screen.getByTestId("version-content");
    expect(title.querySelector("del")?.textContent).toBe("Old");
    expect(title.querySelector("ins")?.textContent).toBe("New");
    expect(content.textContent).toBe(
      "Use SQLitePostgres.\n\tKeep café <oldnew>.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Full text" }));
    expect(title.textContent).toBe("New title");
    expect(content.textContent).toBe("Use Postgres.\n\tKeep café <new>.");
    expect(view.container.querySelector("ins, del, old, new")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    expect(content.querySelector("del")?.textContent).toBe("SQLite");
    expect(content.querySelector("ins")?.textContent).toBe("Postgres");
  });

  it("shows complete text without a selector when the comparison exceeds its budget", () => {
    const content = "new ".repeat(1000);
    render(() => (
      <VersionDiff
        previous={version(1, "Old title", "old ".repeat(1000))}
        version={version(2, "New title", content)}
      />
    ));
    expect(
      screen.getByText("Changes too large to compare. Showing full text."),
    ).toBeVisible();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByTestId("version-content").textContent).toBe(content);
  });
});
