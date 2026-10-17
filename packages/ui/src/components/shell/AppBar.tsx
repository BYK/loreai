import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { A } from "@solidjs/router";

import { Button } from "~/components/ui/button";
import { THEME_CHOICES, theme, type ThemeChoice } from "~/lib/theme";
import { useWorkspace } from "~/routes/workspace";

import { Avatar } from "../lore/Avatar";
import { FolkStatus } from "./FolkStatus";
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
  const nextChoice = () =>
    THEME_CHOICES[
      (THEME_CHOICES.indexOf(t.choice()) + 1) % THEME_CHOICES.length
    ] ?? "system";
  return (
    <div
      data-testid="theme-toggle"
      data-theme-choice={t.choice()}
      class={`inline-flex items-center ${props.class ?? ""}`}
    >
      <div
        role="group"
        aria-label="Colour theme"
        class="hidden items-center rounded-md border border-line bg-chrome p-0.5 min-[760px]:inline-flex"
      >
        <For each={THEME_CHOICES}>
          {(choice) => (
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-text aria-pressed:bg-selected aria-pressed:text-selected-text aria-pressed:shadow-sm"
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
              <span class="hidden md:inline">
                {THEME_OPTIONS[choice].label}
              </span>
            </Button>
          )}
        </For>
      </div>
      <Button
        variant="outline"
        size="sm"
        class="h-7 w-8 px-1 min-[760px]:hidden"
        aria-label={`Theme: ${THEME_OPTIONS[t.choice()].label}; next ${THEME_OPTIONS[nextChoice()].label}`}
        title={`Theme: ${THEME_OPTIONS[t.choice()].label}; next ${THEME_OPTIONS[nextChoice()].label}`}
        data-testid="theme-cycle"
        onClick={() => t.setChoice(nextChoice())}
      >
        <span aria-hidden="true">{THEME_OPTIONS[t.choice()].icon}</span>
      </Button>
    </div>
  );
};

export const AppBar: Component<{
  /** Mobile-only: rendered left of the logo (a back link). */
  leading?: JSX.Element;
  /** Minimized pane controls. */
  chips?: JSX.Element;
  /** Mobile-only: opens the navigation pane. */
  onOpenNav?: () => void;
  searchProjectId?: string;
}> = (props) => {
  const ws = useWorkspace();
  const account = () => {
    const folk = ws.state.folk;
    const current = folk.account.data();
    return ws.connection.state() === "reachable" &&
      !folk.account.error() &&
      !folk.account.loading() &&
      current?.signed_in &&
      current.state === "signed_in"
      ? current.user
      : null;
  };
  return (
    <header class="flex h-12 flex-none items-center gap-2 border-b border-line bg-surface px-3 sm:gap-4 sm:px-4">
      <Show when={props.leading}>
        <span class="min-[1100px]:hidden">{props.leading}</span>
      </Show>
      <A
        href="/"
        aria-label="Lore.AI — home"
        class="shrink-0 min-[1100px]:min-w-[150px]"
      >
        <Logo wordmark="sm" />
      </A>
      <Show when={props.chips}>
        {(chips) => <div class="shrink-0">{chips()}</div>}
      </Show>
      <SearchEntry searchProjectId={props.searchProjectId} />
      <div class="ml-auto flex items-center gap-2">
        <FolkStatus />
        <ThemeToggle />
        <Show when={account()}>
          {(user) => {
            const name = () => user().display_name || user().email || "Account";
            const initials = () =>
              name()
                .split(/\s+/)
                .filter(Boolean)
                .map((part) => part[0])
                .slice(0, 2)
                .join("")
                .toUpperCase();
            return (
              <span
                data-testid="account-avatar"
                role="img"
                aria-label={`Signed in as ${name()}`}
                title={name()}
                class="inline-flex"
              >
                <Avatar label={initials()} />
              </span>
            );
          }}
        </Show>
        <Show when={props.onOpenNav}>
          <Button
            variant="outline"
            size="sm"
            class="min-[760px]:hidden"
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
};
