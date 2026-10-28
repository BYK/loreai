// Enhance native disclosures without making navigation depend on JavaScript.
const menus = Array.from(document.querySelectorAll("details[data-menu]"));
function close(menu, restoreFocus = false) {
  if (!menu.open) return;
  menu.open = false;
  if (restoreFocus) menu.querySelector("summary")?.focus();
}
menus.forEach((menu) => {
  menu.addEventListener("toggle", () => {
    if (menu.open)
      menus.forEach((other) => {
        if (other !== menu) close(other);
      });
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      event.preventDefault();
      event.stopPropagation();
      close(menu, true);
    }
  });
  menu
    .querySelectorAll("a")
    .forEach((link) => link.addEventListener("click", () => close(menu, true)));
});
document.addEventListener("click", (event) => {
  menus.forEach((menu) => {
    if (!menu.contains(event.target))
      close(menu, menu.contains(document.activeElement));
  });
});
