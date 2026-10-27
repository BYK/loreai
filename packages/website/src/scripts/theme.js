// Shared by every page, including Starlight. Run in the head before paint.
// Reuse Starlight's storage key so existing documentation preferences survive.
(() => {
  const key = "starlight-theme";
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const parse = (value) =>
    value === "light" || value === "dark" ? value : "auto";
  let choice = "auto";
  try {
    choice = parse(window.localStorage.getItem(key));
  } catch {
    // Storage can be disabled. Choices still work for this page.
  }

  function apply() {
    root.dataset.themeChoice = choice;
    root.dataset.theme =
      choice === "auto" ? (media.matches ? "dark" : "light") : choice;
    document.querySelectorAll("[data-theme-current]").forEach((label) => {
      label.textContent =
        choice === "auto" ? "System" : choice === "light" ? "Light" : "Dark";
    });
    document.querySelectorAll("button[data-theme-choice]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.themeChoice === choice),
      );
    });
  }

  apply();
  media.addEventListener("change", () => {
    if (choice === "auto") apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      choice = parse(event.newValue);
      apply();
    }
  });

  function connect() {
    document.querySelectorAll("button[data-theme-choice]").forEach((button) => {
      button.addEventListener("click", () => {
        choice = parse(button.dataset.themeChoice);
        try {
          if (choice === "auto") window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, choice);
        } catch {
          // Preserve the in-memory choice even when persistence is unavailable.
        }
        apply();
        const menu = button.closest("details");
        if (menu) {
          menu.open = false;
          menu.querySelector("summary")?.focus();
        }
      });
    });
    apply();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect, { once: true });
  } else {
    connect();
  }
})();
