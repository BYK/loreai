import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";
import { A } from "@solidjs/router";

import { Button } from "~/components/ui/button";
import { theme } from "~/lib/theme";

import { Avatar } from "../lore/Avatar";
import { SearchEntry } from "./SearchEntry";

export const ThemeToggle: Component<{ class?: string }> = (props) => {
  const t = theme();
  return (
    <Button
      variant="ghost"
      size="sm"
      class={props.class}
      aria-label={
        t.resolved() === "dark" ? "Switch to light mode" : "Switch to dark mode"
      }
      aria-pressed={t.resolved() === "dark"}
      data-testid="theme-toggle"
      onClick={() => t.toggle()}
    >
      <span aria-hidden="true">{t.resolved() === "dark" ? "☾" : "☀"}</span>
      <span class="hidden sm:inline">
        {t.resolved() === "dark" ? "Dark" : "Light"}
      </span>
    </Button>
  );
};

export const AppBar: Component<{
  /** Mobile-only: rendered left of the logo (a back link). */
  leading?: JSX.Element;
  /** Mobile-only: replaces the logo with the current pane title. */
  mobileTitle?: string;
  /** Mobile-only: opens the navigation pane. */
  onOpenNav?: () => void;
}> = (props) => (
  <header class="flex h-[62px] items-center gap-4 border-b border-line bg-surface px-4 sm:gap-7 sm:px-6">
    <Show when={props.leading}>
      <span class="lg:hidden">{props.leading}</span>
    </Show>
    <A
      href="/"
      class="text-[27px] font-bold tracking-[-1.2px] text-text lg:min-w-[150px]"
      classList={{ "hidden sm:block": Boolean(props.mobileTitle) }}
    >
      Lore
    </A>
    <Show when={props.mobileTitle}>
      <b class="truncate text-[17px] sm:hidden">{props.mobileTitle}</b>
    </Show>
    <SearchEntry />
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
