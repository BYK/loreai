// Native details owns state; only pointer-triggered motion is enhanced.
const accordionItems = document.querySelectorAll<HTMLDetailsElement>(
  "details.ui-accordion-item",
);
for (const item of accordionItems) {
  const trigger = item.querySelector<HTMLElement>(":scope > summary");
  trigger?.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.isPrimary && event.button === 0)
      item.dataset.accordionMotion = "pointer";
  });
}
// A keyboard action can also close a pointer-open sibling through native grouping.
// Clear all pointer motion before the browser handles that action, without owning open state.
document.addEventListener(
  "keydown",
  () => {
    for (const item of accordionItems) delete item.dataset.accordionMotion;
  },
  { capture: true },
);
