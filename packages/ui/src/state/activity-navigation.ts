export function shouldHandleSpace(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "defaultPrevented"
    | "altKey"
    | "ctrlKey"
    | "metaKey"
    | "shiftKey"
    | "target"
  >,
  activeElement: Element | null = document.activeElement,
  selectedText = window.getSelection()?.toString() ?? "",
): boolean {
  if (
    event.key !== " " ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    selectedText.length > 0
  ) {
    return false;
  }
  const ignored = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    if (target.closest('[role="dialog"]')) return true;
    if (target.closest("[contenteditable]:not([contenteditable='false'])"))
      return true;
    return !!target.closest("input, textarea, select, button");
  };
  return !ignored(event.target) && !ignored(activeElement);
}
