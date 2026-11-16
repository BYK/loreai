// Native hrefs and disclosure remain the reading navigation without JavaScript.
const outline = document.querySelector<HTMLDetailsElement>(".article-outline");
if (outline) {
  outline.dataset.enhanced = "true";
  const links = [
    ...outline.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'),
  ];
  const sections = links.flatMap((link) => {
    const id = decodeURIComponent(link.hash.slice(1));
    const heading = document.getElementById(id);
    return heading ? [{ link, heading }] : [];
  });
  const label = outline.querySelector<HTMLElement>(".article-current");
  let scheduled = false;
  function update() {
    scheduled = false;
    const top =
      (outline?.querySelector("summary")?.getBoundingClientRect().bottom ??
        140) + 32;
    let current = sections[0];
    for (const section of sections) {
      if (section.heading.getBoundingClientRect().top <= top) current = section;
      else break;
    }
    for (const section of sections) {
      if (section === current)
        section.link.setAttribute("aria-current", "location");
      else section.link.removeAttribute("aria-current");
    }
    if (label && current) label.textContent = current.link.textContent;
  }
  function queue() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(update);
    }
  }
  outline.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    // Let the browser update URL/history and perform the native anchor jump.
    outline.open = false;
    queue();
    requestAnimationFrame(() => {
      const heading = sections.find(
        (section) => section.link === link,
      )?.heading;
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    });
  });
  document.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  window.addEventListener("hashchange", queue);
  window.addEventListener("load", queue);
  update();
}
