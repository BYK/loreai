import {
  JOURNAL_DEFAULTS,
  JOURNAL_ENTRIES,
  readJournalState,
  type JournalState,
} from "../lib/quest-journal";

const root = document.querySelector<HTMLElement>(".quest-journal");
if (root) {
  const inputs = Array.from(
    root.querySelectorAll<HTMLInputElement>("input[data-journal-choice]"),
  );
  const keys = ["chapter", "entry", "task"] as const;
  const native = new URLSearchParams();
  for (const input of inputs)
    if (input.checked && input.dataset.journalChoice)
      native.set(input.dataset.journalChoice, input.value);
  const nativeState = readJournalState(native);
  let state = readJournalState(
    new URLSearchParams(location.search),
    nativeState,
  );
  let animation: Animation | undefined;
  let pointerSelection = false;
  root.addEventListener("pointerdown", () => {
    pointerSelection = true;
  });
  root.addEventListener("keydown", () => {
    pointerSelection = false;
  });

  function apply() {
    for (const input of inputs) {
      const key = input.dataset.journalChoice as keyof JournalState;
      input.checked = input.value === state[key];
    }
  }
  function writeHistory(replace = false) {
    const url = new URL(location.href);
    for (const key of keys) url.searchParams.set(key, state[key]);
    const destination = `${url.pathname}${url.search}${url.hash}`;
    if (
      destination === `${location.pathname}${location.search}${location.hash}`
    )
      return;
    if (replace) history.replaceState(null, "", destination);
    else history.pushState(null, "", destination);
  }
  function chapterPanel() {
    return Array.from(
      root!.querySelectorAll<HTMLElement>("[data-journal-chapter]"),
    ).find((panel) => panel.dataset.journalChapter === state.chapter);
  }
  function update(event: Event, focus = false) {
    apply();
    writeHistory();
    const panel = chapterPanel();
    if (focus) {
      const heading = panel?.querySelector<HTMLElement>("h3");
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "nearest" });
    }
    animation?.cancel();
    if (
      event instanceof MouseEvent &&
      event.detail > 0 &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      animation = panel?.animate(
        [
          { opacity: 0.6, transform: "translateY(4px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 180, easing: "cubic-bezier(.23,1,.32,1)" },
      );
    const status = root!.querySelector<HTMLElement>("[data-journal-status]");
    const entry = JOURNAL_ENTRIES.find(
      (item) =>
        item.id === (state.chapter === "recall" ? state.task : state.entry),
    );
    if (status)
      status.textContent =
        state.chapter === "conversation"
          ? "Conversation chapter selected."
          : `${state.chapter === "recall" ? "Relevant knowledge" : "Project knowledge"}: ${entry?.title}.`;
  }
  apply();
  // A native choice made before this module loads is already user intent.
  if (keys.some((key) => nativeState[key] !== JOURNAL_DEFAULTS[key]))
    writeHistory(true);
  for (const input of inputs)
    input.addEventListener("change", (event) => {
      if (!input.checked) return;
      const next = new URLSearchParams();
      const key = input.dataset.journalChoice as keyof JournalState;
      next.set(key, input.value);
      state = readJournalState(next, state);
      if (key === "entry") state.chapter = "knowledge";
      if (key === "task") {
        state.chapter = "recall";
        state.entry = state.task;
      }
      update(
        event,
        key === "entry" &&
          pointerSelection &&
          matchMedia("(max-width: 640px)").matches,
      );
    });
  // A checked radio has no change event, but its card still opens the rule.
  for (const input of inputs.filter(
    (input) => input.dataset.journalChoice === "entry",
  ))
    input.addEventListener("click", (event) => {
      if (state.entry !== input.value || state.chapter === "knowledge") return;
      state.chapter = "knowledge";
      update(
        event,
        pointerSelection && matchMedia("(max-width: 640px)").matches,
      );
    });
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-journal-next], [data-journal-inspect]",
  )) {
    button.hidden = false;
    button.addEventListener("click", (event) => {
      if (button.hasAttribute("data-journal-inspect")) {
        state.chapter = "knowledge";
        state.entry = state.task;
      } else if (button.dataset.journalNext === "recall") {
        state.chapter = "recall";
        state.entry = state.task;
      } else state.chapter = "knowledge";
      update(event, true);
    });
  }
  window.addEventListener("popstate", () => {
    state = readJournalState(new URLSearchParams(location.search));
    apply();
    animation?.cancel();
  });
}
