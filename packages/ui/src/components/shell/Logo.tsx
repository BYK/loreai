import type { Component } from "solid-js";

import { cn } from "~/lib/utils";
import { theme } from "~/lib/theme";

// Lily mark copied from packages/website/src/assets/logo (dark-green mark for
// cream backgrounds, cream mark for dark backgrounds). Vite emits them as
// hashed assets; the gateway embeds them like every other file in dist/.
import markLight from "~/assets/logo/loreai.svg";
import markDark from "~/assets/logo/loreai-dark.svg";

/**
 * Theme-aware Lore.AI logo — the same mark + serif italic wordmark as the
 * website header (Logo.astro). Which SVG is shown follows the resolved
 * theme, not `prefers-color-scheme`, so an explicit light/dark choice wins.
 */
export const Logo: Component<{
  size?: number;
  wordmark?: boolean | "sm";
  class?: string;
}> = (props) => {
  const t = theme();
  const size = () => props.size ?? 36;
  return (
    <span
      class={cn("inline-flex items-center gap-1.5 leading-none", props.class)}
      data-testid="logo"
      data-logo-theme={t.resolved()}
    >
      <img
        src={t.resolved() === "dark" ? markDark : markLight}
        alt=""
        width={size()}
        height={size()}
        style={{ width: `${size()}px`, height: `${size()}px` }}
        class="block"
      />
      <span
        class="font-serif text-[22px] italic text-heading"
        classList={{
          "sr-only": props.wordmark === false,
          "hidden sm:inline": props.wordmark === "sm",
        }}
      >
        Lore<span class="text-accent">.</span>AI
      </span>
    </span>
  );
};
