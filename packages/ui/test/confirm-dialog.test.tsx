import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "~/components/ui/confirm-dialog";

describe("ConfirmDialog", () => {
  it("separates confirmation validation from pending cancellation", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const [blocked, setBlocked] = createSignal(true);
    const [pending, setPending] = createSignal(false);
    render(() => (
      <ConfirmDialog
        open
        title="Publish report"
        description="The report becomes public."
        confirmLabel="Publish"
        confirmDisabled={blocked()}
        pending={pending()}
        pendingLabel="Publishing…"
        contentTestId="report-confirmation"
        confirmTestId="publish-report"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    ));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Publish report",
    });
    expect(dialog).toHaveAttribute("data-testid", "report-confirmation");
    expect(dialog).toHaveAccessibleDescription("The report becomes public.");
    const confirm = screen.getByRole("button", { name: "Publish" });
    expect(confirm).toHaveAttribute("data-testid", "publish-report");
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    setBlocked(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    setPending(true);
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    setPending(false);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});
