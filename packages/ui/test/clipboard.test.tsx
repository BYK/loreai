import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClipboard } from "~/lib/clipboard";
import { Button } from "~/components/ui/button";

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}
afterEach(() => vi.useRealTimers());

describe("clipboard action lifecycle", () => {
  it("invalidates a copy even when its source changes away and back", async () => {
    let done!: () => void;
    clipboard(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    const [source, setSource] = createSignal("first");
    let action!: ReturnType<typeof createClipboard>;
    render(() => {
      action = createClipboard(source);
      return <Button onClick={() => void action.copy(source())}>Copy</Button>;
    });
    fireEvent.click(screen.getByRole("button"));
    setSource("second");
    setSource("first");
    done();
    await Promise.resolve();
    expect(action.copied()).toBe(false);
    expect(action.pending()).toBe(false);
  });

  it("cleans up success timers and ignores completion after unmount", async () => {
    vi.useFakeTimers();
    let done!: () => void;
    clipboard(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    let action!: ReturnType<typeof createClipboard>;
    const view = render(() => {
      action = createClipboard(() => "value");
      return <></>;
    });
    const promise = action.copy("value");
    done();
    await promise;
    expect(action.copied()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(await action.copy("value")).toBeUndefined();

    let late!: ReturnType<typeof createClipboard>;
    const laterView = render(() => {
      late = createClipboard(() => "other");
      return <></>;
    });
    const pending = late.copy("other");
    laterView.unmount();
    done();
    await pending;
    expect(late.copied()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles unavailable clipboard access and can retry", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    let action!: ReturnType<typeof createClipboard>;
    render(() => {
      action = createClipboard(() => "value");
      return <></>;
    });
    await action.copy("value");
    expect(action.error()).toMatch(/manually/);
    expect(action.pending()).toBe(false);
    clipboard(async () => {});
    await action.copy("value");
    expect(action.copied()).toBe(true);
    expect(action.error()).toBeNull();
  });
});

it("shared buttons preserve disabled semantics and replace their icon while pending", async () => {
  const [pending, setPending] = createSignal(false);
  const click = vi.fn();
  render(() => (
    <Button pending={pending()} icon="save" onClick={click}>
      Save
    </Button>
  ));
  const button = screen.getByRole("button", { name: "Save" });
  expect(button.querySelectorAll("svg")).toHaveLength(1);
  setPending(true);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button.querySelectorAll("svg")).toHaveLength(1);
  fireEvent.click(button);
  expect(click).not.toHaveBeenCalled();
  setPending(false);
  await waitFor(() => expect(button).toBeEnabled());
  expect(button).not.toHaveAttribute("aria-busy", "true");
  fireEvent.click(button);
  expect(click).toHaveBeenCalledTimes(1);
});
