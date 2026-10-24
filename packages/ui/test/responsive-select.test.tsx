import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponsiveSelect } from "~/components/ui/responsive-select";

afterEach(() => vi.unstubAllGlobals());
function mount(mobile: boolean) {
  vi.stubGlobal("matchMedia", () => ({
    matches: !mobile,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const [value, setValue] = createSignal<string | null>("recent");
  const change = vi.fn((next: string | null) => setValue(next));
  const [options, setOptions] = createSignal(["recent", "title", ""]);
  render(() => (
    <ResponsiveSelect
      label="List sort"
      sheetTitle="Sort knowledge"
      value={value()}
      options={options()}
      optionLabel={(key) =>
        ({ recent: "Recently updated", title: "Title A–Z", "": "Default" })[
          key
        ] ?? key
      }
      onChange={change}
    />
  ));
  return { change, setOptions };
}

describe("Responsive selection", () => {
  it("uses a mobile sheet without changing selection on open or navigation", async () => {
    const { change } = mount(true);
    fireEvent.click(screen.getByRole("button", { name: "List sort" }));
    const sheet = screen.getByRole("dialog", { name: "Sort knowledge" });
    expect(sheet).toHaveAttribute("data-select-presentation", "sheet");
    expect(
      screen.getByRole("option", { name: "Recently updated" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Title A–Z" }));
    expect(change).toHaveBeenCalledExactlyOnceWith("title");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("dismisses without applying and can select the empty default", async () => {
    const { change } = mount(true);
    fireEvent.click(screen.getByRole("button", { name: "List sort" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "List sort" }));
    fireEvent.click(screen.getByRole("option", { name: "Default" }));
    expect(change).toHaveBeenCalledExactlyOnceWith("");
  });
  it("closes a mobile sheet when reselecting the current option without changing the query", async () => {
    const { change } = mount(true);
    fireEvent.click(screen.getByRole("button", { name: "List sort" }));
    fireEvent.click(screen.getByRole("option", { name: "Recently updated" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(change).not.toHaveBeenCalled();
  });
  it("keeps a desktop dropdown and its selected label", async () => {
    mount(false);
    fireEvent.pointerDown(screen.getByRole("button", { name: /^List sort/ }), {
      pointerId: 1,
      button: 0,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: "Title A–Z" }));
    expect(
      screen.getByRole("button", { name: /^List sort/ }),
    ).toHaveTextContent("Title A–Z");
  });
});

describe.each([false, true])("Async choice updates (mobile=%s)", (mobile) => {
  it("preserves the current value when options refresh", async () => {
    const { change, setOptions } = mount(mobile);
    const trigger = screen.getByRole("button", { name: /^List sort/ });
    if (mobile) fireEvent.click(trigger);
    else fireEvent.pointerDown(trigger, { pointerId: 1, button: 0 });
    setOptions(["recent", "title", "other", ""]);
    if (mobile) {
      await screen.findByRole("option", { name: "other" });
      expect(
        screen.getByRole("dialog", { name: "Sort knowledge" }),
      ).toBeInTheDocument();
    }
    expect(change).not.toHaveBeenCalled();
  });
});
