import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { A } from "@solidjs/router";

import { Button } from "~/components/ui/button";
import { THEME_CHOICES, theme, type ThemeChoice } from "~/lib/theme";

import { Avatar } from "../lore/Avatar";
import { Logo } from "./Logo";
import { SearchEntry } from "./SearchEntry";

const THEME_OPTIONS: Record<ThemeChoice, { icon: string; label: string }> = {
  system: { icon: "◐", label: "System" },
  light: { icon: "☀", label: "Light" },
  dark: { icon: "☾", label: "Dark" },
};

/**
 * Segmented System / Light / Dark control. `System` (the default) follows the
 * OS preference live; the other two force a mode and persist it.
 */
export const ThemeToggle: Component<{ class?: string }> = (props) => {
  const t = theme();
  return (
    <div
      role="group"
      aria-label="Colour theme"
      data-testid="theme-toggle"
      data-theme-choice={t.choice()}
      class={`inline-flex items-center rounded-md border border-line bg-chrome p-0.5 ${props.class ?? ""}`}
    >
      <For each={THEME_CHOICES}>
        {(choice) => (
          <Button
            variant="ghost"
            size="sm"
            class="h-7 px-2 aria-pressed:bg-surface aria-pressed:text-heading aria-pressed:shadow-sm"
            aria-label={`${THEME_OPTIONS[choice].label} theme`}
            aria-pressed={t.choice() === choice}
            title={
              choice === "system"
                ? `Follow the system setting (currently ${t.resolved()})`
                : `Always use ${choice} mode`
            }
            data-testid={`theme-${choice}`}
            onClick={() => t.setChoice(choice)}
          >
            <span aria-hidden="true">{THEME_OPTIONS[choice].icon}</span>
            <span class="hidden md:inline">{THEME_OPTIONS[choice].label}</span>
          </Button>
        )}
      </For>
    </div>
  );
};

export const AppBar: Component<{
  /** Mobile-only: rendered left of the logo (a back link). */
  leading?: JSX.Element;
  /** Mobile-only: opens the navigation pane. */
  onOpenNav?: () => void;
  searchProjectId?: string;
}> = (props) => (
  <header class="flex h-[62px] items-center gap-4 border-b border-line bg-surface px-4 sm:gap-7 sm:px-6">
    <Show when={props.leading}>
      <span class="lg:hidden">{props.leading}</span>
    </Show>
    <A href="/" aria-label="Lore.AI — home" class="shrink-0 lg:min-w-[150px]">
      <Logo wordmark="sm" />
    </A>
    <SearchEntry searchProjectId={props.searchProjectId} />
    <div class="ml-auto flex items-center gap-2 sm:gap-4">
      <small class="hidden text-[13px] text-muted md:inline">
        Local workspace
      </small>
      <ThemeToggle />
      <Avatar label="You" class="hidden sm:inline-flex" />
      <Show when={props.onOpenNav}>
        <Button
          variant="outline"
          size="sm"
          class="lg:hidden"
          aria-label="Open navigation"
          data-testid="open-nav"
          onClick={() => props.onOpenNav?.()}
        >
          ☰
        </Button>
      </Show>
    </div>
  </header>
);
