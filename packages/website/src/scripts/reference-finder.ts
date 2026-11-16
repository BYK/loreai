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
  const more = finder.querySelector<HTMLButtonElement>("[data-finder-more]");
  const recovery = finder.querySelector<HTMLElement>("[data-finder-recovery]");
  let expanded = false;
  const status = finder.querySelector<HTMLElement>("[data-finder-status]");
  if (!search || !field || !clear || !results || !directory || !status || !more)
    continue;
  const items = [...results.querySelectorAll<HTMLElement>("[data-search]")];
  function filter() {
    if (!search || !clear || !results || !directory || !status || !more) return;
    const query = search.value.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    // Prefer setting names to incidental matches in explanatory prose.
    const rank = (item: HTMLElement) => {
      const name =
        item.querySelector("a")?.textContent?.trim().toLowerCase() ?? "";
      return name === query
        ? 0
        : name.startsWith(query)
          ? 1
          : name.includes(query)
            ? 2
            : 3;
    };
    const ordered = items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index);
    let count = 0;
    for (const { item } of ordered) {
      results.append(item);
      const text = (item.dataset.search ?? "").toLowerCase();
      const match =
        words.length > 0 && words.every((word) => text.includes(word));
      if (match) count++;
      item.hidden = !match || (!expanded && count > 6);
    }
    more.hidden = !query || count <= 6;
    more.textContent = expanded
      ? "Show fewer results"
      : `Show all ${count} results`;
    more.setAttribute("aria-expanded", String(expanded));
    more.setAttribute("aria-controls", "setting-results");
    results.hidden = !query || count === 0;
    directory.hidden = Boolean(query);
    if (recovery) recovery.hidden = !query || count > 0;
    clear.hidden = !search.value;
    status.textContent = !query
      ? ""
      : count
        ? `${count} matching ${count === 1 ? "setting" : "settings"}${count > 6 && !expanded ? "; showing the first 6" : ""}.`
        : "No settings match. Try a field name or category.";
  }
  function restore() {
    if (!search) return;
    expanded = false;
    search.value = (
      new URL(location.href).searchParams.get("setting") ?? ""
    ).slice(0, 160);
    filter();
  }
  function update() {
    if (!search) return;
    expanded = false;
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
  more.addEventListener("click", () => {
    expanded = !expanded;
    filter();
  });
  clear.addEventListener("click", () => {
    search.value = "";
    update();
    search.focus();
  });
  for (const button of finder.querySelectorAll<HTMLButtonElement>(
    "[data-finder-suggestion], [data-finder-reset]",
  )) {
    button.addEventListener("click", () => {
      search.value = button.dataset.finderSuggestion ?? "";
      update();
      search.focus();
    });
  }
  window.addEventListener("popstate", restore);
}

// Apply the same safe copy behavior to result cards, full field records and examples.
for (const actions of document.querySelectorAll<HTMLElement>(
  "[data-reference-copy]",
)) {
  const statusElement = actions.querySelector<HTMLElement>('[role="status"]');
  const fallbackElement = actions.querySelector<HTMLTextAreaElement>(
    ".reference-copy-fallback",
  );
  if (!statusElement || !fallbackElement) continue;
  const status = statusElement;
  const fallback = fallbackElement;
  let latest = 0;
  actions.hidden = false;
  for (const button of actions.querySelectorAll<HTMLButtonElement>(
    "[data-copy-kind]",
  )) {
    button.addEventListener("click", () => {
      void copy();
      async function copy() {
        const request = ++latest;
        let value = actions.dataset.copyValue ?? "";
        if (button.dataset.copyKind === "link") {
          // Share the actual field with the deployment prefix, without the filter query.
          const url = new URL(location.href);
          url.search = "";
          url.hash = actions.dataset.copySlug ?? "";
          value = url.href;
        }
        if (!value) return;
        fallback.hidden = true;
        status.textContent = "Copying…";
        try {
          await navigator.clipboard.writeText(value);
          if (request !== latest) return;
          status.textContent =
            button.dataset.copyKind === "link"
              ? "Setting link copied."
              : "Copied.";
        } catch {
          if (request !== latest) return;
          fallback.value = value;
          fallback.hidden = false;
          status.textContent =
            "Clipboard unavailable. Select and copy the value below.";
          // A delayed denial must not steal focus after the user moves on.
          if (
            document.activeElement === button &&
            actions.getClientRects().length
          ) {
            fallback.focus();
            fallback.select();
          }
        }
      }
    });
  }
}
