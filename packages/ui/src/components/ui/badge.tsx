// Copied from Solid UI (MIT) — see ATTRIBUTION.md in this directory.
import type { Component, ComponentProps } from "solid-js";
import { splitProps } from "solid-js";

import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-1.75 py-0.5 text-[11px] font-medium leading-normal transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-line text-muted",
        teal: "border-thread bg-soft text-accent",
        gold: "border-mark-edge/60 bg-mark text-gold",
        danger: "border-danger/40 bg-danger-soft text-danger",
      },
    },
    defaultVariants: {
      variant: "outline",
    },
  },
);

type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    round?: boolean;
  };

const Badge: Component<BadgeProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "variant", "round"]);
  return (
    <span
      class={cn(
        badgeVariants({ variant: local.variant }),
        local.round && "rounded-full",
        local.class,
      )}
      {...others}
    />
  );
};

export type { BadgeProps };
export { Badge, badgeVariants };
