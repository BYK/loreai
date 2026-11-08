// A local directory filter; the reference document and its anchors never change.
for (const finder of document.querySelectorAll<HTMLElement>(
  ".reference-finder",
)) {
  const search = finder.querySelector<HTMLInputElement>(
    'input[name="setting"]',
  );
  const field = finder.querySelector<HTMLElement>("[data-finder-search]");
  const clear = finder.querySelector<HTMLButtonElement>("[data-finder-clear]");
  const results = finder.querySelector<HTMLElement>("[data-finder-results]");
  const directory = finder.querySelector<HTMLElement>(".reference-directory");
  const status = finder.querySelector<HTMLElement>("[data-finder-status]");
  if (!search || !field || !clear || !results || !directory || !status)
    continue;
  const items = [...results.querySelectorAll<HTMLElement>("[data-search]")];
  function filter() {
    if (!search || !clear || !results || !directory || !status) return;
    const query = search.value.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    let count = 0;
    for (const item of items) {
      const text = (item.dataset.search ?? "").toLowerCase();
      const match =
        words.length > 0 && words.every((word) => text.includes(word));
      item.hidden = !match;
      if (match) count++;
    }
    results.hidden = !query || count === 0;
    directory.hidden = Boolean(query);
    clear.hidden = !search.value;
    status.textContent = !query
      ? ""
      : count
        ? `${count} matching ${count === 1 ? "setting" : "settings"}.`
        : "No settings match. Try a field name or category.";
  }
  function restore() {
    if (!search) return;
    search.value = (
      new URL(location.href).searchParams.get("setting") ?? ""
    ).slice(0, 160);
    filter();
  }
  function update() {
    if (!search) return;
    const url = new URL(location.href);
    const value = search.value.slice(0, 160);
    if (value) url.searchParams.set("setting", value);
    else url.searchParams.delete("setting");
    try {
      history.replaceState(history.state, "", url);
    } catch {
      /* Filtering does not require URL access. */
    }
    filter();
  }
  restore();
  field.hidden = false;
  search.addEventListener("input", update);
  clear.addEventListener("click", () => {
    search.value = "";
    update();
    search.focus();
  });
  window.addEventListener("popstate", restore);
}
