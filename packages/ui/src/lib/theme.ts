/**
 * Light/dark theme. Explicit choice is persisted in localStorage; `system`
 * follows `prefers-color-scheme`. Applied as the `.dark` class on <html>,
 * which is what the Tailwind `dark:` variant and the Lore tokens key off.
 */
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "lore.ui.theme";

function readStoredChoice(): ThemeChoice {
  try {
    const raw = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return (
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
  );
}

function createThemeStore() {
  return createRoot(() => {
    const [choice, setChoiceSignal] =
      createSignal<ThemeChoice>(readStoredChoice());
    const [systemDark, setSystemDark] = createSignal(systemPrefersDark());

    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", (event) =>
      setSystemDark(event.matches),
    );

    const resolved = createMemo<ResolvedTheme>(() => {
      const c = choice();
      if (c === "system") return systemDark() ? "dark" : "light";
      return c;
    });

    createEffect(() => {
      const root = globalThis.document?.documentElement;
      if (!root) return;
      root.classList.toggle("dark", resolved() === "dark");
      root.style.colorScheme = resolved();
    });

    function setChoice(next: ThemeChoice): void {
      setChoiceSignal(next);
      try {
        if (next === "system") {
          globalThis.localStorage?.removeItem(THEME_STORAGE_KEY);
        } else {
          globalThis.localStorage?.setItem(THEME_STORAGE_KEY, next);
        }
      } catch {
        // Private mode / storage disabled: theme is still applied in-memory.
      }
    }

    function toggle(): void {
      setChoice(resolved() === "dark" ? "light" : "dark");
    }

    return { choice, resolved, setChoice, toggle };
  });
}

export type ThemeStore = ReturnType<typeof createThemeStore>;

let store: ThemeStore | null = null;

export function theme(): ThemeStore {
  store ??= createThemeStore();
  return store;
}

/** Test hook: discard the singleton so each test starts from storage. */
export function resetThemeStoreForTests(): void {
  store = null;
}
