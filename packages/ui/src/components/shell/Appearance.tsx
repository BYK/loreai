import type { Component } from "solid-js";
import { For } from "solid-js";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { Icon, type IconName } from "./Icon";
import { THEME_CHOICES, theme, type ThemeChoice } from "~/lib/theme";

const THEME_OPTIONS: Record<ThemeChoice, { icon: IconName; label: string }> = {
  system: { icon: "monitor", label: "System" },
  light: { icon: "sun", label: "Light" },
  dark: { icon: "moon", label: "Dark" },
};

/**
 * Segmented System / Light / Dark control. `System` (the default) follows the
 * OS preference live; the other two force a mode and persist it.
 */
export const ThemeToggle: Component<{
  class?: string;
  compact?: boolean;
  touch?: boolean;
}> = (props) => {
  const t = theme();
  return (
    <div
      role="group"
      aria-label="Colour theme"
      data-testid="theme-toggle"
      data-theme-choice={t.choice()}
      class={cn(
        "inline-flex items-center gap-0.5 rounded-md",
        !props.compact && "bg-soft p-0.5",
        props.class,
      )}
    >
      <For each={THEME_CHOICES}>
        {(choice) => (
          <Button
            variant="ghost"
            size="sm"
            class={cn(
              "text-muted aria-pressed:text-text",
              props.compact
                ? cn(
                    "px-0 aria-pressed:bg-soft",
                    props.touch ? "size-11" : "size-8",
                  )
                : "h-7 px-2 aria-pressed:bg-surface",
            )}
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
            <Icon name={THEME_OPTIONS[choice].icon} class="size-3.5" />
            <span class={props.compact ? "sr-only" : undefined}>
              {THEME_OPTIONS[choice].label}
            </span>
          </Button>
        )}
      </For>
    </div>
  );
};
