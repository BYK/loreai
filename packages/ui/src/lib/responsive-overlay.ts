import { createSignal, onCleanup } from "solid-js";

/** Keep mobile sheets and their desktop counterparts aligned with the shell. */
export function createResponsiveOverlay(
  trigger: () => HTMLElement | undefined,
) {
  const media = window.matchMedia?.("(min-width: 48rem)");
  const [mobile, setMobile] = createSignal(media ? !media.matches : false);
  const [open, setOpen] = createSignal(false);
  const focusTrigger = () => {
    const element = trigger();
    if (element?.isConnected && element.getClientRects().length)
      element.focus({ preventScroll: true });
    else
      document
        .querySelector<HTMLElement>('[data-testid="context-toggle"]')
        ?.focus({ preventScroll: true });
  };
  const changeLayout = () => {
    const wasOpen = open();
    const triggerFocused = trigger()?.contains(document.activeElement);
    setOpen(false);
    setMobile(media ? !media.matches : false);
    if (wasOpen || triggerFocused) queueMicrotask(focusTrigger);
  };
  media?.addEventListener("change", changeLayout);
  onCleanup(() => media?.removeEventListener("change", changeLayout));
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    queueMicrotask(focusTrigger);
  };
  return { mobile, open, setOpen, restoreFocus };
}
