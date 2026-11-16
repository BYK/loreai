// Enhance the native Pagefind UI; it retains search, keyboard and dialog ownership.
const assistance = document.querySelector<HTMLTemplateElement>(
  "template[data-search-assistance]",
);
if (assistance) {
  for (const search of document.querySelectorAll<HTMLElement>("site-search")) {
    const host = search.querySelector<HTMLElement>("#starlight__search");
    const container = search.querySelector<HTMLElement>(".search-container");
    if (
      !host ||
      !container ||
      container.querySelector("[data-search-recovery]")
    )
      continue;
    const copy = assistance.content.firstElementChild?.cloneNode(true);
    if (!(copy instanceof HTMLElement)) continue;
    const recovery = copy;
    container.append(recovery);
    let emptyMessage = "No results for [SEARCH_TERM]";
    try {
      const translations: unknown = JSON.parse(
        search.dataset.translations ?? "{}",
      );
      if (
        translations &&
        typeof translations === "object" &&
        "zero_results" in translations &&
        typeof translations.zero_results === "string"
      )
        emptyMessage = translations.zero_results;
    } catch {
      /* Native English search remains usable if optional translations are absent. */
    }
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    function sync() {
      const input = search.querySelector<HTMLInputElement>(
        ".pagefind-ui__search-input",
      );
      const query = input?.value ?? "";
      const message =
        host?.querySelector(".pagefind-ui__message")?.textContent ?? "";
      // Compare the complete query, so a previous asynchronous result cannot show
      // recovery for a newer input while native Pagefind is still searching.
      recovery.hidden =
        !query.trim() ||
        normalize(message) !==
          normalize(emptyMessage.replace("[SEARCH_TERM]", query));
    }
    search.addEventListener("input", () => {
      recovery.hidden = true;
    });
    new MutationObserver(sync).observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    for (const button of recovery.querySelectorAll<HTMLButtonElement>(
      "[data-search-suggestion]",
    )) {
      button.addEventListener("click", () => {
        const input = search.querySelector<HTMLInputElement>(
          ".pagefind-ui__search-input",
        );
        if (!input) return;
        recovery.hidden = true;
        input.value = button.dataset.searchSuggestion ?? "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
    }
    sync();
  }
}
