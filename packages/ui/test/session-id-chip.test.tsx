import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { SessionIdChip } from "~/components/lore/SessionIdChip";

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("session id copy feedback", () => {
  it("reports failures and allows retry without announcing success", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    clipboard(write);
    render(() => <SessionIdChip id="session-one" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy session id" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/copy/i);
    expect(screen.queryByText("Copied")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy session id" }));
    await screen.findByText("Copied");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("prevents duplicate pending writes and announces confirmed completion", async () => {
    let resolve!: () => void;
    const write = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    clipboard(write);
    render(() => <SessionIdChip id="session-one" />);
    const button = screen.getByRole("button", { name: "Copy session id" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(write).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Copied")).toBeNull();
    resolve();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Copied"),
    );
  });

  it("ignores late success and failure after the session changes", async () => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    clipboard(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    const [id, setId] = createSignal("old-session");
    render(() => <SessionIdChip id={id()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy session id" }));
    setId("new-session");
    finish();
    await Promise.resolve();
    expect(screen.queryByText("Copied")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy session id" }));
    setId("third-session");
    fail(new Error("denied"));
    await Promise.resolve();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
